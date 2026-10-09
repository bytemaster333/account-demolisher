import { describe, it, expect, vi } from "vitest";
import {
  Asset,
  Horizon,
  Keypair,
  NotFoundError,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  rpc as StellarRpc,
  scValToNative,
  xdr,
  type Operation,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_V1_MAINNET_ID,
} from "@/lib/adapters/blend/constants";
import {
  BackstopClaimUnavailableError,
  BackstopNothingAccruedError,
  BlndTrustlineMissingError,
} from "@/lib/adapters/blend/exit";
import { spendableFromAccount } from "@/lib/adapters/blend/spendable";
import { NoSoroswapRouteError } from "@/lib/adapters/soroswap/swap";
import {
  BackstopEmissionsAlreadyClaimedError,
  BackstopEmissionsClaimError,
  ExitPayoutTooLargeError,
  hydratePlanTransactions,
  PriceImpactRefusedError,
  rebuildSorobanNodeTransaction,
} from "@/lib/plan/hydration";
import type { HydrationAdapterOverrides, HydrationDeps } from "@/lib/plan/hydration";
import { buildPlanTree } from "@/lib/plan/tree";
import type { PlanNode } from "@/lib/plan/tree";
import { i128 as scvI128, vec as scvVec } from "@/lib/soroban/scval";
import { applySlippageMin, DEFAULT_SLIPPAGE_BPS } from "@/lib/safety/slippage";
import { TESTNET, type NetworkConfig } from "@/lib/config/networks";

// The Soroswap/Aquarius DeFi-exit hydration must NOT sign a withdraw that
// accepts any (incl. near-zero) output. hydratePlanTransactions builds+simulates
// the withdraw with zero floors to read the router's expected per-token output,
// then rebuilds with a slippage-bounded minimum. These tests lock in that the
// second (real) build receives a positive, slippage-derived floor rather than 0.

const NETWORK = {
  id: "mainnet",
  passphrase: "Public Global Stellar Network ; September 2015",
} as unknown as NetworkConfig;

const USER = Keypair.random().publicKey();

// a real horizon account record, so sequence handling is the library's own
function accountAt(seq: bigint): Horizon.AccountResponse {
  return new Horizon.AccountResponse({
    id: USER,
    paging_token: USER,
    account_id: USER,
    sequence: seq.toString(),
    subentry_count: 0,
    last_modified_ledger: 1,
    last_modified_time: "2026-01-01T00:00:00Z",
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
    balances: [],
    signers: [{ key: USER, weight: 1, type: "ed25519_public_key" }],
    data_attr: {},
    num_sponsoring: 0,
    num_sponsored: 0,
  } as never);
}

// the same account holding the given XLM, with the given selling liabilities
function withNative(
  account: Horizon.AccountResponse,
  balance: string,
  sellingLiabilities: string,
): Horizon.AccountResponse {
  return new Horizon.AccountResponse({
    ...account,
    account_id: account.accountId(),
    sequence: account.sequenceNumber(),
    balances: [
      {
        asset_type: "native",
        balance,
        buying_liabilities: "0.0000000",
        selling_liabilities: sellingLiabilities,
      },
    ],
  } as never);
}

const SOURCE_ACCOUNT = accountAt(100n);
// the network's clock, far from the test machine's, so a time bound or router
// deadline taken from Date.now() fails
const LEDGER_CLOSE = 1_700_000_000;

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
    ledgerCloseTime: LEDGER_CLOSE,
    fetchSourceAccount: vi.fn(async () => SOURCE_ACCOUNT),
    ...overrides,
  } as HydrationDeps;
}

// the module-level deps, for a describe that wraps baseDeps with its own defaults
const depsWith = (overrides: Partial<HydrationDeps>): HydrationDeps => baseDeps(overrides);

describe("hydratePlanTransactions, WithdrawSoroswapLp slippage floor", () => {
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

    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);

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
    const removeLiquidityByContractIds = vi.fn(async () => ({
      fake: "tx",
    })) as unknown as NonNullable<HydrationAdapterOverrides["removeLiquidityByContractIds"]>;
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
    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);

    expect(failures.length).toBe(1);
    expect(failures[0]!.reason).toMatch(/slippage floor/);
  });
});

describe("hydration, an exit paying more than a trustline can hold", () => {
  const KALE = "CB23WRDQWGSP6YPMY4UV5C4OW5CBTXKYN3XEATG7KJEZCXMJBYEHOUOV";
  const KALIEN = "CB4YK5LZG2EGRHJOS4WNX7AAFP3RR3RS5YJUC6D52V2HDT7EQO2QDF6T";
  const PAIR = "CCWX3RMBJIHSUBRZ22TMYHVGMSLUK6OMDYCV35JSQD76HZ2BCD36RSLL";
  const HOLDER = "GD2GA2JF6OJURU36COZQWJLPEJ7XC3GB25TBD7U4ALCGKOG27262RICH";
  // the simulation error the rpc returned for this mainnet holder's
  // remove_liquidity on 2026-10-08 (read only), trimmed to the lines that matter
  const SIM_ERROR = [
    "HostError: Error(Contract, #12)",
    "",
    "Event log (newest first):",
    `   0: [Diagnostic Event] contract:CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH, topics:[error, Error(Contract, #12)], data:"escalating error to VM trap from failed host function call: call"`,
    `   4: [Failed Diagnostic Event (not emitted)] contract:${PAIR}, topics:[error, Error(Contract, #12)], data:["contract call failed", transfer, [${PAIR}, ${HOLDER}, 40178848124484506634]]`,
    `   5: [Failed Diagnostic Event (not emitted)] contract:${KALIEN}, topics:[error, Error(Contract, #12)], data:"received amount is too large for an i64"`,
    `   6: [Failed Diagnostic Event (not emitted)] contract:${PAIR}, topics:[fn_call, ${KALIEN}, transfer], data:[${PAIR}, ${HOLDER}, 40178848124484506634]`,
  ].join("\n");
  const lpNode = (deps: string[] = []): PlanNode => ({
    id: "lp",
    kind: "WithdrawSoroswapLp",
    dependencies: deps,
    description: "withdraw",
    status: "pending",
    metadata: {
      kind: "WithdrawSoroswapLp",
      tokenA: KALE,
      tokenB: KALIEN,
      shareBalance: 126_491_106_406_734_170n,
    },
  });

  it("explains the refusal instead of showing the host error, and never defers it", async () => {
    const removeLiquidityByContractIds = vi.fn(async () => {
      throw new Error(SIM_ERROR);
    }) as unknown as NonNullable<HydrationAdapterOverrides["removeLiquidityByContractIds"]>;
    const before: PlanNode = {
      id: "before",
      kind: "RevokeAllowance",
      dependencies: [],
      description: "already built",
      status: "pending",
      metadata: {
        kind: "RevokeAllowance",
        contractId: "CTOKEN",
        spender: "CSPENDER",
        transaction: { fake: "tx" } as never,
      },
    };
    const node = lpNode(["before"]);
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([before, node]),
      USER,
      baseDeps({ adapters: { removeLiquidityByContractIds } }),
    );
    expect(failures).toEqual([expect.objectContaining({ nodeId: "lp", deferred: false })]);
    expect(failures[0]!.error).toBeInstanceOf(ExitPayoutTooLargeError);
    expect(failures[0]!.error).toMatchObject({ token: KALIEN, amount: 40178848124484506634n });
    expect(node.status).toBe("failed");
    expect(node.error).toMatch(
      /would pay 4017884812448\.4506634 of token CB4YK5.*more than a Stellar trustline can hold/,
    );
    expect(node.error).not.toMatch(/HostError|Event log/);
  });

  it("leaves any other probe failure as it was", async () => {
    const removeLiquidityByContractIds = vi.fn(async () => {
      throw new Error("HostError: Error(Contract, #13)");
    }) as unknown as NonNullable<HydrationAdapterOverrides["removeLiquidityByContractIds"]>;
    const node = lpNode();
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({ adapters: { removeLiquidityByContractIds } }),
    );
    expect(failures[0]!.error).not.toBeInstanceOf(ExitPayoutTooLargeError);
    expect(node.error).toBe("HostError: Error(Contract, #13)");
  });
});

