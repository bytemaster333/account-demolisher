import { describe, it, expect } from "vitest";

import { MAINNET } from "@/lib/config/networks";
import { ExitPayoutTooLargeError, hydratePlanTransactions } from "@/lib/plan/hydration";
import { buildPlanTree, type PlanNode } from "@/lib/plan/tree";
import { getRpc } from "@/lib/soroban/rpc-client";
import { balance } from "@/lib/soroban/sep41";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { fetchLedgerClock } from "@/lib/stellar/ledger-clock";

// read-only mainnet check: this holder's share of the KALE/KALIEN soroswap pair
// pays out more KALIEN than an i64 can hold, so the zero-floor probe traps in
// the KALIEN SAC. hydration must turn the host error into the explained refusal.
// nothing is signed or submitted.

const KALE = "CB23WRDQWGSP6YPMY4UV5C4OW5CBTXKYN3XEATG7KJEZCXMJBYEHOUOV";
const KALIEN = "CB4YK5LZG2EGRHJOS4WNX7AAFP3RR3RS5YJUC6D52V2HDT7EQO2QDF6T";
const PAIR = "CCWX3RMBJIHSUBRZ22TMYHVGMSLUK6OMDYCV35JSQD76HZ2BCD36RSLL";
const HOLDER = "GD2GA2JF6OJURU36COZQWJLPEJ7XC3GB25TBD7U4ALCGKOG27262RICH";

describe("hydration on mainnet state, an exit paying more than a trustline holds", () => {
  it("refuses the KALIEN pair withdraw with the payout explained", async () => {
    const server = getRpc(MAINNET);
    const horizon = getHorizon(MAINNET);
    const shares = await balance(server, PAIR, HOLDER, HOLDER, MAINNET);
    // the holder may have exited since; then there is nothing left to check
    expect(shares).toBeGreaterThan(0n);
    const node: PlanNode = {
      id: "lp",
      kind: "WithdrawSoroswapLp",
      dependencies: [],
      description: "withdraw",
      status: "pending",
      metadata: { kind: "WithdrawSoroswapLp", tokenA: KALE, tokenB: KALIEN, shareBalance: shares },
    };
    const latest = await server.getLatestLedger();
    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), HOLDER, {
      rpc: server,
      horizon,
      network: MAINNET,
      currentLedger: latest.sequence,
      ledgerCloseTime: (await fetchLedgerClock(MAINNET)).closedAt,
      fetchSourceAccount: (pk) => horizon.loadAccount(pk),
    });
    expect(failures).toHaveLength(1);
    const err = failures[0]!.error;
    expect(err).toBeInstanceOf(ExitPayoutTooLargeError);
    expect((err as ExitPayoutTooLargeError).token).toBe(KALIEN);
    expect((err as ExitPayoutTooLargeError).amount).toBeGreaterThan(9_223_372_036_854_775_807n);
    expect(node.error).toMatch(/more than a Stellar trustline can hold/);
    expect(node.error).not.toMatch(/HostError|Event log/);
  });
});
