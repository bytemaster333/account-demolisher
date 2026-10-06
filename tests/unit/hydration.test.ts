import { describe, it, expect, vi } from "vitest";
import {
  Horizon,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  rpc as StellarRpc,
} from "@stellar/stellar-sdk";

import { hydratePlanTransactions, rebuildSorobanNodeTransaction } from "@/lib/plan/hydration";
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

const SOURCE_ACCOUNT = accountAt(100n);

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
function swapMarket(rate: (amountIn: bigint) => bigint): {
  rpc: HydrationDeps["rpc"];
  buildSwapToXLM: NonNullable<HydrationAdapterOverrides["buildSwapToXLM"]>;
  calls: { amountIn: string; amountOutMin: string }[];
} {
  const calls: { amountIn: string; amountOutMin: string }[] = [];
  const buildSwapToXLM = vi.fn(async (args: { amountIn: string; amountOutMin: string }) => {
    calls.push({ amountIn: args.amountIn, amountOutMin: args.amountOutMin });
    return { amountIn: BigInt(args.amountIn) };
  }) as unknown as NonNullable<HydrationAdapterOverrides["buildSwapToXLM"]>;
  const rpc = {
    simulateTransaction: vi.fn(async (tx: { amountIn: bigint }) => ({
      latestLedger: 1,
      minResourceFee: "100",
      transactionData: {},
      result: { retval: scvVec([scvI128(tx.amountIn), scvI128(rate(tx.amountIn))]), auth: [] },
    })),
  } as unknown as HydrationDeps["rpc"];
  return { rpc, buildSwapToXLM, calls };
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
    const buildTransfer = vi.fn(async (...args: unknown[]) => {
      amounts.push(args[4] as bigint);
      return { fake: "tx" };
    }) as unknown as NonNullable<HydrationAdapterOverrides["buildTransfer"]>;
    const node = transferNode();
    const deps = baseDeps({ adapters: { buildTransfer, readTokenBalance: async () => 900n } });

    await rebuildSorobanNodeTransaction(node, USER, deps);

    expect(amounts).toEqual([900n]);
    expect((node.metadata as { amount: bigint }).amount).toBe(900n);
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

    expect(failures).toEqual([
      { nodeId: "repay", reason: "Error(Contract, #1205)", deferred: false },
      { nodeId: "withdraw", reason: "Error(Contract, #1205)", deferred: true },
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
      fetchSourceAccount: async () => accountAt(ONCHAIN_SEQ),
      // the held-token swap reads the live balance first; answer it directly
      adapters: { readTokenBalance: async () => 1_000_000n },
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
  }
});