describe("hydratePlanTransactions, WithdrawAquarius slippage floor", () => {
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

    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);

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

const HELD_TOKEN = StrKey.encodeContract(new Uint8Array(32).fill(3));

// a router stand-in: each probe "tx" carries its amountIn, and simulating it
// answers [amountIn, rate(amountIn)] the way swap_exact_tokens_for_tokens does
const XLM_SAC = Asset.native().contractId(NETWORK.passphrase);

function swapMarket(rate: (amountIn: bigint) => bigint): {
  rpc: HydrationDeps["rpc"];
  buildSwapToXLM: NonNullable<HydrationAdapterOverrides["buildSwapToXLM"]>;
  quoteRouteToXLM: NonNullable<HydrationAdapterOverrides["quoteRouteToXLM"]>;
  calls: { amountIn: string; amountOutMin: string; path?: readonly string[] | undefined }[];
} {
  const calls: { amountIn: string; amountOutMin: string; path?: readonly string[] | undefined }[] =
    [];
  const buildSwapToXLM = vi.fn(
    async (args: {
      amountIn: string;
      amountOutMin: string;
      path?: readonly string[] | undefined;
    }) => {
      calls.push({ amountIn: args.amountIn, amountOutMin: args.amountOutMin, path: args.path });
      return { amountIn: BigInt(args.amountIn) };
    },
  ) as unknown as NonNullable<HydrationAdapterOverrides["buildSwapToXLM"]>;
  // the direct pair is the route
  const quoteRouteToXLM = vi.fn(async () => ({
    path: [HELD_TOKEN, XLM_SAC],
    amounts: [],
  })) as unknown as NonNullable<HydrationAdapterOverrides["quoteRouteToXLM"]>;
  const rpc = {
    simulateTransaction: vi.fn(async (tx: { amountIn: bigint }) => ({
      latestLedger: 1,
      minResourceFee: "100",
      transactionData: {},
      result: { retval: scvVec([scvI128(tx.amountIn), scvI128(rate(tx.amountIn))]), auth: [] },
    })),
  } as unknown as HydrationDeps["rpc"];
  return { rpc, buildSwapToXLM, quoteRouteToXLM, calls };
}

function convertNode(over: { priceImpactAccepted?: boolean; deps?: string[] } = {}): PlanNode {
  return {
    id: "cv1",
    kind: "ConvertSorobanToXLM",
    dependencies: over.deps ?? [],
    description: "convert held token to xlm",
    status: "pending",
    metadata: {
      kind: "ConvertSorobanToXLM",
      asset: { kind: "contract", contractId: HELD_TOKEN },
      amount: 1_000_000n,
      ...(over.priceImpactAccepted ? { priceImpactAccepted: true } : {}),
    },
  };
}

describe("hydratePlanTransactions, ConvertSorobanToXLM (Soroswap-router swap) floor", () => {
  it("passes a positive slippage-derived amountOutMin, never 0", async () => {
    const market = swapMarket((x) => x * 4n);
    const deps = baseDeps({
      rpc: market.rpc,
      adapters: {
        buildSwapToXLM: market.buildSwapToXLM,
        quoteRouteToXLM: market.quoteRouteToXLM,
        readTokenBalance: async () => 1_000_000n,
      },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([convertNode()]), USER, deps);

    expect(failures).toEqual([]);
    // the full-size probe, the reference probe, then the signed swap
    expect(market.calls.map((c) => c.amountOutMin)).toEqual([
      "0",
      "0",
      applySlippageMin("4000000", DEFAULT_SLIPPAGE_BPS),
    ]);
    expect(BigInt(market.calls[2]!.amountOutMin)).toBeGreaterThan(0n);
  });

  it("refuses to build (value-destroying) when the router quotes zero XLM out", async () => {
    const market = swapMarket(() => 0n);
    const deps = baseDeps({
      rpc: market.rpc,
      adapters: {
        buildSwapToXLM: market.buildSwapToXLM,
        quoteRouteToXLM: market.quoteRouteToXLM,
        readTokenBalance: async () => 1_000_000n,
      },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([convertNode()]), USER, deps);

    expect(failures.length).toBe(1);
    expect(failures[0]!.reason).toMatch(/zero XLM out/);
  });
});

// M-19: the whole held balance goes through one pair; a thin pair can return a
// fraction of its value, so the full-size rate is checked against a 1/1000 trade
describe("hydratePlanTransactions, ConvertSorobanToXLM price-impact cap", () => {
  // constant product pool, 1:1 spot with 1_000_000 of each side
  const thinPool = (x: bigint): bigint => (x * 1_000_000n) / (1_000_000n + x);

  it("refuses a swap far over the 2% cap and signs nothing", async () => {
    const market = swapMarket(thinPool);
    const node = convertNode();
    const deps = baseDeps({
      rpc: market.rpc,
      adapters: {
        buildSwapToXLM: market.buildSwapToXLM,
        quoteRouteToXLM: market.quoteRouteToXLM,
        readTokenBalance: async () => 1_000_000n,
      },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(/price impact, over the 2\.00% cap/);
    expect(market.calls.every((c) => c.amountOutMin === "0")).toBe(true);
    expect((node.metadata as { transaction?: unknown }).transaction).toBeUndefined();
  });

  it("builds the swap after an explicit confirmation and records the quote", async () => {
    const market = swapMarket(thinPool);
    const node = convertNode({ priceImpactAccepted: true });
    const deps = baseDeps({
      rpc: market.rpc,
      adapters: {
        buildSwapToXLM: market.buildSwapToXLM,
        quoteRouteToXLM: market.quoteRouteToXLM,
        readTokenBalance: async () => 1_000_000n,
      },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);

    expect(failures).toEqual([]);
    const md = node.metadata as {
      quote?: { expectedOut: bigint; minOut: bigint; priceImpactBps: number | null };
    };
    expect(md.quote?.expectedOut).toBe(500_000n);
    expect(md.quote?.priceImpactBps).toBe(4995);
  });

  it("refuses a swap whose reference trade can't be priced", async () => {
    // tiny reference trades round down to zero output
    const market = swapMarket((x) => (x < 10_000n ? 0n : x));
    const deps = baseDeps({
      rpc: market.rpc,
      adapters: {
        buildSwapToXLM: market.buildSwapToXLM,
        quoteRouteToXLM: market.quoteRouteToXLM,
        readTokenBalance: async () => 1_000_000n,
      },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([convertNode()]), USER, deps);

    expect(failures[0]!.reason).toMatch(/can't price a reference trade/);
  });

  // the refusal is a price the user has to confirm, not state an earlier step
  // changes, so a swap queued behind the exits must not read as "built later"
  it("fails an over-cap swap that runs after other steps instead of deferring it", async () => {
    const market = swapMarket(thinPool);
    const node = convertNode({ deps: ["exit"] });
    const exit: PlanNode = {
      id: "exit",
      kind: "TransferAsIs",
      dependencies: [],
      description: "already built",
      status: "pending",
      metadata: {
        kind: "TransferAsIs",
        asset: { kind: "contract", contractId: HELD_TOKEN },
        amount: 1n,
        destination: USER,
        transaction: { fake: "tx" } as never,
      },
    };
    const deps = baseDeps({
      rpc: market.rpc,
      adapters: {
        buildSwapToXLM: market.buildSwapToXLM,
        quoteRouteToXLM: market.quoteRouteToXLM,
        readTokenBalance: async () => 1_000_000n,
      },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([exit, node]), USER, deps);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.deferred).toBe(false);
    expect(node.status).toBe("failed");
    expect(node.error).toMatch(/over the 2\.00% cap/);
    expect(node.deferred).toBeUndefined();
  });
});

// M-24: sweeps run after the exits and move the balance that is there by then
describe("hydratePlanTransactions, held-token sweeps use the live balance", () => {
  function transferNode(deps: string[] = []): PlanNode {
    return {
      id: "drain",
      kind: "TransferAsIs",
      dependencies: deps,
      description: "send held token",
      status: "pending",
      metadata: {
        kind: "TransferAsIs",
        asset: { kind: "contract", contractId: HELD_TOKEN },
        amount: 500n,
        destination: USER,
      },
    };
  }

  it("transfers the balance read at build time, not the discovered amount", async () => {
    const amounts: bigint[] = [];
    const clocks: unknown[] = [];
    const buildTransfer = vi.fn(async (...args: unknown[]) => {
      amounts.push(args[4] as bigint);
      clocks.push(args[7]);
      return { fake: "tx" };
    }) as unknown as NonNullable<HydrationAdapterOverrides["buildTransfer"]>;
    const node = transferNode();
    const deps = baseDeps({ adapters: { buildTransfer, readTokenBalance: async () => 900n } });

    await rebuildSorobanNodeTransaction(node, USER, deps);

    expect(amounts).toEqual([900n]);
    expect(clocks).toEqual([LEDGER_CLOSE]);
    expect((node.metadata as { amount: bigint }).amount).toBe(900n);
  });

  it("swaps the balance read at build time, not the discovered amount", async () => {
    // discovery saw 1,000,000; the account holds 1,500,000 when the swap is built
    const market = swapMarket((x) => x * 4n);
    const quoteRouteToXLM = vi.fn(market.quoteRouteToXLM);
    const deps = baseDeps({
      rpc: market.rpc,
      adapters: {
        buildSwapToXLM: market.buildSwapToXLM,
        quoteRouteToXLM,
        readTokenBalance: async () => 1_500_000n,
      },
    });
    const node = convertNode();

    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);

    expect(failures).toEqual([]);
    expect(quoteRouteToXLM.mock.calls[0]![1].amountIn).toBe(1_500_000n);
    // the full-size probe, the 1/1000 reference probe, then the signed swap
    expect(market.calls.map((c) => c.amountIn)).toEqual(["1500000", "1500", "1500000"]);
    expect(market.calls[2]!.amountOutMin).toBe(applySlippageMin("6000000", DEFAULT_SLIPPAGE_BPS));
    const md = node.metadata as { amount: bigint; quote?: { amountIn: bigint } };
    expect(md.amount).toBe(1_500_000n);
    expect(md.quote?.amountIn).toBe(1_500_000n);
  });

  it("fails a sweep with nothing to move", async () => {
    const node = transferNode();
    const deps = baseDeps({
      adapters: {
        buildTransfer: vi.fn() as never,
        readTokenBalance: async () => 0n,
      },
    });
    await expect(rebuildSorobanNodeTransaction(node, USER, deps)).rejects.toThrow(
      /holds none of token/,
    );
  });
});

// H-18: preview simulates every step against today's state. A step that runs
// after others (a collateral withdraw behind its repay) fails there for a reason
// that its dependencies remove, so it is deferred, not failed.
describe("hydratePlanTransactions, steps behind other steps are deferred", () => {
  function blendNode(id: string, kind: "RepayBlend" | "WithdrawBlend", deps: string[]): PlanNode {
    return kind === "RepayBlend"
      ? {
          id,
          kind,
          dependencies: deps,
          description: id,
          status: "pending",
          metadata: { kind, poolId: "CPOOL", asset: "CASSET", amount: 10n },
        }
      : {
          id,
          kind,
          dependencies: deps,
          description: id,
          status: "pending",
          metadata: { kind, poolId: "CPOOL", asset: "CASSET", bucket: "collateral" },
        };
  }

  it("keeps a dependent node pending with the reason, and fails a root node", async () => {
    const buildExitSequence = vi.fn(async () => {
      throw new Error("Error(Contract, #1205)");
    }) as unknown as NonNullable<HydrationAdapterOverrides["buildExitSequence"]>;
    const repay = blendNode("repay", "RepayBlend", []);
    const withdraw = blendNode("withdraw", "WithdrawBlend", ["repay"]);
    const deps = baseDeps({ adapters: { buildExitSequence } });

    const { failures } = await hydratePlanTransactions(
      buildPlanTree([repay, withdraw]),
      USER,
      deps,
    );

    const plain = {
      priceImpactRefused: false,
      noSoroswapRoute: false,
      backstopClaimUnavailable: false,
      error: expect.any(Error),
    };
    expect(failures).toEqual([
      { nodeId: "repay", reason: "Error(Contract, #1205)", deferred: false, ...plain },
      { nodeId: "withdraw", reason: "Error(Contract, #1205)", deferred: true, ...plain },
    ]);
    expect(repay.status).toBe("failed");
    expect(withdraw.status).toBe("pending");
    expect(withdraw.error).toBeUndefined();
    expect(withdraw.deferred).toEqual({ after: ["repay"], reason: "Error(Contract, #1205)" });
  });

  it("clears the deferral once the step builds", async () => {
    const steps = [{ kind: "withdraw_collateral", asset: "CASSET", transaction: { fake: "tx" } }];
    const buildExitSequence = vi.fn(async () => steps) as unknown as NonNullable<
      HydrationAdapterOverrides["buildExitSequence"]
    >;
    const withdraw = blendNode("withdraw", "WithdrawBlend", ["repay"]);
    withdraw.deferred = { after: ["repay"], reason: "earlier failure" };

    await rebuildSorobanNodeTransaction(
      withdraw,
      USER,
      baseDeps({ adapters: { buildExitSequence } }),
    );

    expect(withdraw.deferred).toBeUndefined();
    expect((withdraw.metadata as { transaction?: unknown }).transaction).toEqual({ fake: "tx" });
  });
});

describe("hydratePlanTransactions, Blend emissions claim", () => {
  it("refuses a claim with no reserve ids instead of guessing reserve 0", async () => {
    const buildExitSequence = vi.fn() as unknown as NonNullable<
      HydrationAdapterOverrides["buildExitSequence"]
    >;
    const node: PlanNode = {
      id: "claim",
      kind: "ClaimBlendEmissions",
      dependencies: [],
      description: "claim",
      status: "pending",
      metadata: { kind: "ClaimBlendEmissions", poolId: "CPOOL", reserveTokenIds: [] },
    };
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({ adapters: { buildExitSequence } }),
    );
    expect(failures[0]!.reason).toMatch(/no reserve token ids/);
    expect(buildExitSequence).not.toHaveBeenCalled();
  });
});

// C-05: the two-pass builders (probe, then the real build) used to share one
// AccountResponse. TransactionBuilder.build() bumps the source sequence in place,
// so the signed tx carried seq+2 and every submit failed tx_bad_seq. These run
// the real adapters against a real AccountResponse and a real rpc.Server; only
// the raw json-rpc simulate call is answered locally.
describe("hydration, two-pass builds sign at on-chain sequence + 1", () => {
  const ONCHAIN_SEQ = 21407199335022592n;
  const tokenA = StrKey.encodeContract(new Uint8Array(32).fill(7));
  const tokenB = StrKey.encodeContract(new Uint8Array(32).fill(9));

  function rpcAnswering(retval: ReturnType<typeof scvVec>): StellarRpc.Server {
    const server = new StellarRpc.Server(TESTNET.rpc);
    vi.spyOn(server, "_simulateTransaction").mockImplementation(async () => ({
      id: "1",
      latestLedger: 1,
      minResourceFee: "100",
      transactionData: new SorobanDataBuilder().build().toXdr("base64"),
      results: [{ auth: [], xdr: retval.toXdr("base64") }],
    }));
    return server;
  }

  const cases: { name: string; node: () => PlanNode; retval: ReturnType<typeof scvVec> }[] = [
    {
      name: "WithdrawAquarius",
      node: () => ({
        id: "aq",
        kind: "WithdrawAquarius",
        dependencies: [],
        description: "withdraw aquarius",
        status: "pending",
        metadata: {
          kind: "WithdrawAquarius",
          poolIndex: "ab".repeat(32),
          shareAmount: 1_000_000n,
          tokens: [tokenA, tokenB],
        },
      }),
      retval: scvVec([
        nativeToScVal(3_000_000n, { type: "u128" }),
        nativeToScVal(7_000_000n, { type: "u128" }),
      ]),
    },
    {
      name: "WithdrawSoroswapLp",
      node: () => ({
        id: "lp",
        kind: "WithdrawSoroswapLp",
        dependencies: [],
        description: "withdraw soroswap lp",
        status: "pending",
        metadata: {
          kind: "WithdrawSoroswapLp",
          tokenA,
          tokenB,
          shareBalance: 1_000_000n,
        },
      }),
      retval: scvVec([scvI128(5_000_000n), scvI128(8_000_000n)]),
    },
    {
      name: "ConvertSorobanToXLM",
      node: () => ({
        id: "cv",
        kind: "ConvertSorobanToXLM",
        dependencies: [],
        description: "convert held token",
        status: "pending",
        metadata: {
          kind: "ConvertSorobanToXLM",
          asset: { kind: "contract", contractId: tokenA },
          amount: 1_000_000n,
        },
      }),
      retval: scvVec([scvI128(1_000_000n), scvI128(4_000_000n)]),
    },
  ];

  function deps(retval: ReturnType<typeof scvVec>): HydrationDeps {
    return {
      rpc: rpcAnswering(retval),
      horizon: {} as never,
      network: TESTNET,
      currentLedger: 100,
      ledgerCloseTime: LEDGER_CLOSE,
      fetchSourceAccount: async () => accountAt(ONCHAIN_SEQ),
      // the held-token swap reads the live balance and searches a route first;
      // answer both directly
      adapters: {
        readTokenBalance: async () => 1_000_000n,
        quoteRouteToXLM: async () => ({
          path: [tokenA, Asset.native().contractId(TESTNET.passphrase)],
          amounts: [],
        }),
      },
    };
  }

  function signedSequence(node: PlanNode): string | undefined {
    return (node.metadata as { transaction?: { sequence: string } }).transaction?.sequence;
  }

  for (const c of cases) {
    it(`${c.name}: preview hydration builds the signed tx at seq + 1`, async () => {
      const node = c.node();
      const { failures } = await hydratePlanTransactions(
        buildPlanTree([node]),
        USER,
        deps(c.retval),
      );
      expect(failures).toEqual([]);
      expect(signedSequence(node)).toBe((ONCHAIN_SEQ + 1n).toString());
    });

    it(`${c.name}: execute-time rebuild signs at seq + 1`, async () => {
      const node = c.node();
      await rebuildSorobanNodeTransaction(node, USER, deps(c.retval));
      expect(signedSequence(node)).toBe((ONCHAIN_SEQ + 1n).toString());
    });

    it(`${c.name}: times the tx and any router deadline from the ledger close time`, async () => {
      const node = c.node();
      await rebuildSorobanNodeTransaction(node, USER, deps(c.retval));
      const tx = (node.metadata as { transaction?: Transaction }).transaction!;
      expect(Number(tx.timeBounds?.minTime)).toBe(0);
      expect(Number(tx.timeBounds?.maxTime)).toBe(LEDGER_CLOSE + 300);
      const op = tx.operations[0] as Operation.InvokeHostFunction;
      const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
      const fn = call.functionName.toString();
      // soroswap's router checks its deadline argument against the ledger timestamp
      const deadlineAt = { remove_liquidity: 6, swap_exact_tokens_for_tokens: 4 }[fn];
      if (deadlineAt !== undefined) {
        expect(scValToNative(call.args[deadlineAt]!)).toBe(BigInt(LEDGER_CLOSE + 300));
      }
    });
  }

  it("refuses to hydrate without a usable ledger close time", async () => {
    const node = cases[0]!.node();
    await expect(
      hydratePlanTransactions(buildPlanTree([node]), USER, {
        ...deps(cases[0]!.retval),
        ledgerCloseTime: Number.NaN,
      }),
    ).rejects.toThrow(/ledgerCloseTime/);
    await expect(
      rebuildSorobanNodeTransaction(node, USER, { ...deps(cases[0]!.retval), ledgerCloseTime: 0 }),
    ).rejects.toThrow(/ledgerCloseTime/);
  });
});

// the blend builders read the source account's balances, subentries and
// sponsorship counts; each build must get the whole record at the loaded sequence
describe("hydration, every build gets a full copy of the account record", () => {
  const XLM = Asset.native().contractId(NETWORK.passphrase);

  function fundedAccount(seq: bigint): Horizon.AccountResponse {
    return new Horizon.AccountResponse({
      id: USER,
      paging_token: USER,
      account_id: USER,
      sequence: seq.toString(),
      subentry_count: 2,
      last_modified_ledger: 1,
      last_modified_time: "2026-01-01T00:00:00Z",
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: {
        auth_required: false,
        auth_revocable: false,
        auth_immutable: false,
        auth_clawback_enabled: false,
      },
      balances: [
        {
          asset_type: "native",
          balance: "100.0000000",
          buying_liabilities: "0.0000000",
          selling_liabilities: "1.0000000",
        },
      ],
      signers: [{ key: USER, weight: 1, type: "ed25519_public_key" }],
      data_attr: {},
      num_sponsoring: 0,
      num_sponsored: 0,
    } as never);
  }

  it("lets a repay size itself from the account's spendable XLM and records the amount", async () => {
    const seen: { spendable: bigint | null; sequence: string }[] = [];
    const buildExitSequence = vi.fn(
      async (_net: unknown, _pos: unknown, _user: unknown, account: Horizon.AccountResponse) => {
        // the real helper the repay builder runs on the account it is handed
        const line = spendableFromAccount(account, XLM, NETWORK);
        seen.push({ spendable: line?.spendable ?? null, sequence: account.sequenceNumber() });
        return [{ kind: "repay", asset: XLM, amount: 42n, transaction: { fake: "tx" } }];
      },
    ) as unknown as NonNullable<HydrationAdapterOverrides["buildExitSequence"]>;
    const node: PlanNode = {
      id: "repay",
      kind: "RepayBlend",
      dependencies: [],
      description: "repay",
      status: "pending",
      metadata: { kind: "RepayBlend", poolId: "CPOOL", asset: XLM, amount: 10n },
    };
    const deps = baseDeps({
      fetchSourceAccount: vi.fn(async () => fundedAccount(500n)),
      adapters: { buildExitSequence },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);

    expect(failures).toEqual([]);
    // 100 XLM - 1 XLM selling liabilities - (2 + 2 subentries) x 0.5 XLM
    expect(seen).toEqual([{ spendable: 970_000_000n, sequence: "500" }]);
    expect((node.metadata as { amount: bigint }).amount).toBe(42n);
  });
});

describe("hydration, Blend backstop steps take their amounts from the built transaction", () => {
  const V2 = { id: BLEND_BACKSTOP_MAINNET_ID, version: "V2" as const, queueDurationSeconds: 1 };
  const V1 = { id: BLEND_BACKSTOP_V1_MAINNET_ID, version: "V1" as const, queueDurationSeconds: 1 };
  const backstopNode = (
    kind: "BackstopQueue" | "BackstopWithdraw",
    backstopId?: string,
  ): PlanNode =>
    kind === "BackstopQueue"
      ? {
          id: "queue",
          kind,
          dependencies: [],
          description: "queue",
          status: "pending",
          metadata: {
            kind,
            poolId: "CPOOL",
            shares: 10n,
            queueEndsAt: new Date(0),
            ...(backstopId !== undefined ? { backstopId } : {}),
          },
        }
      : {
          id: "withdraw",
          kind,
          dependencies: [],
          description: "withdraw",
          status: "pending",
          metadata: {
            kind,
            poolId: "CPOOL",
            amount: 10n,
            lpToken: "CCOMET",
            ...(backstopId !== undefined ? { backstopId } : {}),
          },
        };
  const claimNode = (deps: string[] = [], backstopId?: string): PlanNode => ({
    id: "claim",
    kind: "ClaimBackstopEmissions",
    dependencies: deps,
    description: "claim",
    status: "pending",
    metadata: {
      kind: "ClaimBackstopEmissions",
      poolId: "CPOOL",
      accruedEmissions: 7n,
      ...(backstopId !== undefined ? { backstopId } : {}),
    },
  });

  it("records the shares, unlock date and backstop the queue transaction carries", async () => {
    const ends = new Date(1_800_000_000_000);
    const buildBackstopQueueTx = vi.fn(async () => ({
      transaction: { fake: "tx" } as unknown as Transaction,
      shares: 15n,
      backstop: V2,
      queueEndsAt: ends,
    }));
    const node = backstopNode("BackstopQueue");
    await rebuildSorobanNodeTransaction(
      node,
      USER,
      baseDeps({ adapters: { buildBackstopQueueTx } }),
    );
    expect(node.metadata).toMatchObject({ shares: 15n, queueEndsAt: ends, backstopId: V2.id });
  });

  it("withdraws the unlocked queue and records the amount and backstop read on chain", async () => {
    const buildBackstopWithdrawTx = vi.fn(async () => ({
      transaction: { fake: "tx" } as unknown as Transaction,
      shares: 12n,
      backstop: V1,
    }));
    const node = backstopNode("BackstopWithdraw");
    await rebuildSorobanNodeTransaction(
      node,
      USER,
      baseDeps({ adapters: { buildBackstopWithdrawTx } }),
    );
    expect(buildBackstopWithdrawTx).toHaveBeenCalledWith(
      NETWORK,
      { poolId: "CPOOL" },
      USER,
      expect.anything(),
      expect.objectContaining({ server: expect.anything() }),
    );
    expect(node.metadata).toMatchObject({ amount: 12n, backstopId: V1.id });
  });

  it("refuses a build against a different backstop than the one the plan names", async () => {
    const buildBackstopQueueTx = vi.fn(async () => ({
      transaction: { fake: "tx" } as unknown as Transaction,
      shares: 15n,
      backstop: V2,
      queueEndsAt: new Date(0),
    }));
    const node = backstopNode("BackstopQueue", V1.id);
    await expect(
      rebuildSorobanNodeTransaction(node, USER, baseDeps({ adapters: { buildBackstopQueueTx } })),
    ).rejects.toThrow(/not the backstop .* the plan named/);
    expect((node.metadata as { transaction?: unknown }).transaction).toBeUndefined();
  });

  it("records the backstop of a claim that builds", async () => {
    const buildBackstopClaimTx = vi.fn(async () => ({
      transaction: { fake: "tx" } as unknown as Transaction,
      backstop: V2,
    }));
    const node = claimNode();
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({ adapters: { buildBackstopClaimTx } }),
    );
    expect(failures).toEqual([]);
    expect(node.metadata).toMatchObject({ backstopId: V2.id });
  });

  it("fails a claim that traps in simulation as a forfeit question, with the accrued BLND, never deferring", async () => {
    const log = "HostError: Error(WasmVm, InvalidAction)\nevent log:\n 0: [Diagnostic Event] ...";
    const buildBackstopClaimTx = vi.fn(async () => {
      throw new BackstopClaimUnavailableError("CPOOL", V2.id, 7_114_578_242n, log);
    });
    const before: PlanNode = {
      id: "before",
      kind: "BackstopWithdraw",
      dependencies: [],
      description: "already built",
      status: "pending",
      metadata: {
        kind: "BackstopWithdraw",
        poolId: "CPOOL",
        amount: 1n,
        lpToken: "CCOMET",
        transaction: { fake: "tx" } as never,
      },
    };
    const claim = claimNode(["before"]);
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([before, claim]),
      USER,
      baseDeps({ adapters: { buildBackstopClaimTx } }),
    );
    expect(failures).toEqual([
      expect.objectContaining({
        nodeId: "claim",
        deferred: false,
        backstopClaimUnavailable: true,
        // read on chain when the claim was simulated, not discovery's 7n
        backstopAccruedEmissions: 7_114_578_242n,
      }),
    ]);
    expect(claim.status).toBe("failed");
    // the amount read on chain, and a one-line reason without the diagnostic log
    expect(claim.error).toMatch(/711\.4578242 BLND/);
    expect(claim.error).toMatch(/forfeit/);
    expect(claim.error).not.toMatch(/InvalidAction|event log/);
    await expect(
      rebuildSorobanNodeTransaction(
        claimNode(),
        USER,
        baseDeps({ adapters: { buildBackstopClaimTx } }),
      ),
    ).rejects.toMatchObject({
      name: "BackstopEmissionsClaimError",
      poolId: "CPOOL",
      backstopId: V2.id,
      accruedEmissions: 7_114_578_242n,
      simulationError: log,
    });
  });

  // a source-account read or an rpc timeout is not a trapping claim: offering a
  // permanent forfeit for it would give the BLND away over a network blip
  it("keeps any other claim failure an ordinary one, not a forfeit question", async () => {
    const buildBackstopClaimTx = vi.fn(async () => {
      throw new Error("timeout of 30000ms exceeded");
    });
    const claim = claimNode();
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([claim]),
      USER,
      baseDeps({ adapters: { buildBackstopClaimTx } }),
    );
    expect(failures).toEqual([
      {
        nodeId: "claim",
        reason: "timeout of 30000ms exceeded",
        deferred: false,
        priceImpactRefused: false,
        noSoroswapRoute: false,
        backstopClaimUnavailable: false,
        error: expect.any(Error),
      },
    ]);
    expect(claim.error).not.toMatch(/forfeit/);
  });

  // what undici throws when the rpc can't be reached, and its plain-Error form
  it.each([
    ["TypeError", new TypeError("fetch failed")],
    ["Error", new Error("fetch failed")],
  ])("never reads an unreachable rpc (%s fetch failed) as a forfeit", async (_name, thrown) => {
    const buildBackstopClaimTx = vi.fn(async () => {
      throw thrown;
    });
    const claim = claimNode();
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([claim]),
      USER,
      baseDeps({ adapters: { buildBackstopClaimTx } }),
    );
    expect(failures).toEqual([
      expect.objectContaining({
        nodeId: "claim",
        reason: "fetch failed",
        backstopClaimUnavailable: false,
        error: thrown,
      }),
    ]);
    const rebuilt = rebuildSorobanNodeTransaction(
      claimNode(),
      USER,
      baseDeps({ adapters: { buildBackstopClaimTx } }),
    );
    await expect(rebuilt).rejects.toBe(thrown);
    await expect(rebuilt).rejects.not.toBeInstanceOf(BackstopEmissionsClaimError);
  });

  // the accrual was claimed elsewhere between discovery and this build: there is
  // nothing to forfeit, and the plan is stale, so the review is run again
  it("fails a claim with nothing left to claim as a stale plan, not a forfeit", async () => {
    const buildBackstopClaimTx = vi.fn(async () => {
      throw new BackstopNothingAccruedError("CPOOL");
    });
    const before: PlanNode = {
      id: "before",
      kind: "BackstopWithdraw",
      dependencies: [],
      description: "already built",
      status: "pending",
      metadata: {
        kind: "BackstopWithdraw",
        poolId: "CPOOL",
        amount: 1n,
        lpToken: "CCOMET",
        transaction: { fake: "tx" } as never,
      },
    };
    const claim = claimNode(["before"]);
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([before, claim]),
      USER,
      baseDeps({ adapters: { buildBackstopClaimTx } }),
    );
    expect(failures).toEqual([
      expect.objectContaining({
        nodeId: "claim",
        deferred: false,
        backstopClaimUnavailable: false,
        error: expect.any(BackstopEmissionsAlreadyClaimedError),
      }),
    ]);
    expect(claim.status).toBe("failed");
    expect(claim.error).toMatch(/claimed since the account was read/);
    expect(claim.error).not.toMatch(/forfeit/);
    await expect(
      rebuildSorobanNodeTransaction(
        claimNode(),
        USER,
        baseDeps({ adapters: { buildBackstopClaimTx } }),
      ),
    ).rejects.toMatchObject({ name: "BackstopEmissionsAlreadyClaimedError", poolId: "CPOOL" });
  });

  // only the builder's typed error means "nothing accrued"; any other failure
  // that happens to carry the same words stays an ordinary failure
  it("does not read a plain error with the same text as nothing left to claim", async () => {
    const thrown = new Error("no accrued backstop emissions to claim for Blend pool CPOOL");
    const buildBackstopClaimTx = vi.fn(async () => {
      throw thrown;
    });
    await expect(
      rebuildSorobanNodeTransaction(
        claimNode(),
        USER,
        baseDeps({ adapters: { buildBackstopClaimTx } }),
      ),
    ).rejects.toBe(thrown);
  });
});

describe("hydration, failures say which user answer they wait on", () => {
  it("carries the refusal kind and the thrown error of a refused conversion", async () => {
    const thinPool = (x: bigint): bigint => (x * 1_000_000n) / (1_000_000n + x);
    const market = swapMarket(thinPool);
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([convertNode()]),
      USER,
      baseDeps({
        rpc: market.rpc,
        adapters: {
          buildSwapToXLM: market.buildSwapToXLM,
          quoteRouteToXLM: market.quoteRouteToXLM,
          readTokenBalance: async () => 1_000_000n,
        },
      }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]!.refusal).toBe("price_impact");
    expect(failures[0]!.error).toBeInstanceOf(PriceImpactRefusedError);

    const noRoute = new NoSoroswapRouteError(HELD_TOKEN, []);
    const routeless = await hydratePlanTransactions(
      buildPlanTree([convertNode()]),
      USER,
      baseDeps({
        adapters: {
          quoteRouteToXLM: async () => {
            throw noRoute;
          },
          readTokenBalance: async () => 1_000_000n,
        },
      }),
    );
    expect(routeless.failures).toEqual([
      expect.objectContaining({ refusal: "no_route", error: noRoute }),
    ]);
  });

  it("sets no refusal kind on a failure that is not a refused conversion", async () => {
    const buildBackstopClaimTx = vi.fn(async () => {
      throw new Error("timeout");
    });
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([
        {
          id: "claim",
          kind: "ClaimBackstopEmissions",
          dependencies: [],
          description: "claim",
          status: "pending",
          metadata: { kind: "ClaimBackstopEmissions", poolId: "CPOOL", accruedEmissions: 7n },
        },
      ]),
      USER,
      baseDeps({ adapters: { buildBackstopClaimTx } }),
    );
    expect(failures).toHaveLength(1);
    expect("refusal" in failures[0]!).toBe(false);
    expect("backstopAccruedEmissions" in failures[0]!).toBe(false);
  });

  it("flags a conversion refused for its price", async () => {
    const thinPool = (x: bigint): bigint => (x * 1_000_000n) / (1_000_000n + x);
    const market = swapMarket(thinPool);
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([convertNode()]),
      USER,
      baseDeps({
        rpc: market.rpc,
        adapters: {
          buildSwapToXLM: market.buildSwapToXLM,
          quoteRouteToXLM: market.quoteRouteToXLM,
          readTokenBalance: async () => 1_000_000n,
        },
      }),
    );
    expect(failures).toEqual([
      expect.objectContaining({
        priceImpactRefused: true,
        noSoroswapRoute: false,
        backstopClaimUnavailable: false,
      }),
    ]);
  });

  it("flags a token with no route to XLM", async () => {
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([convertNode()]),
      USER,
      baseDeps({
        adapters: {
          quoteRouteToXLM: async () => {
            throw new NoSoroswapRouteError(HELD_TOKEN, []);
          },
          readTokenBalance: async () => 1_000_000n,
        },
      }),
    );
    expect(failures).toEqual([
      expect.objectContaining({ priceImpactRefused: false, noSoroswapRoute: true }),
    ]);
  });
});

