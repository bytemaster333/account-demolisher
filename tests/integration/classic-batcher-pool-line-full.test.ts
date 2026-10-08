import { describe, it, expect } from "vitest";
import {
  Asset,
  BASE_FEE,
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

// live testnet run of the batcher's own output: a pool withdraw whose payout
// alone overflows a custom trustline limit. core fails it with
// LIQUIDITY_POOL_WITHDRAW_LINE_FULL unless the line is raised ahead of it.

const server = getHorizon(TESTNET);

async function friendbot(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
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

describe("integration: a pool withdraw that overflows a custom trustline limit", () => {
  it("raises the line ahead of the withdraw and closes", async () => {
    const issuer = Keypair.random();
    const holder = Keypair.random();
    const destination = Keypair.random();
    await Promise.all([issuer, holder, destination].map((kp) => friendbot(kp.publicKey())));
    const cap = new Asset("CAP", issuer.publicKey());
    const poolAsset = new LiquidityPoolAsset(Asset.native(), cap, LiquidityPoolFeeV18);
    const poolId = Buffer.from(
      getLiquidityPoolId("constant_product", poolAsset.getLiquidityPoolParameters()),
    ).toString("hex");
    // 30 CAP go into the pool, then the line is topped up to 95 of its 100 limit,
    // so the 30 the withdraw pays back can't fit
    await submitAs(holder, [Operation.changeTrust({ asset: cap, limit: "100" })]);
    await submitAs(issuer, [
      Operation.payment({ destination: holder.publicKey(), asset: cap, amount: "30" }),
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
    await submitAs(issuer, [
      Operation.payment({ destination: holder.publicKey(), asset: cap, amount: "95" }),
    ]);

    const first = await auditAccount(holder.publicKey(), TESTNET);
    expect(first.balances.find((b) => b.asset.kind === "credit")).toMatchObject({
      amount: "95.0000000",
      limit: "100.0000000",
    });
    const capKey = pathKey({ kind: "credit", code: "CAP", issuer: issuer.publicKey() });

    let merged = false;
    const kindsPerPhase: string[][] = [];
    for (let phase = 0; phase < 4 && !merged; phase++) {
      const audit = await auditAccount(holder.publicKey(), TESTNET);
      // CAP has no market, so it goes back to its issuer
      const batches = batchClassicDemolition(audit, {
        destination: destination.publicKey(),
        useMediator: false,
        returnToIssuerAssetKeys: [capKey],
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

    expect(kindsPerPhase[0]).toEqual(["change_trust_add", "liquidity_pool_withdraw"]);
    expect(merged).toBe(true);
    await expect(auditAccount(holder.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });
});
