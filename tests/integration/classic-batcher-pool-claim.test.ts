import { describe, it, expect } from "vitest";
import {
  Asset,
  BASE_FEE,
  Claimant,
  getLiquidityPoolId,
  Keypair,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { AccountNotFoundError, auditAccount } from "@/lib/stellar/account-audit";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { DEFAULT_TX_VALIDITY_SECONDS, fetchLedgerClock } from "@/lib/stellar/ledger-clock";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { pathKey } from "@/lib/types/plan";
import { fundWithFriendbot } from "../helpers/friendbot";

// live testnet run of the batcher's own output (H-12): the leading phase
// withdraws a pool share and claims a balance of the same asset in one
// transaction. the withdraw fills the trustline first, so a claim that fit the
// audited room alone fails with op_line_full unless the line is raised first.

const server = getHorizon(TESTNET);

async function friendbot(pk: string): Promise<void> {
  await fundWithFriendbot(pk);
}

async function submitAs(kp: Keypair, ops: readonly xdr.Operation[]): Promise<void> {
  const account = await server.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(120).build();
  tx.sign(kp);
  await server.submitTransaction(tx, { skipMemoRequiredCheck: true });
}

describe("integration: a pool withdraw and a claim of the same asset on a custom limit", () => {
  it("raises the line the withdraw fills, claims, and closes", async () => {
    const issuer = Keypair.random();
    const holder = Keypair.random();
    const destination = Keypair.random();
    await Promise.all([issuer, holder, destination].map((kp) => friendbot(kp.publicKey())));
    const cap = new Asset("CAP", issuer.publicKey());
    const poolAsset = new LiquidityPoolAsset(Asset.native(), cap, LiquidityPoolFeeV18);
    const poolId = Buffer.from(
      getLiquidityPoolId("constant_product", poolAsset.getLiquidityPoolParameters()),
    ).toString("hex");
    // 40 CAP on a 100 limit, 30 more in the pool, and a 50 CAP claimable balance:
    // the 50 fits the audited 60 of room but not the 30 the withdraw leaves
    await submitAs(holder, [Operation.changeTrust({ asset: cap, limit: "100" })]);
    await submitAs(issuer, [
      Operation.payment({ destination: holder.publicKey(), asset: cap, amount: "70" }),
      Operation.createClaimableBalance({
        asset: cap,
        amount: "50",
        claimants: [new Claimant(holder.publicKey(), Claimant.predicateUnconditional())],
      }),
    ]);
    await submitAs(holder, [
      Operation.changeTrust({ asset: poolAsset }),
      Operation.liquidityPoolDeposit({
        liquidityPoolId: poolId,
        maxAmountA: "30",
        maxAmountB: "30",
        minPrice: "0.9",
        maxPrice: "1.1",
      }),
    ]);

    const first = await auditAccount(holder.publicKey(), TESTNET);
    expect(first.balances.find((b) => b.asset.kind === "credit")).toMatchObject({
      amount: "40.0000000",
      limit: "100.0000000",
    });
    const selection = first.claimableBalances.map((cb) => cb.id);
    expect(selection).toHaveLength(1);
    const capKey = pathKey({ kind: "credit", code: "CAP", issuer: issuer.publicKey() });

    let merged = false;
    const kindsPerPhase: string[][] = [];
    for (let phase = 0; phase < 4 && !merged; phase++) {
      const audit = await auditAccount(holder.publicKey(), TESTNET);
      const batches = batchClassicDemolition(audit, {
        destination: destination.publicKey(),
        useMediator: false,
        claimableBalanceIds: selection,
        // CAP has no market. with no disposal chosen yet the claim goes into the
        // leading phase beside the withdraw; afterwards it is returned to its issuer
        ...(phase === 0 ? {} : { returnToIssuerAssetKeys: [capKey] }),
        feePerOpStroops: Number(BASE_FEE),
      });
      const batch = batches[0]!;
      kindsPerPhase.push(batch.operations.map((o) => o.kind));
      const account = await server.loadAccount(holder.publicKey());
      const clock = await fetchLedgerClock(TESTNET);
      const built = buildClassicTransaction(
        batch,
        account,
        TESTNET,
        Number(BASE_FEE),
        DEFAULT_TX_VALIDITY_SECONDS,
        clock.closedAt,
      );
      built.transaction.sign(holder);
      await server.submitTransaction(built.transaction);
      merged = batch.operations.some((o) => o.kind === "account_merge");
    }

    // the raise lands between the withdraw and the claim
    expect(kindsPerPhase[0]).toEqual([
      "liquidity_pool_withdraw",
      "change_trust_add",
      "claim_claimable_balance",
    ]);
    expect(merged).toBe(true);
    await expect(auditAccount(holder.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });
});