describe("hydration, the BLND trustline and the emissions claim behind it", () => {
  const BLND_TESTNET_ISSUER = "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56";

  it("builds the change_trust at the on-chain sequence + 1", async () => {
    const node: PlanNode = {
      id: "blnd-trustline",
      kind: "AddBlndTrustline",
      dependencies: [],
      description: "trust BLND",
      status: "pending",
      metadata: { kind: "AddBlndTrustline", code: "BLND", issuer: BLND_TESTNET_ISSUER },
    };
    const deps = baseDeps({
      network: TESTNET,
      fetchSourceAccount: vi.fn(async () => withNative(accountAt(700n), "10.0000000", "0.0000000")),
    });
    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);
    expect(failures).toEqual([]);
    const tx = (node.metadata as { transaction?: Transaction }).transaction!;
    expect(tx.sequence).toBe("701");
    expect(tx.operations.map((o) => o.type)).toEqual(["changeTrust"]);
    // a classic submit: its time bound must come from the ledger, not the browser
    expect(Number(tx.timeBounds?.minTime)).toBe(0);
    expect(Number(tx.timeBounds?.maxTime)).toBe(LEDGER_CLOSE + 300);
  });

  // the change_trust runs ahead of the other steps; an account that can't hold
  // the new line's reserve would fail it on chain (op_low_reserve), so the step
  // fails at build time with the amount to add instead
  it("refuses the change_trust when the account can't fund the line's reserve", async () => {
    const node: PlanNode = {
      id: "blnd-trustline",
      kind: "AddBlndTrustline",
      dependencies: [],
      description: "trust BLND",
      status: "pending",
      metadata: { kind: "AddBlndTrustline", code: "BLND", issuer: BLND_TESTNET_ISSUER },
    };
    // 1.55 XLM on a bare account: 0.55 XLM free, one 0.5 XLM reserve plus the
    // 0.01 XLM fee bid fits, so take a little more off through liabilities
    const tight = withNative(accountAt(700n), "1.5500000", "0.0600000");
    const deps = baseDeps({ network: TESTNET, fetchSourceAccount: vi.fn(async () => tight) });
    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);
    expect(failures).toEqual([expect.objectContaining({ nodeId: "blnd-trustline" })]);
    expect(node.status).toBe("failed");
    expect(node.error).toMatch(/0\.5100000 XLM free.*has 0\.4900000/);
    expect((node.metadata as { transaction?: unknown }).transaction).toBeUndefined();

    const enough = withNative(accountAt(700n), "1.5500000", "0.0400000");
    const ok: PlanNode = { ...node, status: "pending", metadata: { ...node.metadata } };
    delete (ok as { error?: string }).error;
    const passed = await hydratePlanTransactions(
      buildPlanTree([ok]),
      USER,
      baseDeps({ network: TESTNET, fetchSourceAccount: vi.fn(async () => enough) }),
    );
    expect(passed.failures).toEqual([]);
  });

  it("keeps the claim pending until the trustline lands", async () => {
    const buildExitSequence = vi.fn(async () => {
      throw new BlndTrustlineMissingError("CPOOL", "missing", `BLND:${BLND_TESTNET_ISSUER}`);
    }) as unknown as NonNullable<HydrationAdapterOverrides["buildExitSequence"]>;
    const line: PlanNode = {
      id: "blnd-trustline",
      kind: "AddBlndTrustline",
      dependencies: [],
      description: "trust BLND",
      status: "pending",
      metadata: {
        kind: "AddBlndTrustline",
        code: "BLND",
        issuer: BLND_TESTNET_ISSUER,
        transaction: { fake: "tx" } as never,
      },
    };
    const claim: PlanNode = {
      id: "claim",
      kind: "ClaimBlendEmissions",
      dependencies: ["blnd-trustline"],
      description: "claim",
      status: "pending",
      metadata: { kind: "ClaimBlendEmissions", poolId: "CPOOL", reserveTokenIds: [1] },
    };
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([line, claim]),
      USER,
      baseDeps({ network: TESTNET, adapters: { buildExitSequence } }),
    );
    expect(failures).toEqual([
      {
        nodeId: "claim",
        reason: "ClaimBlendEmissions: built after the BLND trustline is added",
        deferred: true,
        priceImpactRefused: false,
        noSoroswapRoute: false,
        backstopClaimUnavailable: false,
        error: expect.any(Error),
      },
    ]);
    expect(claim.status).toBe("pending");
  });
});

