import { describe, expect, it, vi } from "vitest";
import { Account, Asset, Horizon, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";

import { NoSoroswapRouteError } from "@/lib/adapters/soroswap/swap";
import { BackstopClaimUnavailableError } from "@/lib/adapters/blend/exit";
import {
  hydratePlanTransactions,
  type HydrationAdapterOverrides,
  type HydrationDeps,
  type HydrationFailure,
} from "@/lib/plan/hydration";
import { buildPlanTree, type PlanNode, type PlanTree } from "@/lib/plan/tree";
import { i128 as scvI128, vec as scvVec } from "@/lib/soroban/scval";
import {
  backstopClaimForfeits,
  exchangeFundingBlocker,
  exitTrustlineBlockers,
  refusedHeldTokenConversions,
  refuseUnsafeSteps,
} from "@/lib/orchestrator/actors/preview";
import { previewBlockers } from "@/lib/orchestrator/retry";

import {
  DEST,
  MEDIATOR_A,
  NETWORK,
  USDC_ISSUER,
  USDC_SAC,
  USER,
  addr,
  allowlisted,
  makeAudit,
  drainInvocation,
  i128,
  inv,
  invokeTx,
  sourceAuth,
  transferTx,
  u32,
} from "./orchestrator-fixtures";

const HELD_TOKEN = StrKey.encodeContract(new Uint8Array(32).fill(3));
const XLM_SAC = Asset.native().contractId(NETWORK.passphrase);

// the router as hydration sees it: each probe carries its amountIn and the
// simulation answers [amountIn, rate(amountIn)] like swap_exact_tokens_for_tokens
function market(rate: (amountIn: bigint) => bigint, route?: () => never) {
  const buildSwapToXLM = vi.fn(async (args: { amountIn: string }) => ({
    amountIn: BigInt(args.amountIn),
  })) as unknown as NonNullable<HydrationAdapterOverrides["buildSwapToXLM"]>;
  const quoteRouteToXLM = vi.fn(async () => {
    if (route) route();
    return { path: [HELD_TOKEN, XLM_SAC], amounts: [] };
  }) as unknown as NonNullable<HydrationAdapterOverrides["quoteRouteToXLM"]>;
  const rpc = {
    simulateTransaction: vi.fn(async (tx: { amountIn: bigint }) => ({
      latestLedger: 1,
      minResourceFee: "100",
      transactionData: {},
      result: { retval: scvVec([scvI128(tx.amountIn), scvI128(rate(tx.amountIn))]), auth: [] },
    })),
  } as unknown as HydrationDeps["rpc"];
  return { rpc, buildSwapToXLM, quoteRouteToXLM };
}

function source(): Horizon.AccountResponse {
  return new Horizon.AccountResponse({
    id: USER,
    account_id: USER,
    sequence: "100",
    balances: [],
    signers: [],
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {},
    data_attr: {},
  } as never);
}

function convert(over: Record<string, unknown> = {}): PlanNode {
  return {
    id: "convert",
    kind: "ConvertSorobanToXLM",
    dependencies: [],
    description: "convert held token",
    status: "pending",
    metadata: {
      kind: "ConvertSorobanToXLM",
      asset: { kind: "contract", contractId: HELD_TOKEN },
      amount: 1_000_000n,
      ...over,
    },
  } as PlanNode;
}

// the real hydration of one held-token conversion against the given market
async function hydrated(
  node: PlanNode,
  m: ReturnType<typeof market>,
): Promise<{ tree: PlanTree; failures: HydrationFailure[] }> {
  const tree = buildPlanTree([node]);
  return hydratePlanTransactions(tree, USER, {
    rpc: m.rpc,
    horizon: {} as never,
    network: NETWORK,
    currentLedger: 100,
    fetchSourceAccount: async () => source(),
    adapters: {
      buildSwapToXLM: m.buildSwapToXLM,
      quoteRouteToXLM: m.quoteRouteToXLM,
      readTokenBalance: async () => 1_000_000n,
    },
  });
}

describe("a refused held-token conversion is put to the user with its kind", () => {
  // constant product, 1:1 spot with 1_000_000 a side: selling it all halves the rate
  const thinPool = (x: bigint): bigint => (x * 1_000_000n) / (1_000_000n + x);

  it("names a price over the cap", async () => {
    const { tree, failures } = await hydrated(convert(), market(thinPool));
    expect(refusedHeldTokenConversions(tree, failures)).toEqual([
      expect.objectContaining({
        key: `contract:${HELD_TOKEN}`,
        contractId: HELD_TOKEN,
        refusal: "price_impact",
      }),
    ]);
  });

  it("names a token whose price can't be checked", async () => {
    // the whole balance has a quote, the reference slice gets nothing
    const { tree, failures } = await hydrated(
      convert(),
      market((x) => (x >= 1_000_000n ? x : 0n)),
    );
    expect(refusedHeldTokenConversions(tree, failures).map((r) => r.refusal)).toEqual(["unpriced"]);
  });

  it("names a token with no route to XLM at all", async () => {
    const { tree, failures } = await hydrated(
      convert(),
      market(
        (x) => x,
        () => {
          throw new NoSoroswapRouteError(HELD_TOKEN, []);
        },
      ),
    );
    expect(refusedHeldTokenConversions(tree, failures).map((r) => r.refusal)).toEqual(["no_route"]);
  });

  it("names a quote worse than the one reviewed", async () => {
    const reviewedQuote = {
      amountIn: 1_000_000n,
      expectedOut: 1_000_000n,
      minOut: 990_000n,
      priceImpactBps: 0,
      path: [HELD_TOKEN, XLM_SAC],
    };
    const { tree, failures } = await hydrated(
      convert({ priceImpactAccepted: true, reviewedQuote }),
      market((x) => x / 2n),
    );
    expect(refusedHeldTokenConversions(tree, failures).map((r) => r.refusal)).toEqual([
      "requote_worse",
    ]);
  });

  it("leaves out a conversion that failed for any other reason", async () => {
    const { tree, failures } = await hydrated(
      convert(),
      market(() => 0n),
    );
    expect(tree.allNodes.get("convert")!.status).toBe("failed");
    expect(refusedHeldTokenConversions(tree, failures)).toEqual([]);
  });

  it("does not take a failure for a refusal because its text reads like one", () => {
    // failed by the sign-time checks, not by hydration's price check
    const node = convert();
    node.status = "failed";
    node.error =
      "This step would not be signed: selling the whole balance has a 9.00% price impact, " +
      "over the 2.00% cap";
    expect(refusedHeldTokenConversions(buildPlanTree([node]), [])).toEqual([]);
  });
});

describe("only a claim the network refuses in simulation is offered as a forfeit", () => {
  const pool = allowlisted("blend", "BlendPool");
  const claim = (): PlanNode =>
    ({
      id: "backstop-claim",
      kind: "ClaimBackstopEmissions",
      dependencies: [],
      description: "claim backstop emissions",
      status: "pending",
      metadata: { kind: "ClaimBackstopEmissions", poolId: pool, accruedEmissions: 7_114_578_242n },
    }) as PlanNode;

  async function hydrateClaim(fail: () => never) {
    const tree = buildPlanTree([claim()]);
    const { failures } = await hydratePlanTransactions(tree, USER, {
      rpc: {} as never,
      horizon: {} as never,
      network: NETWORK,
      currentLedger: 100,
      fetchSourceAccount: async () => source(),
      adapters: { buildBackstopClaimTx: async () => fail() },
    });
    return { tree, failures };
  }

  it("asks for the forfeit when the claim traps in simulation", async () => {
    const { tree, failures } = await hydrateClaim(() => {
      throw new BackstopClaimUnavailableError(
        pool,
        "CBACKSTOP",
        7_114_578_242n,
        "HostError: VM call trapped: UnreachableCodeReached",
      );
    });
    expect(backstopClaimForfeits(tree, failures)).toEqual([
      {
        poolId: pool,
        accruedEmissions: 7_114_578_242n,
        reason: "the claim fails when simulated against the chain today",
      },
    ]);
  });

  it("keeps an rpc failure an ordinary failed step the user can retry", async () => {
    const { tree, failures } = await hydrateClaim(() => {
      throw new Error("getLedgerEntries timed out after 30000ms");
    });
    expect(backstopClaimForfeits(tree, failures)).toEqual([]);
    expect(previewBlockers(tree).map((b) => b.error)).toEqual([
      "getLedgerEntries timed out after 30000ms",
    ]);
  });

  it("keeps a claim the sign-time checks refused an ordinary failed step", () => {
    const node = claim();
    node.status = "failed";
    node.error = "This step would not be signed: its authorization asks for more";
    expect(backstopClaimForfeits(buildPlanTree([node]), [])).toEqual([]);
  });
});

describe("a pool exit that pays into a missing or unauthorized trustline blocks the review", () => {
  const lp = (): PlanNode =>
    ({
      id: "lp",
      kind: "WithdrawSoroswapLp",
      dependencies: [],
      description: "lp",
      status: "simulated",
      metadata: { kind: "WithdrawSoroswapLp", tokenA: USDC_SAC, tokenB: XLM_SAC, shareBalance: 1n },
    }) as PlanNode;
  const gap = (reason: "missing" | "unauthorized") => ({
    contractId: USDC_SAC,
    code: "USDC",
    issuer: USDC_ISSUER,
    reason,
  });

  it("says how to fix each gap an exit in the plan pays into", () => {
    expect(exitTrustlineBlockers(buildPlanTree([lp()]), [gap("missing")])).toEqual([
      expect.stringMatching(/no USDC trustline, so the exit would fail on chain/),
    ]);
    expect(exitTrustlineBlockers(buildPlanTree([lp()]), [gap("unauthorized")])).toEqual([
      expect.stringMatching(/not authorized by its issuer/),
    ]);
  });

  it("ignores a gap no exit in the plan pays into", () => {
    expect(exitTrustlineBlockers(buildPlanTree([]), [gap("unauthorized")])).toEqual([]);
  });
});

describe("the exchange funding check counts the classic unwind ahead of the merge", () => {
  // 3.00002 XLM covers the 2 XLM forward, the 1 XLM own reserve and two ops at
  // 100 stroops; the unwind's offer cancel costs one more op
  const audit = makeAudit({
    balances: [
      {
        asset: { kind: "native" },
        amount: "3.0000200",
        buyingLiabilities: "0.0000000",
        sellingLiabilities: "0.0000000",
      },
    ],
  });
  const final = {
    id: "final-classic-tx",
    kind: "FinalClassicTx",
    dependencies: [],
    description: "close",
    status: "simulated",
    metadata: {
      kind: "FinalClassicTx",
      destination: DEST,
      useMediator: true,
      batches: [
        {
          destination: MEDIATOR_A,
          operations: [
            {
              kind: "create_account_mediator",
              summary: "fund the forward",
              metadata: { destination: MEDIATOR_A, startingBalance: "2.0000000" },
            },
            { kind: "account_merge", summary: "merge", metadata: { destination: MEDIATOR_A } },
          ],
        },
      ],
    },
  } as unknown as PlanNode;
  const unwind = {
    id: "classic-unwind",
    kind: "ClassicUnwind",
    dependencies: [],
    description: "unwind",
    status: "simulated",
    metadata: {
      kind: "ClassicUnwind",
      batches: [
        {
          destination: DEST,
          operations: [
            { kind: "manage_sell_offer_cancel", summary: "cancel", metadata: { offerId: "77" } },
          ],
        },
      ],
      offerIds: ["77"],
      poolIds: [],
      repayAssets: [USDC_SAC],
      destination: DEST,
    },
  } as unknown as PlanNode;

  it("passes when only the merge batch has to be paid for", () => {
    expect(exchangeFundingBlocker(audit, buildPlanTree([final]), 100, NETWORK)).toBeNull();
  });

  it("blocks once the unwind's fee comes out of the same balance", () => {
    expect(exchangeFundingBlocker(audit, buildPlanTree([unwind, final]), 100, NETWORK)).toMatch(
      /needs at least 2 XLM free at the merge to fund the exchange forward; it has about 1\.99999 XLM/,
    );
  });
});

describe("the preview holds each built required step to the sign-time checks", () => {
  const pool = allowlisted("blend", "BlendPool");

  function withdraw(subs: ReturnType<typeof inv>[]): PlanNode {
    // submit(from, spender, to, [request]); request_type 1 withdraws supply
    const request = [addr(USER), addr(USER), addr(USER), requestVec(USDC_SAC, 5n, 1)];
    return {
      id: "withdraw",
      kind: "WithdrawBlend",
      dependencies: [],
      description: "withdraw usdc",
      status: "simulated",
      metadata: {
        kind: "WithdrawBlend",
        poolId: pool,
        asset: USDC_SAC,
        bucket: "supply",
        transaction: invokeTx(new Account(USER, "1"), pool, "submit", request, [
          sourceAuth(inv(pool, "submit", request, subs)),
        ]),
      },
    } as PlanNode;
  }

  it("fails a required step whose tree carries a drain, so the close can't be confirmed", () => {
    const hostile = withdraw([drainInvocation()]);
    const tree = buildPlanTree([hostile]);
    refuseUnsafeSteps(tree, USER, NETWORK);
    expect(hostile.status).toBe("failed");
    expect(hostile.error).toMatch(/would not be signed/);
    expect(previewBlockers(tree).map((b) => b.nodeId)).toEqual(["withdraw"]);
  });

  it("keeps a step whose tree is exactly the one its call needs", () => {
    const clean = withdraw([]);
    refuseUnsafeSteps(buildPlanTree([clean]), USER, NETWORK);
    expect(clean.status).toBe("simulated");
  });

  it("leaves the token sweep to its own guard at sign time", () => {
    const sweep = {
      id: "sweep",
      kind: "TransferAsIs",
      dependencies: [],
      description: "sweep",
      status: "simulated",
      metadata: {
        kind: "TransferAsIs",
        asset: { kind: "contract", contractId: HELD_TOKEN },
        amount: 5n,
        destination: DEST,
        transaction: transferTx(new Account(USER, "1"), HELD_TOKEN, DEST, 5n),
      },
    } as PlanNode;
    refuseUnsafeSteps(buildPlanTree([sweep]), USER, NETWORK);
    expect(sweep.status).toBe("simulated");
  });
});

// blend's Request struct as the pool reads it, fields in key order
function requestVec(asset: string, amount: bigint, requestType: number) {
  const fields: [string, xdr.ScVal][] = [
    ["address", addr(asset)],
    ["amount", i128(amount)],
    ["request_type", u32(requestType)],
  ];
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvMap(
      fields.map(
        ([k, v]) => new xdr.ScMapEntry({ key: nativeToScVal(k, { type: "symbol" }), val: v }),
      ),
    ),
  ]);
}
