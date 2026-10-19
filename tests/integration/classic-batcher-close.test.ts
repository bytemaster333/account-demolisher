import { describe, it, expect, vi } from "vitest";
import {
  Asset,
  BASE_FEE,
  Claimant,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// close-verify is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

import { TESTNET } from "@/lib/config/networks";
import { batchClassicDemolition, closeMarkerPlanned } from "@/lib/plan/classic-batcher";
import { verifyCloseTx } from "@/server/close-verify";
import { AccountNotFoundError, auditAccount } from "@/lib/stellar/account-audit";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { DEFAULT_TX_VALIDITY_SECONDS, fetchLedgerClock } from "@/lib/stellar/ledger-clock";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { pathKey } from "@/lib/types/plan";
import { fundWithFriendbot } from "../helpers/friendbot";

// live testnet run of the batcher's own output, phase by phase the way the
// executor runs it: a claimable balance of an asset the account does not trust
// is collected through a trustline the close opens (H-09), returned to its
// issuer, and the merge transaction carries the close marker that close
// verification counts (M-52).

const server = getHorizon(TESTNET);

async function friendbot(pk: string): Promise<void> {
  await fundWithFriendbot(pk);
}

describe("integration: classic close of an account holding an untrusted claimable balance", () => {
  it("opens the trustline, claims, returns the asset and merges with the marker", async () => {
    const closer = Keypair.random();
    const issuer = Keypair.random();
    const destination = Keypair.random();
    await Promise.all([closer, issuer, destination].map((kp) => friendbot(kp.publicKey())));

    // the issuer leaves 5 PGT claimable by the closing account, which trusts nothing
    const pgt = new Asset("PGT", issuer.publicKey());
    const issuerAccount = await server.loadAccount(issuer.publicKey());
    const create = new TransactionBuilder(issuerAccount, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        Operation.createClaimableBalance({
          asset: pgt,
          amount: "5",
          claimants: [new Claimant(closer.publicKey(), Claimant.predicateUnconditional())],
        }),
      )
      .setTimeout(120)
      .build();
    create.sign(issuer);
    await server.submitTransaction(create);

    const first = await auditAccount(closer.publicKey(), TESTNET);
    expect(first.claimableBalances).toHaveLength(1);
    expect(first.claimableBalances[0]!.issuerAuthRequired).toBe(false);
    const selection = first.claimableBalances.map((cb) => cb.id);
    const pgtKey = pathKey({ kind: "credit", code: "PGT", issuer: issuer.publicKey() });

    let mergeHash: string | null = null;
    const kindsPerPhase: string[][] = [];
    for (let phase = 0; phase < 4 && mergeHash === null; phase++) {
      const audit = await auditAccount(closer.publicKey(), TESTNET);
      const batches = batchClassicDemolition(audit, {
        destination: destination.publicKey(),
        useMediator: false,
        claimableBalanceIds: selection,
        returnToIssuerAssetKeys: [pgtKey],
        feePerOpStroops: Number(BASE_FEE),
      });
      const batch = batches[0]!;
      kindsPerPhase.push(batch.operations.map((o) => o.kind));
      if (batches.length === 1) expect(closeMarkerPlanned(batches)).toBe(true);
      const account = await server.loadAccount(closer.publicKey());
      const clock = await fetchLedgerClock(TESTNET);
      const built = buildClassicTransaction(
        batch,
        account,
        TESTNET,
        Number(BASE_FEE),
        DEFAULT_TX_VALIDITY_SECONDS,
        clock.closedAt,
      );
      built.transaction.sign(closer);
      const result = await server.submitTransaction(built.transaction);
      if (batch.operations.some((o) => o.kind === "account_merge")) mergeHash = result.hash;
    }

    expect(kindsPerPhase).toEqual([
      ["change_trust_add", "claim_claimable_balance"],
      [
        "return_residue_to_issuer",
        "change_trust_remove",
        "close_marker",
        "close_marker",
        "account_merge",
      ],
    ]);
    await expect(auditAccount(closer.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
    const verified = await verifyCloseTx(TESTNET, mergeHash!);
    expect(verified.ok).toBe(true);
  });
});