describe("hydration, the trustline a pool exit pays into", () => {
  const ISSUER = Keypair.random().publicKey();
  const lineNode = (code: string, over: { contractId?: string } = {}): PlanNode => ({
    id: `line-${code}`,
    kind: "AddExitTrustline",
    dependencies: [],
    description: `trust ${code}`,
    status: "pending",
    metadata: {
      kind: "AddExitTrustline",
      code,
      issuer: ISSUER,
      contractId: over.contractId ?? new Asset(code, ISSUER).contractId(TESTNET.passphrase),
    },
  });
  const txOf = (node: PlanNode): Transaction | undefined =>
    (node.metadata as { transaction?: Transaction }).transaction;
  // the issuer as horizon serves it: a real account record with its flags, or a 404
  const issuerHorizon = (authRequired: boolean | "missing"): HydrationDeps["horizon"] =>
    ({
      loadAccount: vi.fn(async (id: string) => {
        if (authRequired === "missing") throw new NotFoundError("Not Found", { status: 404 });
        const record = accountAt(1n);
        return new Horizon.AccountResponse({
          ...record,
          id,
          account_id: id,
          sequence: "1",
          flags: {
            auth_required: authRequired,
            auth_revocable: authRequired,
            auth_immutable: false,
            auth_clawback_enabled: false,
          },
        } as never);
      }),
    }) as unknown as HydrationDeps["horizon"];
  const baseDeps = (over: Partial<HydrationDeps>): HydrationDeps =>
    depsWith({ horizon: issuerHorizon(false), ...over });

  // core opens a line unauthorized when its issuer has auth_required, and a SAC
  // can't pay into it, so the exit would still trap after the reserve is locked
  it("refuses a line whose issuer requires authorization", async () => {
    const node = lineNode("YBX");
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({
        network: TESTNET,
        horizon: issuerHorizon(true),
        fetchSourceAccount: vi.fn(async () =>
          withNative(accountAt(700n), "10.0000000", "0.0000000"),
        ),
      }),
    );
    expect(failures).toEqual([expect.objectContaining({ nodeId: "line-YBX", deferred: false })]);
    expect(node.status).toBe("failed");
    expect(node.error).toMatch(/issuer of YBX requires authorization/);
    expect(txOf(node)).toBeUndefined();
  });

  // change_trust fails with CHANGE_TRUST_NO_ISSUER when the issuer is gone
  it("refuses a line whose issuer account no longer exists", async () => {
    const node = lineNode("YBX");
    await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({
        network: TESTNET,
        horizon: issuerHorizon("missing"),
        fetchSourceAccount: vi.fn(async () =>
          withNative(accountAt(700n), "10.0000000", "0.0000000"),
        ),
      }),
    );
    expect(node.status).toBe("failed");
    expect(node.error).toMatch(/issuer of YBX .* does not exist/);
    expect(txOf(node)).toBeUndefined();
  });

  it("builds one change_trust for the asset at the default limit, at seq + 1", async () => {
    const node = lineNode("YBX");
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({
        network: TESTNET,
        fetchSourceAccount: vi.fn(async () =>
          withNative(accountAt(700n), "10.0000000", "0.0000000"),
        ),
      }),
    );
    expect(failures).toEqual([]);
    const tx = txOf(node)!;
    expect(tx.source).toBe(USER);
    expect(tx.sequence).toBe("701");
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0]!;
    if (op.type !== "changeTrust") throw new Error("expected changeTrust");
    expect(op.line).toEqual(new Asset("YBX", ISSUER));
    expect(op.limit).toBe("922337203685.4775807");
  });

  it("refuses a node whose asset is not the token the exit pays", async () => {
    const node = lineNode("YBX", {
      contractId: new Asset("GQX", ISSUER).contractId(TESTNET.passphrase),
    });
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({
        network: TESTNET,
        fetchSourceAccount: vi.fn(async () =>
          withNative(accountAt(700n), "10.0000000", "0.0000000"),
        ),
      }),
    );
    expect(failures).toEqual([expect.objectContaining({ nodeId: "line-YBX" })]);
    expect(node.error).toMatch(/YBX:G\w+ is not the asset of token C\w+/);
    expect(txOf(node)).toBeUndefined();
  });

  it("refuses the change_trust when the account can't fund the line's reserve", async () => {
    // 1.5 XLM on a bare account leaves 0.5 free: not the reserve plus the fee
    const node = lineNode("YBX");
    await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({
        network: TESTNET,
        fetchSourceAccount: vi.fn(async () => withNative(accountAt(700n), "1.5000000", "0")),
      }),
    );
    expect(node.status).toBe("failed");
    expect(node.error).toMatch(/opening the YBX trustline needs 0\.5100000 XLM free/);
  });

  // every line built in one pass is checked against the same account read, so
  // each one counts the reserves of the lines built before it
  it("counts the reserves of every line the pass opens", async () => {
    const lines = [lineNode("YBX"), lineNode("GQX")];
    // 1.6 XLM on a bare account: 0.6 free fits one line's 0.51, not two
    const { failures } = await hydratePlanTransactions(
      buildPlanTree(lines),
      USER,
      baseDeps({
        network: TESTNET,
        fetchSourceAccount: vi.fn(async () => withNative(accountAt(700n), "1.6000000", "0")),
      }),
    );
    expect(txOf(lines[0]!)).toBeDefined();
    expect(failures).toEqual([expect.objectContaining({ nodeId: "line-GQX" })]);
    expect(lines[1]!.error).toMatch(/needs 1\.0200000 XLM free/);
  });

  it("rebuilds against the fresh account alone, whose reserves already count landed lines", async () => {
    const node = lineNode("GQX");
    await rebuildSorobanNodeTransaction(
      node,
      USER,
      baseDeps({
        network: TESTNET,
        fetchSourceAccount: vi.fn(async () => withNative(accountAt(700n), "1.6000000", "0")),
      }),
    );
    expect(txOf(node)).toBeDefined();
  });
});

