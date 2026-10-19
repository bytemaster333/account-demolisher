import { describe, it, expect } from "vitest";
import {
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { hydratePlanTransactions } from "@/lib/plan/hydration";
import { buildPlanTree, type PlanNode } from "@/lib/plan/tree";
import { getRpc } from "@/lib/soroban/rpc-client";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { fetchLedgerClock } from "@/lib/stellar/ledger-clock";
import { fundWithFriendbot } from "../helpers/friendbot";

// live testnet check of the payout trustline a pool exit needs: a SAC transfer
// into an account with no line traps with Error(Contract, #13), and once the
// change_trust hydration builds for an AddExitTrustline node lands, the same
// transfer simulates cleanly, so the line is the one the token pays into.

const horizon = getHorizon(TESTNET);
const server = getRpc(TESTNET);

async function friendbot(pk: string): Promise<void> {
  await fundWithFriendbot(pk);
}

async function submitSoroban(tx: Transaction, kp: Keypair): Promise<void> {
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send failed: ${JSON.stringify(sent)}`);
  const final = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} ended ${final.status}`);
  }
}

async function simulateTransfer(
  issuer: Keypair,
  token: string,
  to: string,
): Promise<rpc.Api.SimulateTransactionResponse> {
  const account = await server.getAccount(issuer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  })
    .addOperation(
      new Contract(token).call(
        "transfer",
        nativeToScVal(issuer.publicKey(), { type: "address" }),
        nativeToScVal(to, { type: "address" }),
        nativeToScVal(10_000_000n, { type: "i128" }),
      ),
    )
    .setTimeout(120)
    .build();
  return server.simulateTransaction(tx);
}

describe("integration: the trustline a pool exit pays into", () => {
  it("lets the asset's SAC pay the account once the hydrated change_trust lands", async () => {
    const issuer = Keypair.random();
    const holder = Keypair.random();
    await Promise.all([issuer, holder].map((kp) => friendbot(kp.publicKey())));
    const asset = new Asset("PAY", issuer.publicKey());
    const token = asset.contractId(TESTNET.passphrase);

    // deploy the asset's SAC, as a pool token would have it
    const issuerAccount = await server.getAccount(issuer.publicKey());
    await submitSoroban(
      new TransactionBuilder(issuerAccount, {
        fee: BASE_FEE,
        networkPassphrase: TESTNET.passphrase,
      })
        .addOperation(Operation.createStellarAssetContract({ asset }))
        .setTimeout(120)
        .build(),
      issuer,
    );

    const before = await simulateTransfer(issuer, token, holder.publicKey());
    expect(rpc.Api.isSimulationError(before)).toBe(true);
    expect(rpc.Api.isSimulationError(before) ? before.error : "").toMatch(/Error\(Contract, #13\)/);

    const node: PlanNode = {
      id: `exit-trustline:${token.toLowerCase()}`,
      kind: "AddExitTrustline",
      dependencies: [],
      status: "pending",
      description: "Add a PAY trustline so the pool can pay it out",
      metadata: {
        kind: "AddExitTrustline",
        code: "PAY",
        issuer: issuer.publicKey(),
        contractId: token,
      },
    };
    const latest = await server.getLatestLedger();
    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), holder.publicKey(), {
      rpc: server,
      horizon,
      network: TESTNET,
      currentLedger: latest.sequence,
      ledgerCloseTime: (await fetchLedgerClock(TESTNET)).closedAt,
      fetchSourceAccount: (pk) => horizon.loadAccount(pk),
    });
    expect(failures).toEqual([]);
    if (node.kind !== "AddExitTrustline" || node.metadata.transaction === undefined) {
      throw new Error("expected the change_trust to be built");
    }
    const tx = node.metadata.transaction;
    tx.sign(holder);
    await horizon.submitTransaction(tx);

    const after = await simulateTransfer(issuer, token, holder.publicKey());
    expect(rpc.Api.isSimulationError(after)).toBe(false);
  });
});
