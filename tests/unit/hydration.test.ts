import { describe, it, expect, vi } from "vitest";

import { hydratePlanTransactions } from "@/lib/plan/hydration";
import type { HydrationAdapterOverrides, HydrationDeps } from "@/lib/plan/hydration";
import { buildPlanTree } from "@/lib/plan/tree";
import type { PlanNode } from "@/lib/plan/tree";
import { i128 as scvI128, vec as scvVec } from "@/lib/soroban/scval";
import { applySlippageMin, DEFAULT_SLIPPAGE_BPS } from "@/lib/safety/slippage";
import type { NetworkConfig } from "@/lib/config/networks";

// The Soroswap/Aquarius DeFi-exit hydration must NOT sign a withdraw that
// accepts any (incl. near-zero) output. hydratePlanTransactions builds+simulates
// the withdraw with zero floors to read the router's expected per-token output,
// then rebuilds with a slippage-bounded minimum. These tests lock in that the
// second (real) build receives a positive, slippage-derived floor rather than 0.

const NETWORK = {
  id: "mainnet",
  passphrase: "Public Global Stellar Network ; September 2015",
} as unknown as NetworkConfig;

// a fake source account object; hydration only passes it through to adapters
const SOURCE_ACCOUNT = { accountId: () => "GUSER" } as never;

// build a simulateTransaction mock whose retval is an ScVal vec of the given
// integer amounts, so readExpectedAmounts derives its floors from these.
function rpcReturning(amounts: bigint[]): HydrationDeps["rpc"] {
  const retval = scvVec(amounts.map((a) => scvI128(a)));
  return {
    simulateTransaction: vi.fn(async () => ({
      // not a simulation error, carries a result.retval
      latestLedger: 1,
      minResourceFee: "100",
      transactionData: {},
      result: { retval, auth: [] },
    })),
  } as unknown as HydrationDeps["rpc"];
}

function baseDeps(overrides: Partial<HydrationDeps>): HydrationDeps {
  return {
    rpc: rpcReturning([1n]),
    horizon: {} as never,
    network: NETWORK,
    currentLedger: 100,
    fetchSourceAccount: vi.fn(async () => SOURCE_ACCOUNT),
    ...overrides,
  } as HydrationDeps;
}

describe("hydratePlanTransactions — WithdrawSoroswapLp slippage floor", () => {
  it("passes a positive slippage-derived amountAMin/amountBMin, never 0", async () => {
    const expectedA = 5_000_000n; // 0.5 XLM
    const expectedB = 8_000_000n;

    const calls: { amountAMin: string; amountBMin: string }[] = [];
    const removeLiquidityByContractIds = vi.fn(
      async (args: { amountAMin: string; amountBMin: string }) => {
        calls.push({ amountAMin: args.amountAMin, amountBMin: args.amountBMin });
        return { fake: "tx" };
      },
    ) as unknown as NonNullable<HydrationAdapterOverrides["removeLiquidityByContractIds"]>;

    const node: PlanNode = {
      id: "lp1",
      kind: "WithdrawSoroswapLp",
      dependencies: [],
      description: "withdraw soroswap lp",
      status: "pending",
      metadata: {
        kind: "WithdrawSoroswapLp",
        tokenA: "CTOKENA",
        tokenB: "CTOKENB",
        shareBalance: 1_000_000n,
      },
    };

    const deps = baseDeps({
      rpc: rpcReturning([expectedA, expectedB]),
      adapters: { removeLiquidityByContractIds },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), "GUSER", deps);

    expect(failures).toEqual([]);
    // two builds: the zero-floor probe, then the real slippage-bounded build
    expect(calls.length).toBe(2);
    // probe uses 0 (only to read expected output)
    expect(calls[0]).toEqual({ amountAMin: "0", amountBMin: "0" });
    // real build must carry a POSITIVE, slippage-derived floor (the bug set 0)
    const wantA = applySlippageMin(expectedA.toString(), DEFAULT_SLIPPAGE_BPS);
    const wantB = applySlippageMin(expectedB.toString(), DEFAULT_SLIPPAGE_BPS);
    expect(calls[1]).toEqual({ amountAMin: wantA, amountBMin: wantB });
    expect(BigInt(calls[1]!.amountAMin)).toBeGreaterThan(0n);
    expect(BigInt(calls[1]!.amountBMin)).toBeGreaterThan(0n);
  });

  it("fails the node (does not sign a zero-floor withdraw) when the quote cannot be read", async () => {
    const removeLiquidityByContractIds = vi.fn(
      async () => ({ fake: "tx" }),
    ) as unknown as NonNullable<HydrationAdapterOverrides["removeLiquidityByContractIds"]>;
    const node: PlanNode = {
      id: "lp2",
      kind: "WithdrawSoroswapLp",
      dependencies: [],
      description: "withdraw soroswap lp",
      status: "pending",
      metadata: {
        kind: "WithdrawSoroswapLp",
        tokenA: "CTOKENA",
        tokenB: "CTOKENB",
        shareBalance: 1_000_000n,
      },
    };

    // simulation returns an error -> cannot derive a floor -> node must fail
    const rpc = {
      simulateTransaction: vi.fn(async () => ({
        error: "boom",
        events: [],
        latestLedger: 1,
      })),
    } as unknown as HydrationDeps["rpc"];

    const deps = baseDeps({ rpc, adapters: { removeLiquidityByContractIds } });
    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), "GUSER", deps);

    expect(failures.length).toBe(1);
    expect(failures[0]!.reason).toMatch(/slippage floor/);
  });
});

describe("hydratePlanTransactions — WithdrawAquarius slippage floor", () => {
  it("passes positive slippage-derived minAmounts per token, never all-zero", async () => {
    const expected = [3_000_000n, 7_000_000n];

    const calls: { minAmounts: readonly bigint[] }[] = [];
    const aquariusWithdraw = vi.fn(async (args: { minAmounts: readonly bigint[] }) => {
      calls.push({ minAmounts: args.minAmounts });
      return { fake: "tx" };
    }) as unknown as NonNullable<HydrationAdapterOverrides["aquariusWithdraw"]>;

    const node: PlanNode = {
      id: "aq1",
      kind: "WithdrawAquarius",
      dependencies: [],
      description: "withdraw aquarius",
      status: "pending",
      metadata: {
        kind: "WithdrawAquarius",
        // 32-byte hex pool index
        poolIndex: "ab".repeat(32),
        shareAmount: 1_000_000n,
        tokens: ["CTOKENA", "CTOKENB"],
      },
    };

    const deps = baseDeps({
      rpc: rpcReturning(expected),
      adapters: { aquariusWithdraw },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), "GUSER", deps);

    expect(failures).toEqual([]);
    expect(calls.length).toBe(2);
    // probe: all zero
    expect(calls[0]!.minAmounts.map(String)).toEqual(["0", "0"]);
    // real build: positive slippage-derived floors (the bug set 0n for all)
    const want = expected.map((e) => BigInt(applySlippageMin(e.toString(), DEFAULT_SLIPPAGE_BPS)));
    expect(calls[1]!.minAmounts).toEqual(want);
    for (const m of calls[1]!.minAmounts) expect(m).toBeGreaterThan(0n);
  });
});