describe("hydration, Aquarius concentrated exits", () => {
  const POOL = StrKey.encodeContract(new Uint8Array(32).fill(5));

  it("withdraws a range with a slippage floor under the pool's own estimate", async () => {
    const calls: { minAmounts: readonly bigint[]; liquidity: bigint }[] = [];
    const withdrawConcentratedPosition = vi.fn(
      async (args: { minAmounts: readonly bigint[]; liquidity: bigint }) => {
        calls.push({ minAmounts: args.minAmounts, liquidity: args.liquidity });
        return { fake: "tx" };
      },
    ) as unknown as NonNullable<HydrationAdapterOverrides["withdrawConcentratedPosition"]>;
    const estimateConcentratedWithdraw = vi.fn(async () => [1_000_000n, 2_000_000n]);
    const node: PlanNode = {
      id: "range",
      kind: "WithdrawAquariusConcentrated",
      dependencies: [],
      description: "range",
      status: "pending",
      metadata: {
        kind: "WithdrawAquariusConcentrated",
        poolAddress: POOL,
        tokens: ["CA", "CB"],
        tickLower: -10,
        tickUpper: 10,
        liquidity: 99n,
      },
    };
    const deps = baseDeps({
      adapters: { withdrawConcentratedPosition, estimateConcentratedWithdraw },
    });
    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);
    expect(failures).toEqual([]);
    expect(estimateConcentratedWithdraw).toHaveBeenCalledWith(deps.rpc, NETWORK, {
      poolAddress: POOL,
      user: USER,
      tickLower: -10,
      tickUpper: 10,
      liquidity: 99n,
    });
    expect(calls).toEqual([
      {
        liquidity: 99n,
        minAmounts: [
          BigInt(applySlippageMin("1000000", DEFAULT_SLIPPAGE_BPS)),
          BigInt(applySlippageMin("2000000", DEFAULT_SLIPPAGE_BPS)),
        ],
      },
    ]);
  });

  it("collects the swap fees on the pool", async () => {
    const claimConcentratedFees = vi.fn(async () => ({ fake: "tx" })) as unknown as NonNullable<
      HydrationAdapterOverrides["claimConcentratedFees"]
    >;
    const node: PlanNode = {
      id: "fees",
      kind: "ClaimAquariusConcentratedFees",
      dependencies: [],
      description: "fees",
      status: "pending",
      metadata: { kind: "ClaimAquariusConcentratedFees", poolAddress: POOL, tokens: ["CA", "CB"] },
    };
    await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({ adapters: { claimConcentratedFees } }),
    );
    expect(claimConcentratedFees).toHaveBeenCalledWith(
      expect.objectContaining({ user: USER, poolAddress: POOL, network: NETWORK }),
      expect.anything(),
    );
    expect((node.metadata as { transaction?: unknown }).transaction).toEqual({ fake: "tx" });
  });
});

