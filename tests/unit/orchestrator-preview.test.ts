import { describe, expect, it, vi } from "vitest";
import { Account, Asset, Horizon, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";

import { NoSoroswapRouteError } from "@/lib/adapters/soroswap/swap";
import {
  hydratePlanTransactions,
  type HydrationAdapterOverrides,
  type HydrationDeps,
} from "@/lib/plan/hydration";
import { buildPlanTree, type PlanNode } from "@/lib/plan/tree";
import { i128 as scvI128, vec as scvVec } from "@/lib/soroban/scval";
import { refusedHeldTokenConversions, refuseUnsafeSteps } from "@/lib/orchestrator/actors/preview";
import { previewBlockers } from "@/lib/orchestrator/retry";

import {
  DEST,
  NETWORK,
  USDC_SAC,
  USER,
  addr,
  allowlisted,
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
async function hydrated(node: PlanNode, m: ReturnType<typeof market>) {
  const tree = buildPlanTree([node]);
  await hydratePlanTransactions(tree, USER, {
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
  return tree;
}

describe("a refused held-token conversion is put to the user with its kind", () => {
  // constant product, 1:1 spot with 1_000_000 a side: selling it all halves the rate
  const thinPool = (x: bigint): bigint => (x * 1_000_000n) / (1_000_000n + x);

  it("names a price over the cap", async () => {
    const tree = await hydrated(convert(), market(thinPool));
    expect(refusedHeldTokenConversions(tree)).toEqual([
      expect.objectContaining({
        key: `contract:${HELD_TOKEN}`,
        contractId: HELD_TOKEN,
        refusal: "price_impact",
      }),
    ]);
  });

  it("names a token whose price can't be checked", async () => {
    // the whole balance has a quote, the reference slice gets nothing
    const tree = await hydrated(
      convert(),
      market((x) => (x >= 1_000_000n ? x : 0n)),
    );
    expect(refusedHeldTokenConversions(tree).map((r) => r.refusal)).toEqual(["unpriced"]);
  });

  it("names a token with no route to XLM at all", async () => {
    const tree = await hydrated(
      convert(),
      market(
        (x) => x,
        () => {
          throw new NoSoroswapRouteError(HELD_TOKEN, []);
        },
      ),
    );
    expect(refusedHeldTokenConversions(tree).map((r) => r.refusal)).toEqual(["no_route"]);
  });

  it("names a quote worse than the one reviewed", async () => {
    const reviewedQuote = {
      amountIn: 1_000_000n,
      expectedOut: 1_000_000n,
      minOut: 990_000n,
      priceImpactBps: 0,
      path: [HELD_TOKEN, XLM_SAC],
    };
    const tree = await hydrated(
      convert({ priceImpactAccepted: true, reviewedQuote }),
      market((x) => x / 2n),
    );
    expect(refusedHeldTokenConversions(tree).map((r) => r.refusal)).toEqual(["requote_worse"]);
  });

  it("leaves out a conversion that failed for any other reason", async () => {
    const tree = await hydrated(
      convert(),
      market(() => 0n),
    );
    expect(tree.allNodes.get("convert")!.status).toBe("failed");
    expect(refusedHeldTokenConversions(tree)).toEqual([]);
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
