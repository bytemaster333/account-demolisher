import { describe, it, expect } from "vitest";
import { Horizon, type Transaction } from "@stellar/stellar-sdk";

import { loadPoolAndUser } from "@/lib/adapters/blend/client";
import { buildBlendWithdrawTx } from "@/lib/adapters/blend/exit";
import { BLEND_MAINNET_POOLS } from "@/lib/adapters/blend/pools";
import { MAINNET } from "@/lib/config/networks";
import { assertSorobanFeeWithinCap } from "@/lib/soroban/fee-cap";

// read-only: a YieldBloxV2 collateral withdraw for a user whose Positions entry
// is archived, built by the app's own builder and simulated against mainnet.
// nothing is signed or submitted.
//
// the wave 2 fee sweep saw every such withdraw trap with Error(WasmVm,
// InvalidAction). the builder then sent i128::MAX, which overflows the bToken
// conversion in reserves whose b_rate is below 1e12 (0.98 and 0.48 on
// 2026-10-07). sized from b_rate, the same withdraws for the same users simulate
// at about 1,060,000 stroops, 1,232 to 1,336 write bytes, 5 read-write entries
// and 2 archived entries restored, well inside the defi-exit class.

// users with an archived YieldBloxV2 Positions entry, collateral and no debt on
// 2026-10-07 (the three the wave 2 sweep sampled)
const USERS = [
  "GC5SYQDFZDWREXPSRBZIPT4NQUJZYGE62DY422IJSVOKQYKKSMYDXRD5",
  "GDAFOKARX4VPZHPDBY5UTIRK32GUGCC7PQJ4SGQYGOEYNV2XSE5TY4KE",
];

function archivedEntries(tx: Transaction): number {
  const env = tx.toEnvelope();
  if (env.type !== "envelopeTypeTx" || env.v1.tx.ext.type !== "sorobanData") return -1;
  const ext = env.v1.tx.ext.sorobanData.ext;
  return ext.type === "resourceExt" ? ext.resourceExt.archivedSorobanEntries.length : 0;
}

describe("integration: YieldBloxV2 archived withdraw (mainnet, read-only)", () => {
  const entry = BLEND_MAINNET_POOLS.find((p) => p.name === "YieldBloxV2");

  it.each(USERS)("builds, restores and fits the defi-exit fee class for %s", async (user) => {
    if (entry === undefined) throw new Error("YieldBloxV2 is not in the mainnet registry");
    const { pool, user: poolUser } = await loadPoolAndUser(MAINNET, entry.pool_id, user);
    const held = [...poolUser.positions.collateral.entries()].find(([, v]) => v > 0n);
    if (held === undefined) {
      throw new Error(`precondition: ${user} holds no YieldBloxV2 collateral now; pick another`);
    }
    const reserve = [...pool.reserves.values()].find((r) => r.config.index === held[0]);
    if (reserve === undefined) throw new Error(`no reserve at index ${held[0]}`);

    const account = await new Horizon.Server(MAINNET.horizon).loadAccount(user);
    const built = await buildBlendWithdrawTx(
      MAINNET,
      { poolId: entry.pool_id, asset: reserve.assetId, bucket: "collateral" },
      user,
      account,
    );
    const tx = built.transaction as Transaction;
    if (archivedEntries(tx) === 0) {
      throw new Error(`precondition: ${user}'s Positions entry is live again; pick another`);
    }
    expect(archivedEntries(tx)).toBeGreaterThan(0);
    // throws SorobanFeeCapError if the exit would not be signable
    const fee = assertSorobanFeeWithinCap(tx, "defi-exit");
    expect(fee.resourceFee).toBeGreaterThan(0n);
  });
});