// H-27: many tokens trade to XLM only through another token
describe("hydration, ConvertSorobanToXLM swaps along the route it finds", () => {
  const HOP = StrKey.encodeContract(new Uint8Array(32).fill(8));

  it("quotes and signs along a one-hop path and reads the XLM out from its end", async () => {
    const calls: { amountOutMin: string; path?: readonly string[] | undefined }[] = [];
    const buildSwapToXLM = vi.fn(
      async (args: {
        amountIn: string;
        amountOutMin: string;
        path?: readonly string[] | undefined;
      }) => {
        calls.push({ amountOutMin: args.amountOutMin, path: args.path });
        return { amountIn: BigInt(args.amountIn) };
      },
    ) as unknown as NonNullable<HydrationAdapterOverrides["buildSwapToXLM"]>;
    const rpc = {
      simulateTransaction: vi.fn(async (tx: { amountIn: bigint }) => ({
        latestLedger: 1,
        minResourceFee: "100",
        transactionData: {},
        result: {
          retval: scvVec([
            scvI128(tx.amountIn),
            scvI128(tx.amountIn * 2n),
            scvI128(tx.amountIn * 4n),
          ]),
          auth: [],
        },
      })),
    } as unknown as HydrationDeps["rpc"];
    const path = [HELD_TOKEN, HOP, XLM_SAC];
    const node = convertNode();
    const deps = baseDeps({
      rpc,
      adapters: {
        buildSwapToXLM,
        quoteRouteToXLM: async () => ({ path, amounts: [] }),
        readTokenBalance: async () => 1_000_000n,
      },
    });

    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);

    expect(failures).toEqual([]);
    expect(calls.map((c) => c.path)).toEqual([path, path, path]);
    expect(calls[2]!.amountOutMin).toBe(applySlippageMin("4000000", DEFAULT_SLIPPAGE_BPS));
    expect((node.metadata as { quote?: { path: readonly string[] } }).quote?.path).toEqual(path);
  });

  it("fails a token with no route instead of deferring it, so the user picks what to do", async () => {
    const node = convertNode({ deps: ["exit"] });
    const exit: PlanNode = {
      id: "exit",
      kind: "TransferAsIs",
      dependencies: [],
      description: "already built",
      status: "pending",
      metadata: {
        kind: "TransferAsIs",
        asset: { kind: "contract", contractId: HELD_TOKEN },
        amount: 1n,
        destination: USER,
        transaction: { fake: "tx" } as never,
      },
    };
    const deps = baseDeps({
      adapters: {
        quoteRouteToXLM: async () => {
          throw new NoSoroswapRouteError(HELD_TOKEN, []);
        },
        readTokenBalance: async () => 1_000_000n,
      },
    });
    const { failures } = await hydratePlanTransactions(buildPlanTree([exit, node]), USER, deps);
    expect(failures).toEqual([expect.objectContaining({ nodeId: "cv1", deferred: false })]);
    expect(node.error).toMatch(/No Soroswap route/);
  });
});

// M-19: a confirmation covers the price the review showed, not any later price
describe("hydration, a conversion is bound to the quote the user reviewed", () => {
  const thinPool = (x: bigint): bigint => (x * 1_000_000n) / (1_000_000n + x);

  it("refuses an accepted swap whose rate fell past the tolerance between review and execute", async () => {
    const node = convertNode({ priceImpactAccepted: true });
    const review = swapMarket(thinPool);
    await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({
        rpc: review.rpc,
        adapters: {
          buildSwapToXLM: review.buildSwapToXLM,
          quoteRouteToXLM: review.quoteRouteToXLM,
          readTokenBalance: async () => 1_000_000n,
        },
      }),
    );
    const md = node.metadata as { reviewedQuote?: { expectedOut: bigint } };
    expect(md.reviewedQuote?.expectedOut).toBe(500_000n);

    // the pool was drained further: the same balance now returns a tenth
    const later = swapMarket((x) => thinPool(x) / 10n);
    const rebuild = rebuildSorobanNodeTransaction(
      node,
      USER,
      baseDeps({
        rpc: later.rpc,
        adapters: {
          buildSwapToXLM: later.buildSwapToXLM,
          quoteRouteToXLM: later.quoteRouteToXLM,
          readTokenBalance: async () => 1_000_000n,
        },
      }),
    );
    await expect(rebuild).rejects.toBeInstanceOf(PriceImpactRefusedError);
    await expect(rebuild).rejects.toMatchObject({ reason: "requote_worse", expectedOut: 50_000n });
    expect(later.calls.every((c) => c.amountOutMin === "0")).toBe(true);
  });

  it("rebuilds within the tolerance of the reviewed quote", async () => {
    const node = convertNode({ priceImpactAccepted: true });
    const market = swapMarket(thinPool);
    const deps = baseDeps({
      rpc: market.rpc,
      adapters: {
        buildSwapToXLM: market.buildSwapToXLM,
        quoteRouteToXLM: market.quoteRouteToXLM,
        readTokenBalance: async () => 1_000_000n,
      },
    });
    await hydratePlanTransactions(buildPlanTree([node]), USER, deps);
    await rebuildSorobanNodeTransaction(node, USER, deps);
    expect((node.metadata as { transaction?: unknown }).transaction).toBeDefined();
  });

  it("holds an execute-time build with no reviewed quote to the cap again", async () => {
    const node = convertNode({ priceImpactAccepted: true });
    const market = swapMarket(thinPool);
    const rebuild = rebuildSorobanNodeTransaction(
      node,
      USER,
      baseDeps({
        rpc: market.rpc,
        adapters: {
          buildSwapToXLM: market.buildSwapToXLM,
          quoteRouteToXLM: market.quoteRouteToXLM,
          readTokenBalance: async () => 1_000_000n,
        },
      }),
    );
    await expect(rebuild).rejects.toMatchObject({ reason: "price_impact", priceImpactBps: 4995 });
  });
});

describe("hydration, an unauthorized BLND trustline", () => {
  it("fails the emissions claim instead of waiting on steps that can't fix it", async () => {
    const buildExitSequence = vi.fn(async () => {
      throw new BlndTrustlineMissingError("CPOOL", "unauthorized", "BLND:GISSUER");
    }) as unknown as NonNullable<HydrationAdapterOverrides["buildExitSequence"]>;
    const withdraw: PlanNode = {
      id: "withdraw",
      kind: "WithdrawBlend",
      dependencies: [],
      description: "already built",
      status: "pending",
      metadata: {
        kind: "WithdrawBlend",
        poolId: "CPOOL",
        asset: "CASSET",
        bucket: "supply",
        transaction: { fake: "tx" } as never,
      },
    };
    const claim: PlanNode = {
      id: "claim",
      kind: "ClaimBlendEmissions",
      dependencies: ["withdraw"],
      description: "claim",
      status: "pending",
      metadata: { kind: "ClaimBlendEmissions", poolId: "CPOOL", reserveTokenIds: [1] },
    };
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([withdraw, claim]),
      USER,
      baseDeps({ adapters: { buildExitSequence } }),
    );
    expect(failures).toEqual([expect.objectContaining({ nodeId: "claim", deferred: false })]);
    expect(claim.status).toBe("failed");
  });
});

describe("hydration, aquarius gauge reward claims", () => {
  const POOL = StrKey.encodeContract(new Uint8Array(32).fill(21));
  const TOKENS = [StrKey.encodeContract(new Uint8Array(32).fill(22)), XLM_SAC];
  const gaugeNode = (deps: string[] = []): PlanNode => ({
    id: "gauge",
    kind: "ClaimAquariusGaugeRewards",
    dependencies: deps,
    description: "gauge",
    status: "pending",
    metadata: {
      kind: "ClaimAquariusGaugeRewards",
      poolAddress: POOL,
      tokens: TOKENS,
      poolIndex: "ab".repeat(32),
      rewards: [{ token: XLM_SAC, amount: 7n }],
    },
  });

  it("builds gauges_claim through the router check and records the pool the router listed", async () => {
    const claimGaugeRewards = vi.fn(async () => ({
      transaction: { fake: "tx" },
      routerPool: POOL,
    })) as unknown as NonNullable<HydrationAdapterOverrides["claimGaugeRewards"]>;
    const node = gaugeNode();
    const deps = baseDeps({ adapters: { claimGaugeRewards } });
    const { failures } = await hydratePlanTransactions(buildPlanTree([node]), USER, deps);
    expect(failures).toEqual([]);
    expect(claimGaugeRewards).toHaveBeenCalledWith(
      expect.objectContaining({
        user: USER,
        poolAddress: POOL,
        tokens: TOKENS,
        poolIndex: "ab".repeat(32),
        network: NETWORK,
      }),
      { server: deps.rpc },
    );
    expect(node.metadata).toMatchObject({ routerPool: POOL, transaction: { fake: "tx" } });
  });

  it("forgets the router's earlier answer when a rebuild's router check fails", async () => {
    let answer: "ok" | "fail" = "ok";
    const claimGaugeRewards = vi.fn(async () => {
      if (answer === "fail") throw new Error(`${POOL} is not the Aquarius pool the router lists`);
      return { transaction: { fake: "tx" }, routerPool: POOL };
    }) as unknown as NonNullable<HydrationAdapterOverrides["claimGaugeRewards"]>;
    const node = gaugeNode();
    const deps = baseDeps({ adapters: { claimGaugeRewards } });
    await hydratePlanTransactions(buildPlanTree([node]), USER, deps);
    answer = "fail";
    await expect(rebuildSorobanNodeTransaction(node, USER, deps)).rejects.toThrow(
      /not the Aquarius pool the router lists/,
    );
    expect(node.metadata).not.toHaveProperty("routerPool");
    expect(node.metadata).not.toHaveProperty("transaction");
  });

  it("fails the step with the reason when the claim can't be built, so the review blocks", async () => {
    const claimGaugeRewards = vi.fn(async () => {
      throw new Error("simulation failed: HostError: Error(Contract, #2004)");
    }) as unknown as NonNullable<HydrationAdapterOverrides["claimGaugeRewards"]>;
    const node = gaugeNode();
    const { failures } = await hydratePlanTransactions(
      buildPlanTree([node]),
      USER,
      baseDeps({ adapters: { claimGaugeRewards } }),
    );
    expect(failures).toMatchObject([{ nodeId: "gauge", deferred: false }]);
    expect(node.status).toBe("failed");
    expect(node.error).toMatch(/Error\(Contract, #2004\)/);
  });
});
