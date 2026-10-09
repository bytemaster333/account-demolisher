import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  nativeToScVal,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { AccountNotFoundError } from "@/lib/stellar/account-audit";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";
import { soroswapPairFor } from "@/lib/soroban/defi-auth-guard";
import { BackstopEmissionsClaimError, PriceImpactRefusedError } from "@/lib/plan/hydration";
import { NoSoroswapRouteError } from "@/lib/adapters/soroswap/swap";
import { BackstopClaimUnavailableError } from "@/lib/adapters/blend/exit";
import type { PathResultRef } from "@/lib/types/plan";
import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";

import {
  ATTACKER,
  DEST,
  HOSTILE_TOKEN,
  NETWORK,
  USDC_ISSUER,
  USDC_SAC,
  USER,
  addr,
  allowlisted,
  fakeHorizon,
  horizonError,
  i128,
  inv,
  ledgerRecord,
  invokeTx,
  makeAudit,
  signingConnector,
  sourceAuth,
  transferTx,
  u32,
  type FakeAccount,
} from "./orchestrator-fixtures";

// only the network edges are replaced: the audit and path reads hit horizon, the
// forward hits the mediator route. the batcher, the classic builder, the guards,
// the allow-list and the signing are real.
const auditAccount = vi.fn();
const resolveCreditPaths = vi.fn();
const submitMediatorForward = vi.fn();

vi.mock("@/lib/stellar/account-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/account-audit")>(
    "@/lib/stellar/account-audit",
  );
  return { ...actual, auditAccount: (...args: unknown[]) => auditAccount(...args) };
});
vi.mock("@/lib/stellar/path-finder", () => ({
  resolveCreditPaths: (...args: unknown[]) => resolveCreditPaths(...args),
}));
vi.mock("@/lib/mediator/forward", () => ({
  submitMediatorForward: (...args: unknown[]) => submitMediatorForward(...args),
}));

import {
  executePlanTreeOnChain,
  MAX_PER_OP_FEE,
  type ConfirmationReceipt,
  type ExecutorDeps,
} from "@/lib/orchestrator/executor";
import {
  AmbiguousSubmitError,
  classifyFailure,
  CloseFailure,
  isRetryableFailure,
  SubmitRejectedError,
} from "@/lib/orchestrator/failures";
import { journalFor } from "@/lib/orchestrator/journal";

function tree(...nodes: PlanNode[]): PlanTree {
  return {
    rootNodes: nodes.filter((n) => n.dependencies.length === 0),
    allNodes: new Map(nodes.map((n) => [n.id, n])),
  };
}

function finalNode(deps: string[] = [], over: Record<string, unknown> = {}): PlanNode {
  return {
    id: "final-classic-tx",
    kind: "FinalClassicTx",
    dependencies: deps,
    description: "close account",
    status: "pending",
    metadata: {
      kind: "FinalClassicTx",
      batches: [],
      destination: DEST,
      useMediator: false,
      ...over,
    },
  } as PlanNode;
}

function accounts(seq = 100n): Map<string, FakeAccount> {
  return new Map([[USER, { seq, balances: [] }]]);
}

// the per-op bid of a signed classic batch. the merge batch carries the close
// marker pair, so its total fee is three times the bid.
function perOpFee(tx: Transaction): string {
  return (BigInt(tx.fee) / BigInt(tx.operations.length)).toString();
}

let receiptN = 0;
function receipt(): ConfirmationReceipt {
  receiptN += 1;
  return { txHash: `H${receiptN}`, ledger: receiptN };
}

function deps(
  over: Partial<ExecutorDeps> = {},
  table = accounts(),
): ExecutorDeps & {
  connector: ReturnType<typeof signingConnector>;
  submitClassic: ReturnType<typeof vi.fn>;
  submitSoroban: ReturnType<typeof vi.fn>;
} {
  return {
    network: NETWORK,
    connector: signingConnector(),
    horizon: fakeHorizon(table),
    submitClassic: vi.fn(async () => receipt()),
    submitSoroban: vi.fn(async () => receipt()),
    ...over,
  } as never;
}

async function run(t: PlanTree, d: ExecutorDeps, notes: string[] = []) {
  const p = executePlanTreeOnChain({ publicKey: USER, tree: t, onNote: (n) => notes.push(n) }, d);
  // the caller asserts on p; this only keeps a rejection from counting as
  // unhandled while the backoff timers are drained
  p.catch(() => {});
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  auditAccount.mockResolvedValue(makeAudit());
  resolveCreditPaths.mockResolvedValue(new Map());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FinalClassicTx prep reads ride out horizon blips", () => {
  it("retries a 5xx during merge prep and still merges", async () => {
    auditAccount
      .mockRejectedValueOnce(horizonError(502))
      .mockRejectedValueOnce(horizonError(503))
      .mockResolvedValueOnce(makeAudit());
    const t = tree(finalNode());
    const d = deps();
    const out = await run(t, d);
    expect(auditAccount).toHaveBeenCalledTimes(3);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
    expect(out.receipts["final-classic-tx"]).toBeDefined();
    // the merge really merges into the destination, after the close marker pair
    const merge = d.connector.signed[0]!;
    expect(merge.operations.map((o) => o.type)).toEqual([
      "manageData",
      "manageData",
      "accountMerge",
    ]);
    expect(merge.operations[2]).toMatchObject({ type: "accountMerge", destination: DEST });
  });

  it("retries a 429 instead of failing on a rate limit", async () => {
    auditAccount.mockRejectedValueOnce(horizonError(429)).mockResolvedValueOnce(makeAudit());
    const t = tree(finalNode());
    await run(t, deps());
    expect(auditAccount).toHaveBeenCalledTimes(2);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
  });

  it("does not retry a missing account and says the account is gone", async () => {
    auditAccount.mockRejectedValue(new AccountNotFoundError(USER));
    const t = tree(finalNode());
    const d = deps();
    const p = run(t, d);
    await expect(p).rejects.toMatchObject({ kind: "not_mergeable" });
    expect(auditAccount).toHaveBeenCalledTimes(1);
    expect(d.submitClassic).not.toHaveBeenCalled();
  });

  it("does not retry a 4xx", async () => {
    const err = horizonError(400, "Bad Request");
    auditAccount.mockRejectedValue(err);
    await expect(run(tree(finalNode()), deps())).rejects.toBe(err);
    expect(auditAccount).toHaveBeenCalledTimes(1);
  });

  it("gives up after a persistent 5xx", async () => {
    auditAccount.mockRejectedValue(horizonError(502, "Bad Gateway"));
    const d = deps();
    await expect(run(tree(finalNode()), d)).rejects.toThrow(/Bad Gateway/);
    expect(auditAccount).toHaveBeenCalledTimes(3);
    expect(d.submitClassic).not.toHaveBeenCalled();
  });

  it("refuses to sign when fresh state is no longer mergeable", async () => {
    auditAccount.mockResolvedValue(
      makeAudit({
        flags: {
          authImmutable: true,
          authRequired: false,
          authRevocable: false,
          authClawbackEnabled: false,
        },
      }),
    );
    const d = deps();
    await expect(run(tree(finalNode()), d)).rejects.toThrow(
      /account_merge blocked: AUTH_IMMUTABLE/,
    );
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });
});

describe("FinalClassicTx soroban re-probe", () => {
  const empty = EMPTY_POSITIONS;

  it("blocks the merge while a position is still open", async () => {
    const d = deps({
      reprobeSorobanPositions: async () => ({ ...empty, blend: [{ poolId: "P" }] }) as never,
    });
    await expect(run(tree(finalNode()), d)).rejects.toThrow(/position\(s\) still open/);
    expect(d.submitClassic).not.toHaveBeenCalled();
  });

  it("blocks the merge when a protocol could not be read (fail closed)", async () => {
    const d = deps({
      reprobeSorobanPositions: async () =>
        ({ ...empty, errors: [{ protocol: "blend", message: "429" }] }) as never,
    });
    await expect(run(tree(finalNode()), d)).rejects.toMatchObject({ kind: "network" });
    expect(d.submitClassic).not.toHaveBeenCalled();
  });

  it("blocks the merge when the re-probe throws", async () => {
    const d = deps({
      reprobeSorobanPositions: async () => {
        throw new Error("discovery RPC unavailable");
      },
    });
    await expect(run(tree(finalNode()), d)).rejects.toThrow(/discovery RPC unavailable/);
    expect(d.submitClassic).not.toHaveBeenCalled();
  });

  it("merges when nothing is open", async () => {
    const t = tree(finalNode());
    await run(t, deps({ reprobeSorobanPositions: async () => empty as never }));
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
  });
});

describe("FinalClassicTx fee bid and in-call rebuilds", () => {
  it("bids from fee_charged, not max_fee", async () => {
    const table = accounts();
    const d = deps(
      {
        horizon: fakeHorizon(table, {
          feeStats: vi.fn(async () => ({
            ledger_capacity_usage: "0.60",
            fee_charged: { mode: "100", p90: "6970" },
            max_fee: { mode: "100", p90: "1000000" },
          })) as never,
        }),
      },
      table,
    );
    await run(tree(finalNode()), d);
    // 6970 stroops per op, not the 0.1 XLM cap
    expect(perOpFee(d.connector.signed[0]!)).toBe("6970");
  });

  it("bids what most transactions paid while ledgers are not full", async () => {
    // testnet on 2026-10-07: 12% of capacity used, while soroban resource fees
    // pushed the p90 of fee_charged to 484829 stroops per operation
    const table = accounts();
    const d = deps(
      {
        horizon: fakeHorizon(table, {
          feeStats: vi.fn(async () => ({
            ledger_capacity_usage: "0.12",
            fee_charged: { mode: "100", p90: "484829" },
          })) as never,
        }),
      },
      table,
    );
    await run(tree(finalNode()), d);
    expect(perOpFee(d.connector.signed[0]!)).toBe("100");
  });

  it("bids the p90 once ledgers are at least half full", async () => {
    const table = accounts();
    const d = deps(
      {
        horizon: fakeHorizon(table, {
          feeStats: vi.fn(async () => ({
            ledger_capacity_usage: "0.53",
            fee_charged: { mode: "100", p90: "17380" },
          })) as never,
        }),
      },
      table,
    );
    await run(tree(finalNode()), d);
    expect(perOpFee(d.connector.signed[0]!)).toBe("17380");
  });

  it("fails as a retryable network failure when horizon can't serve fee stats", async () => {
    const table = accounts();
    const feeStats = vi.fn(async () => {
      throw horizonError(503);
    });
    const d = deps({ horizon: fakeHorizon(table, { feeStats: feeStats as never }) }, table);
    const failure = await run(tree(finalNode()), d).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CloseFailure);
    expect(failure).toMatchObject({ kind: "network" });
    expect(isRetryableFailure(classifyFailure(failure))).toBe(true);
    expect((failure as Error).message).toMatch(/network fees could not be read/i);
    // a 503 is a blip: the read is retried before the step fails
    expect(feeStats).toHaveBeenCalledTimes(3);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["an unreadable bid", { ledger_capacity_usage: "0.60", fee_charged: { p90: "n/a" } }],
    ["a zero bid", { ledger_capacity_usage: "0.10", fee_charged: { mode: "0" } }],
    ["no fee_charged", { ledger_capacity_usage: "0.10" }],
    ["an unreadable capacity usage", { fee_charged: { mode: "100", p90: "5000" } }],
  ])("refuses to bid the minimum on %s", async (_label, stats) => {
    const table = accounts();
    const d = deps(
      { horizon: fakeHorizon(table, { feeStats: vi.fn(async () => stats) as never }) },
      table,
    );
    const failure = await run(tree(finalNode()), d).catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind: "network" });
    expect((failure as Error).message).toMatch(/network fees could not be read/i);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("caps the bid at what the account can spend above its reserves", async () => {
    const table = accounts();
    // 1.0000500 XLM with a 0.5 XLM base reserve and no subentries: 500 stroops
    // spendable, so a one-op merge may bid at most 500 even though fees ran high
    auditAccount.mockResolvedValue(
      makeAudit({
        balances: [
          {
            asset: { kind: "native" },
            amount: "1.0000500",
            buyingLiabilities: "0",
            sellingLiabilities: "0",
          },
        ],
      }),
    );
    const ledgers = () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({ records: [ledgerRecord()] }),
        }),
      }),
    });
    const d = deps(
      {
        horizon: fakeHorizon(table, {
          feeStats: vi.fn(async () => ({
            ledger_capacity_usage: "0.60",
            fee_charged: { p90: "800000" },
          })) as never,
          ledgers: ledgers as never,
        }),
      },
      table,
    );
    await run(tree(finalNode()), d);
    expect(d.connector.signed[0]!.fee).toBe("500");
  });

  it("retries at the network minimum after tx_insufficient_balance", async () => {
    const table = accounts();
    const d = deps(
      {
        horizon: fakeHorizon(table, {
          feeStats: vi.fn(async () => ({
            ledger_capacity_usage: "0.60",
            fee_charged: { p90: "20000" },
          })) as never,
        }),
      },
      table,
    );
    d.submitClassic
      .mockRejectedValueOnce(
        new SubmitRejectedError({ transaction: "tx_insufficient_balance" }, 400),
      )
      .mockResolvedValueOnce(receipt());
    const t = tree(finalNode());
    await run(t, d);
    expect(d.connector.signed.map(perOpFee)).toEqual(["20000", "100"]);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
  });

  it("refuses up front when even the minimum fee is not covered", async () => {
    auditAccount.mockResolvedValue(
      makeAudit({
        balances: [
          {
            asset: { kind: "native" },
            amount: "1.0000050",
            buyingLiabilities: "0",
            sellingLiabilities: "0",
          },
        ],
      }),
    );
    const table = accounts();
    const ledgers = () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({ records: [ledgerRecord()] }),
        }),
      }),
    });
    const d = deps({ horizon: fakeHorizon(table, { ledgers: ledgers as never }) }, table);
    await expect(run(tree(finalNode()), d)).rejects.toMatchObject({ kind: "not_mergeable" });
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("escalates the fee on tx_insufficient_fee", async () => {
    const d = deps();
    d.submitClassic
      .mockRejectedValueOnce(new SubmitRejectedError({ transaction: "tx_insufficient_fee" }, 400))
      .mockResolvedValueOnce(receipt());
    await run(tree(finalNode()), d);
    expect(d.connector.signed.map(perOpFee)).toEqual(["100", "300"]);
  });

  it("rebuilds in sequence after tx_bad_seq, using the account's fresh sequence", async () => {
    const table = accounts(100n);
    const d = deps({}, table);
    d.submitClassic.mockImplementationOnce(async () => {
      // someone else used the account's next sequence meanwhile
      table.get(USER)!.seq = 105n;
      throw new SubmitRejectedError({ transaction: "tx_bad_seq" }, 400);
    });
    await run(tree(finalNode()), d);
    expect(d.connector.signed.map((tx) => tx.sequence)).toEqual(["101", "106"]);
  });

  it("stops after the attempt budget on a persistent tx_bad_seq", async () => {
    const d = deps();
    d.submitClassic.mockRejectedValue(new SubmitRejectedError({ transaction: "tx_bad_seq" }, 400));
    await expect(run(tree(finalNode()), d)).rejects.toThrow(/tx_bad_seq/);
    expect(d.submitClassic).toHaveBeenCalledTimes(3);
  });

  it("does not retry a deterministic op failure (op_no_issuer)", async () => {
    const d = deps();
    d.submitClassic.mockRejectedValue(
      new SubmitRejectedError({ transaction: "tx_failed", operations: ["op_no_issuer"] }, 400),
    );
    await expect(run(tree(finalNode()), d)).rejects.toThrow(/op_no_issuer/);
    expect(d.submitClassic).toHaveBeenCalledTimes(1);
  });

  it("re-audits and rebuilds in the same call after state drift", async () => {
    for (const code of ["op_invalid_limit", "op_under_minimum", "op_underfunded"]) {
      vi.clearAllMocks();
      auditAccount.mockResolvedValue(makeAudit());
      resolveCreditPaths.mockResolvedValue(new Map());
      const d = deps();
      d.submitClassic
        .mockRejectedValueOnce(
          new SubmitRejectedError(
            { transaction: "tx_failed", operations: ["op_success", code] },
            400,
          ),
        )
        .mockResolvedValueOnce(receipt());
      const t = tree(finalNode());
      await run(t, d);
      expect(auditAccount).toHaveBeenCalledTimes(2);
      expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
    }
  });
});

describe("a conversion that misses its floor on chain", () => {
  const usdcBalance = {
    asset: { kind: "credit" as const, code: "USDC", issuer: USDC_ISSUER },
    amount: "500.0000000",
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    limit: "1000",
  };
  // a full-size quote and the 1/1000 reference slice at the same rate
  const path = (out: string): Map<string, PathResultRef> =>
    new Map([
      [
        `USDC:${USDC_ISSUER}`,
        {
          destinationAmount: out,
          path: [],
          sourceAmount: "500",
          reference: {
            sourceAmount: "0.5000000",
            destinationAmount: (Number(out) / 1000).toFixed(7),
          },
        },
      ],
    ]);
  const priceMiss = () =>
    new SubmitRejectedError(
      { transaction: "tx_failed", operations: ["op_success", "op_under_dest_min"] },
      400,
    );

  beforeEach(() => {
    auditAccount.mockResolvedValue(
      makeAudit({ balances: [...makeAudit().balances, usdcBalance], subentryCount: 1 }),
    );
  });

  it("stops after one identical re-quote instead of prompting a third time", async () => {
    resolveCreditPaths.mockResolvedValue(path("2000.0000000"));
    const d = deps();
    d.submitClassic.mockRejectedValue(priceMiss());
    await expect(run(tree(finalNode()), d)).rejects.toMatchObject({ kind: "not_mergeable" });
    // one signature, then the identical quote is caught before a second prompt
    expect(d.connector.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("does retry when the market moved and the quote changed", async () => {
    resolveCreditPaths
      .mockResolvedValueOnce(path("2000.0000000"))
      .mockResolvedValueOnce(path("1990.0000000"));
    const d = deps();
    d.submitClassic.mockRejectedValueOnce(priceMiss()).mockResolvedValueOnce(receipt());
    const t = tree(finalNode());
    await run(t, d);
    expect(d.connector.signTransaction).toHaveBeenCalledTimes(2);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
  });
});

describe("conversions that trade through one market land in separate phases (M-14)", () => {
  // EURC sells through USDC, so it trades on the USDC/XLM market the USDC sale
  // uses too. each is quoted against the untouched book; in one transaction the
  // second misses its floor once the first has eaten into that market.
  const EURC = { kind: "credit" as const, code: "EURC", issuer: USDC_ISSUER };
  const USDC_ID = { kind: "credit" as const, code: "USDC", issuer: USDC_ISSUER };
  const line = (asset: typeof EURC, amount: string) => ({
    asset,
    amount,
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    limit: "1000",
  });
  const assetKey = (a: Asset): string =>
    a.isNative() ? "native" : `${a.getCode()}:${a.getIssuer()}`;

  it("sells each in its own phase, re-quoted after the first landed, and closes", async () => {
    // the account as the landed transactions leave it
    const held = new Map<string, { asset: typeof EURC; amount: string }>([
      [`USDC:${USDC_ISSUER}`, { asset: USDC_ID, amount: "500.0000000" }],
      [`EURC:${USDC_ISSUER}`, { asset: EURC, amount: "300.0000000" }],
    ]);
    let merged = false;
    auditAccount.mockImplementation(async () => {
      if (merged) throw new AccountNotFoundError(USER);
      const lines = [...held.values()].map((h) => line(h.asset, h.amount));
      return makeAudit({
        balances: [...makeAudit().balances, ...lines],
        subentryCount: lines.length,
      });
    });
    const quoteFor = (key: string, amount: string): PathResultRef => ({
      sourceAmount: amount,
      destinationAmount: (Number(amount) * 4).toFixed(7),
      // EURC routes through USDC
      path: key.startsWith("EURC") ? [USDC_ID] : [],
      reference: { sourceAmount: "0.1000000", destinationAmount: "0.4000000" },
    });
    resolveCreditPaths.mockImplementation(
      async (a: {
        balances: { asset: { kind: string; code?: string; issuer?: string }; amount: string }[];
      }) => {
        const out = new Map<string, PathResultRef>();
        for (const b of a.balances) {
          if (b.asset.kind !== "credit" || Number(b.amount) === 0) continue;
          const key = `${b.asset.code}:${b.asset.issuer}`;
          out.set(key, quoteFor(key, b.amount));
        }
        return out;
      },
    );

    const d = deps();
    // the network: two sales over one market in one transaction miss the floor
    d.submitClassic.mockImplementation(async (signedXdr: string) => {
      const tx = TransactionBuilder.fromXdr(signedXdr, NETWORK.passphrase) as Transaction;
      const sales = tx.operations.filter(
        (o): o is Operation.PathPaymentStrictSend => o.type === "pathPaymentStrictSend",
      );
      const markets = sales.map((o) => {
        const hops = [o.sendAsset, ...o.path, o.destAsset].map(assetKey);
        return new Set(hops.slice(1).map((to, i) => `${hops[i]}>${to}`));
      });
      const shared = markets.some((m, i) =>
        markets.slice(i + 1).some((n) => [...m].some((e) => n.has(e))),
      );
      if (shared) {
        throw new SubmitRejectedError(
          { transaction: "tx_failed", operations: ["op_success", "op_under_dest_min"] },
          400,
        );
      }
      for (const o of sales) {
        const k = assetKey(o.sendAsset);
        const h = held.get(k)!;
        held.set(k, { ...h, amount: "0.0000000" });
      }
      for (const o of tx.operations) {
        if (o.type === "changeTrust" && o.limit === "0.0000000") {
          held.delete(assetKey(o.line as Asset));
        }
        if (o.type === "accountMerge") merged = true;
      }
      return receipt();
    });

    const t = tree(finalNode());
    await run(t, d);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
    expect(merged).toBe(true);
    const salesPerTx = d.connector.signed.map(
      (tx) => tx.operations.filter((o) => o.type === "pathPaymentStrictSend").length,
    );
    // both sold, never together, and nothing was rejected on the way
    expect(salesPerTx.reduce((a, b) => a + b, 0)).toBe(2);
    expect(Math.max(...salesPerTx)).toBe(1);
    expect(d.submitClassic).toHaveBeenCalledTimes(d.connector.signed.length);
    // the second sale was quoted after the first one landed
    expect(resolveCreditPaths.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("residue sent to the destination is re-checked at execute", () => {
  const ISSUER = USDC_ISSUER;
  const residue = {
    asset: { kind: "credit" as const, code: "JUNK", issuer: ISSUER },
    amount: "5.0000000",
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    limit: "1000",
  };

  function withDestinationLine(line: Record<string, unknown> | null) {
    const table = accounts();
    table.set(DEST, { seq: 1n, balances: line ? [line] : [] });
    return table;
  }

  beforeEach(() => {
    auditAccount.mockResolvedValue(
      makeAudit({ balances: [...makeAudit().balances, residue], subentryCount: 1 }),
    );
  });

  const send = { sendToDestinationAssetKeys: [`JUNK:${ISSUER}`] };

  it("refuses before signing when the destination dropped its trustline", async () => {
    const table = withDestinationLine(null);
    const d = deps({}, table);
    await expect(run(tree(finalNode([], send)), d)).rejects.toThrow(/no trustline/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("refuses when the line is not authorized or too full", async () => {
    for (const line of [
      {
        asset_type: "credit_alphanum4",
        asset_code: "JUNK",
        asset_issuer: ISSUER,
        balance: "0",
        limit: "100",
        is_authorized: false,
      },
      {
        asset_type: "credit_alphanum4",
        asset_code: "JUNK",
        asset_issuer: ISSUER,
        balance: "98",
        limit: "100",
        is_authorized: true,
      },
    ]) {
      const d = deps({}, withDestinationLine(line));
      await expect(run(tree(finalNode([], send)), d)).rejects.toMatchObject({
        kind: "not_mergeable",
      });
      expect(d.connector.signTransaction).not.toHaveBeenCalled();
    }
  });

  it("pays the residue when the line can take it", async () => {
    const line = {
      asset_type: "credit_alphanum4",
      asset_code: "JUNK",
      asset_issuer: ISSUER,
      balance: "0",
      limit: "100",
      is_authorized: true,
    };
    const d = deps({}, withDestinationLine(line));
    const t = tree(finalNode([], send));
    await run(t, d);
    const ops = d.connector.signed[0]!.operations.map((o) => o.type);
    expect(ops).toContain("payment");
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
  });
});

describe("a merge whose outcome is unknown is looked up before anything is re-signed", () => {
  it("records the hash, and a re-run confirms from the chain without a new signature", async () => {
    const d = deps();
    d.submitClassic.mockImplementationOnce(async () => {
      throw new AmbiguousSubmitError("unknown-outcome", null, "504");
    });
    const t = tree(finalNode());
    await expect(run(t, d)).rejects.toBeInstanceOf(AmbiguousSubmitError);
    const node = t.allNodes.get("final-classic-tx")!;
    const pending = journalFor(node).pending!;
    expect(pending.final).toBe(true);

    node.status = "pending";
    const lookup = vi.fn(async () => ({ status: "success" as const, ledger: 77 }));
    const d2 = deps({ lookupClassicTransaction: lookup });
    await run(t, d2);
    expect(lookup).toHaveBeenCalledWith(pending.hash, pending.maxTime);
    expect(d2.connector.signTransaction).not.toHaveBeenCalled();
    expect(node.status).toBe("confirmed");
    expect(node.executed).toEqual({ txHash: pending.hash, ledger: 77 });
  });

  it("refuses to sign again while the earlier merge can still land", async () => {
    const d = deps();
    d.submitClassic.mockImplementationOnce(async () => {
      throw new AmbiguousSubmitError("abc", 9_999_999_999, "504");
    });
    const t = tree(finalNode());
    await expect(run(t, d)).rejects.toBeInstanceOf(AmbiguousSubmitError);
    const d2 = deps({ lookupClassicTransaction: async () => ({ status: "pending" }) });
    t.allNodes.get("final-classic-tx")!.status = "pending";
    await expect(run(t, d2)).rejects.toMatchObject({ kind: "ambiguous" });
    expect(d2.connector.signTransaction).not.toHaveBeenCalled();
  });
});

describe("landed phases are kept when a later phase fails", () => {
  it("records phase receipts on the node's journal", async () => {
    // an lp share makes the batcher isolate the withdraw into its own phase
    auditAccount.mockResolvedValueOnce(
      makeAudit({
        subentryCount: 1,
        poolShares: [
          {
            poolId: "a".repeat(64),
            poolType: "constant_product",
            shareBalance: "10.0000000",
            totalShares: "100.0000000",
            shareLimit: "1000",
            fee: 30,
            reserves: [
              { asset: { kind: "native" }, amount: "100.0000000" },
              {
                asset: { kind: "credit", code: "USDC", issuer: USDC_ISSUER },
                amount: "50.0000000",
              },
            ],
          },
        ],
      }),
    );
    const d = deps();
    d.submitClassic
      .mockResolvedValueOnce({ txHash: "PHASE0", ledger: 1 })
      .mockRejectedValueOnce(
        new SubmitRejectedError({ transaction: "tx_failed", operations: ["op_no_issuer"] }, 400),
      );
    const t = tree(finalNode());
    await expect(run(t, d)).rejects.toThrow(/op_no_issuer/);
    expect(journalFor(t.allNodes.get("final-classic-tx")!).landedPhases).toEqual([
      { txHash: "PHASE0", ledger: 1 },
    ]);
  });
});

describe("MediatorForward", () => {
  function forwardTree(finalStatus: PlanNode["status"]) {
    const final = finalNode([], { useMediator: true });
    final.status = finalStatus;
    if (finalStatus === "confirmed") final.executed = { txHash: "MERGE", ledger: 1 };
    const forward = {
      id: "mediator-forward",
      kind: "MediatorForward",
      dependencies: ["final-classic-tx"],
      description: "forward",
      status: "pending",
      metadata: {
        kind: "MediatorForward",
        mediatorPublicKey: ATTACKER,
        flowToken: "TOKEN",
        ultimateDestination: DEST,
        memo: { type: "id", value: "12345" },
      },
    } as PlanNode;
    return tree(final, forward);
  }

  it("confirms with the forward's hash and ledger, carries the memo and names the closed account", async () => {
    submitMediatorForward.mockResolvedValue({
      ok: true,
      txHash: "FWD",
      ledger: 4321,
      alreadyDelivered: false,
      flowToken: "TOKEN",
    });
    const table = accounts();
    table.set(ATTACKER, { seq: 1n, balances: [] });
    const t = forwardTree("confirmed");
    await run(t, deps({}, table));
    expect(t.allNodes.get("mediator-forward")!.executed).toEqual({ txHash: "FWD", ledger: 4321 });
    expect(submitMediatorForward.mock.calls[0]![0]).toMatchObject({
      destination: DEST,
      memo: { type: "id", value: "12345" },
      closedAccount: USER,
    });
  });

  it("keeps the token the forward renewed, so a retry forwards under it", async () => {
    submitMediatorForward.mockResolvedValue({
      ok: false,
      error: "horizon 503",
      flowToken: "RENEWED",
    });
    const table = accounts();
    table.set(ATTACKER, { seq: 1n, balances: [] });
    const t = forwardTree("confirmed");
    const persist = vi.fn();
    const d = deps(
      {
        mediatorFlow: { mint: vi.fn(), persist, previous: () => null, forwarded: vi.fn() },
      },
      table,
    );
    await expect(run(t, d)).rejects.toMatchObject({ kind: "forward_pending" });
    const forward = t.allNodes.get("mediator-forward")!;
    expect((forward.metadata as { flowToken: string }).flowToken).toBe("RENEWED");
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ mediatorPublicKey: ATTACKER, flowToken: "RENEWED" }),
    );
  });

  it("fails as forward_pending (never a phantom success) when the forward fails", async () => {
    submitMediatorForward.mockResolvedValue({
      ok: false,
      error: "no native balance",
      flowToken: "TOKEN",
    });
    const table = accounts();
    table.set(ATTACKER, { seq: 1n, balances: [] });
    const t = forwardTree("confirmed");
    await expect(run(t, deps({}, table))).rejects.toMatchObject({ kind: "forward_pending" });
    const node = t.allNodes.get("mediator-forward")!;
    expect(node.status).toBe("failed");
    expect(node.error).toBe("no native balance");
    expect(node.executed).toBeUndefined();
  });

  it("never calls the forward when the merge was skipped", async () => {
    const t = forwardTree("skipped");
    t.allNodes.get("final-classic-tx")!.error = 'Skipped: dependency "x" did not complete: boom';
    await run(t, deps());
    expect(submitMediatorForward).not.toHaveBeenCalled();
    const forward = t.allNodes.get("mediator-forward")!;
    expect(forward.status).toBe("skipped");
    // the forward's own failure names the merge and carries the step that
    // blocked it, never a forward error from a mediator nothing funded
    expect(forward.error).toBe(
      'Skipped: dependency "final-classic-tx" did not complete: Skipped: dependency "x" did not complete: boom',
    );
  });

  it("finds a forward that landed with its reply lost instead of failing on the missing mediator", async () => {
    const t = forwardTree("confirmed");
    const findForward = vi.fn(async () => ({ txHash: "LANDED", ledger: 77 }));
    const d = deps({
      mediatorFlow: {
        mint: vi.fn(),
        persist: vi.fn(),
        previous: () => null,
        forwarded: vi.fn(),
        findForward,
      },
    });
    await run(t, d);
    expect(submitMediatorForward).not.toHaveBeenCalled();
    expect(t.allNodes.get("mediator-forward")!.executed).toEqual({ txHash: "LANDED", ledger: 77 });
    expect(findForward).toHaveBeenCalledWith(ATTACKER, DEST);
  });
});

describe("best-effort held-token drain", () => {
  function drainTree() {
    const drain = {
      id: "drain",
      kind: "TransferAsIs",
      dependencies: [],
      description: "drain",
      status: "simulated",
      metadata: {
        kind: "TransferAsIs",
        asset: { kind: "contract", contractId: HOSTILE_TOKEN },
        amount: 500n,
        destination: DEST,
      },
    } as PlanNode;
    return tree(drain, finalNode(["drain"]));
  }
  const rebuildWith = (make: (account: Account) => Transaction) => async (node: PlanNode) => {
    (node.metadata as { transaction?: Transaction }).transaction = make(new Account(USER, "200"));
  };

  it("skips a token whose transfer reverts, reports it, and still merges", async () => {
    const d = deps({
      rebuildSorobanNode: rebuildWith((a) => transferTx(a, HOSTILE_TOKEN, DEST, 500n)),
    });
    d.submitSoroban.mockRejectedValue(new Error("transfer reverted"));
    const notes: string[] = [];
    const t = drainTree();
    await run(t, d, notes);
    expect(t.allNodes.get("drain")!.status).toBe("skipped");
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
    expect(notes.join(" ")).toMatch(/stays on the closed account/);
  });

  it("never signs a drain whose auth tree smuggles another call, and still merges", async () => {
    const d = deps({
      rebuildSorobanNode: rebuildWith((a) => {
        const args = [addr(USER), addr(DEST), i128(500n)];
        return invokeTx(a, HOSTILE_TOKEN, "transfer", args, [
          sourceAuth(
            inv(HOSTILE_TOKEN, "transfer", args, [
              inv(allowlisted("soroswap", "SoroswapRouter"), "noop", []),
            ]),
          ),
        ]);
      }),
    });
    const t = drainTree();
    await run(t, d);
    expect(t.allNodes.get("drain")!.status).toBe("skipped");
    // only the merge was signed
    expect(d.connector.signed).toHaveLength(1);
    expect(d.submitSoroban).not.toHaveBeenCalled();
  });

  it("never signs a drain whose fee is above the ceiling", async () => {
    const d = deps({
      rebuildSorobanNode: rebuildWith((a) => transferTx(a, HOSTILE_TOKEN, DEST, 500n, "50000000")),
    });
    const t = drainTree();
    await run(t, d);
    expect(t.allNodes.get("drain")!.status).toBe("skipped");
    expect(t.allNodes.get("drain")!.error).toMatch(/over the 0\.2 XLM cap/);
    expect(d.submitSoroban).not.toHaveBeenCalled();
  });
});

describe("RevokeAllowance is guarded and best-effort", () => {
  const token = HOSTILE_TOKEN;
  const spender = allowlisted("soroswap", "SoroswapRouter");
  function revokeTree() {
    const revoke = {
      id: "revoke",
      kind: "RevokeAllowance",
      dependencies: [],
      description: "revoke",
      status: "simulated",
      metadata: { kind: "RevokeAllowance", contractId: token, spender },
    } as PlanNode;
    return tree(revoke, finalNode(["revoke"]));
  }

  it("signs exactly approve(user, spender, 0)", async () => {
    const d = deps({
      rebuildSorobanNode: async (node) => {
        const args = [addr(USER), addr(spender), i128(0n), u32(1000)];
        (node.metadata as { transaction?: Transaction }).transaction = invokeTx(
          new Account(USER, "1"),
          token,
          "approve",
          args,
          [sourceAuth(inv(token, "approve", args))],
        );
      },
    });
    const t = revokeTree();
    await run(t, d);
    expect(t.allNodes.get("revoke")!.status).toBe("confirmed");
  });

  it("skips (never signs) a hostile revoke, reports that the allowance survives the close", async () => {
    const d = deps({
      rebuildSorobanNode: async (node) => {
        const args = [addr(USER), addr(spender), i128(0n), u32(1000)];
        (node.metadata as { transaction?: Transaction }).transaction = invokeTx(
          new Account(USER, "1"),
          token,
          "approve",
          args,
          [
            sourceAuth(
              inv(token, "approve", args, [
                inv(token, "transfer", [addr(USER), addr(ATTACKER), i128(1n)]),
              ]),
            ),
          ],
        );
      },
    });
    const notes: string[] = [];
    const t = revokeTree();
    await run(t, d, notes);
    expect(t.allNodes.get("revoke")!.status).toBe("skipped");
    expect(d.submitSoroban).not.toHaveBeenCalled();
    expect(notes.join(" ")).toMatch(/does not remove it/);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
  });
});

describe("soroban nodes are rebuilt fresh before signing and recover", () => {
  const pool = allowlisted("blend", "BlendPool::");
  function withdrawTree() {
    const node = {
      id: "withdraw",
      kind: "WithdrawBlend",
      dependencies: [],
      description: "withdraw",
      status: "simulated",
      metadata: { kind: "WithdrawBlend", poolId: pool, asset: USDCId(), bucket: "supply" },
    } as PlanNode;
    return { node, t: tree(node) };
  }
  function USDCId() {
    return USDC_SAC;
  }
  // each rebuild loads the account fresh and builds at its next sequence
  function liveRebuild(table: Map<string, FakeAccount>) {
    return vi.fn(async (node: PlanNode) => {
      const acct = new Account(USER, table.get(USER)!.seq.toString());
      const req = {
        address: USDCId(),
        amount: 5n,
        request_type: 1,
      };
      const reqVal = addrMap(req);
      const args = [addr(USER), addr(USER), addr(USER), reqVal];
      (node.metadata as { transaction?: Transaction }).transaction = invokeTx(
        acct,
        pool,
        "submit",
        args,
        [sourceAuth(inv(pool, "submit", args))],
      );
    });
  }

  it("rebuilds once and signs the rebuilt transaction", async () => {
    const table = accounts(300n);
    const rebuild = liveRebuild(table);
    const d = deps({ rebuildSorobanNode: rebuild }, table);
    const { node, t } = withdrawTree();
    await run(t, d);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(d.connector.signed[0]!.sequence).toBe("301");
    expect(node.status).toBe("confirmed");
  });

  it("recovers from tx_bad_seq by rebuilding at the account's new sequence", async () => {
    const table = accounts(300n);
    const d = deps({ rebuildSorobanNode: liveRebuild(table) }, table);
    d.submitSoroban.mockImplementationOnce(async () => {
      table.get(USER)!.seq = 310n;
      throw Object.assign(
        new Error("submitSoroban: sendTransaction returned ERROR; result txBadSeq"),
        {
          resultCode: "txBadSeq",
        },
      );
    });
    const { node, t } = withdrawTree();
    await run(t, d);
    expect(d.connector.signed.map((tx) => tx.sequence)).toEqual(["301", "311"]);
    expect(node.status).toBe("confirmed");
  });

  it("recovers from a stale footprint and from an on-chain exceeded-limit trap", async () => {
    for (const msg of [
      "transaction simulation failed: restorePreamble required",
      'submitSoroban: transaction H failed on-chain: {"value":"scecExceededLimit"}',
    ]) {
      const table = accounts(300n);
      const d = deps({ rebuildSorobanNode: liveRebuild(table) }, table);
      d.submitSoroban.mockRejectedValueOnce(new Error(msg));
      const { node, t } = withdrawTree();
      await run(t, d);
      expect(d.submitSoroban).toHaveBeenCalledTimes(2);
      expect(node.status).toBe("confirmed");
    }
  });

  it("does not retry a genuine revert, and marks the required node failed", async () => {
    const table = accounts(300n);
    const d = deps({ rebuildSorobanNode: liveRebuild(table) }, table);
    d.submitSoroban.mockRejectedValue(new Error("submitSoroban: transaction H failed on-chain"));
    const { node, t } = withdrawTree();
    await expect(run(t, d)).rejects.toThrow(/failed on-chain/);
    expect(d.submitSoroban).toHaveBeenCalledTimes(1);
    expect(node.status).toBe("failed");
  });

  it("stops after the attempt budget on a persistent recoverable failure", async () => {
    const table = accounts(300n);
    const d = deps({ rebuildSorobanNode: liveRebuild(table) }, table);
    d.submitSoroban.mockRejectedValue(new Error("tx_bad_seq"));
    const { t } = withdrawTree();
    await expect(run(t, d)).rejects.toThrow(/tx_bad_seq/);
    expect(d.submitSoroban).toHaveBeenCalledTimes(3);
  });

  it("looks up a submission left pending before signing again", async () => {
    const table = accounts(300n);
    const d = deps({ rebuildSorobanNode: liveRebuild(table) }, table);
    d.submitSoroban.mockImplementationOnce(async () => {
      throw new AmbiguousSubmitError("unknown-outcome", null, "still pending after polling");
    });
    const { node, t } = withdrawTree();
    await expect(run(t, d)).rejects.toMatchObject({ kind: "ambiguous" });
    expect(journalFor(node).pending).not.toBeNull();

    // it landed after all: confirmed from the lookup, nothing re-signed
    node.status = "pending";
    const d2 = deps(
      {
        rebuildSorobanNode: liveRebuild(table),
        lookupSorobanTransaction: async () => ({ status: "success", ledger: 9 }),
      },
      table,
    );
    await run(t, d2);
    expect(d2.connector.signTransaction).not.toHaveBeenCalled();
    expect(node.status).toBe("confirmed");
  });

  it("rebuilds and signs again once the pending submission has expired", async () => {
    const table = accounts(300n);
    const { node, t } = withdrawTree();
    journalFor(node).pending = { hash: "old", maxTime: 1 };
    const d = deps(
      {
        rebuildSorobanNode: liveRebuild(table),
        lookupSorobanTransaction: async () => ({ status: "expired" }),
      },
      table,
    );
    await run(t, d);
    expect(d.connector.signTransaction).toHaveBeenCalledTimes(1);
    expect(node.status).toBe("confirmed");
  });
});

describe("a close can be stopped at a step boundary", () => {
  it("signs nothing once the signal is aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    const d = deps({ signal: stop.signal });
    await expect(run(tree(finalNode()), d)).rejects.toMatchObject({ kind: "interrupted" });
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("finishes the step in flight and signs nothing after it", async () => {
    const stop = new AbortController();
    const drain = {
      id: "drain",
      kind: "TransferAsIs",
      dependencies: [],
      description: "drain",
      status: "simulated",
      metadata: {
        kind: "TransferAsIs",
        asset: { kind: "contract", contractId: HOSTILE_TOKEN },
        amount: 1n,
        destination: DEST,
      },
    } as PlanNode;
    const d = deps({
      signal: stop.signal,
      rebuildSorobanNode: async (node) => {
        (node.metadata as { transaction?: Transaction }).transaction = transferTx(
          new Account(USER, "1"),
          HOSTILE_TOKEN,
          DEST,
          1n,
        );
      },
    });
    d.submitSoroban.mockImplementationOnce(async () => {
      stop.abort();
      return receipt();
    });
    const t = tree(drain, finalNode(["drain"]));
    await expect(run(t, d)).rejects.toMatchObject({ kind: "interrupted" });
    expect(t.allNodes.get("drain")!.status).toBe("confirmed");
    expect(d.connector.signTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("a stop request never strands the balance in the temporary account", () => {
  it("still runs the forward when the stop comes after the merge landed", async () => {
    const stop = new AbortController();
    submitMediatorForward.mockResolvedValue({ ok: true, txHash: "FWD" });
    const table = accounts();
    table.set(ATTACKER, { seq: 1n, balances: [] });
    const final = finalNode([], { useMediator: true });
    final.status = "confirmed";
    final.executed = { txHash: "MERGE", ledger: 1 };
    const forward = {
      id: "mediator-forward",
      kind: "MediatorForward",
      dependencies: ["final-classic-tx"],
      description: "forward",
      status: "pending",
      metadata: {
        kind: "MediatorForward",
        mediatorPublicKey: ATTACKER,
        flowToken: "TOKEN",
        ultimateDestination: DEST,
      },
    } as PlanNode;
    stop.abort();
    const t = tree(final, forward);
    await run(t, deps({ signal: stop.signal }, table));
    expect(forward.status).toBe("confirmed");
    expect(submitMediatorForward).toHaveBeenCalledTimes(1);
  });
});

describe("a best-effort step with an unknown outcome is reported as unknown", () => {
  it("does not claim a token stayed behind when its transfer may have landed", async () => {
    const drain = {
      id: "drain",
      kind: "TransferAsIs",
      dependencies: [],
      description: "drain",
      status: "simulated",
      metadata: {
        kind: "TransferAsIs",
        asset: { kind: "contract", contractId: HOSTILE_TOKEN },
        amount: 1n,
        destination: DEST,
      },
    } as PlanNode;
    const d = deps({
      rebuildSorobanNode: async (node) => {
        (node.metadata as { transaction?: Transaction }).transaction = transferTx(
          new Account(USER, "1"),
          HOSTILE_TOKEN,
          DEST,
          1n,
        );
      },
    });
    d.submitSoroban.mockRejectedValue(
      new AmbiguousSubmitError("DRAINHASH", null, "still pending after polling"),
    );
    const notes: string[] = [];
    await run(tree(drain, finalNode(["drain"])), d, notes);
    expect(notes.join(" ")).toMatch(/submitted as DRAINHASH, but the network has not confirmed/);
    expect(notes.join(" ")).not.toMatch(/was not moved/);
  });
});

describe("wallet refusals are typed", () => {
  it("classifies a wallet rejection as signing", async () => {
    const d = deps();
    d.connector.signTransaction.mockRejectedValueOnce({ code: -4, message: "User declined" });
    const p = run(tree(finalNode()), d);
    await expect(p).rejects.toBeInstanceOf(CloseFailure);
    await expect(p).rejects.toMatchObject({ kind: "signing" });
    await expect(p).rejects.toThrow(/User declined/);
  });
});

describe("a held-token conversion that can't run falls back to sending the token as-is", () => {
  const router = allowlisted("soroswap", "SoroswapRouter");
  function convertTree(useMediator = false) {
    const convert = {
      id: "convert",
      kind: "ConvertSorobanToXLM",
      dependencies: [],
      description: "convert token",
      status: "simulated",
      metadata: {
        kind: "ConvertSorobanToXLM",
        asset: { kind: "contract", contractId: HOSTILE_TOKEN },
        amount: 500n,
      },
    } as PlanNode;
    return tree(convert, finalNode(["convert"], { useMediator }));
  }
  // the router swap the hydration builds, and the guarded transfer for the fallback
  const rebuild = vi.fn(async (node: PlanNode) => {
    const account = new Account(USER, "200");
    const md = node.metadata as { transaction?: Transaction };
    if (node.kind === "TransferAsIs") {
      md.transaction = transferTx(account, HOSTILE_TOKEN, DEST, 500n);
      return;
    }
    const xlm = Asset.native().contractId(NETWORK.passphrase);
    const args = [
      i128(500n),
      i128(1n),
      xdr.ScVal.scvVec([addr(HOSTILE_TOKEN), addr(xlm)]),
      addr(USER),
      nativeToScVal(1_791_000_000n, { type: "u64" }),
    ];
    const pair = soroswapPairFor(NETWORK, HOSTILE_TOKEN, xlm);
    md.transaction = invokeTx(account, router, "swap_exact_tokens_for_tokens", args, [
      sourceAuth(
        inv(router, "swap_exact_tokens_for_tokens", args, [
          inv(HOSTILE_TOKEN, "transfer", [addr(USER), addr(pair), i128(500n)]),
        ]),
      ),
    ]);
  });

  it("sends the token to the destination when the swap reverts, then merges", async () => {
    const d = deps({ rebuildSorobanNode: rebuild });
    d.submitSoroban
      .mockRejectedValueOnce(new Error("submitSoroban: transaction H failed on-chain"))
      .mockResolvedValueOnce({ txHash: "ASIS", ledger: 3 });
    const notes: string[] = [];
    const t = convertTree();
    await run(t, d, notes);
    const fallback = d.connector.signed[1]!;
    expect(fallback.operations[0]!.type).toBe("invokeHostFunction");
    expect(
      (
        fallback.operations[0] as unknown as {
          func: { invokeContract: xdr.InvokeContractArgs };
        }
      ).func.invokeContract.functionName.toString(),
    ).toBe("transfer");
    expect(t.allNodes.get("convert")!.status).toBe("confirmed");
    expect(t.allNodes.get("convert")!.executed).toEqual({ txHash: "ASIS", ledger: 3 });
    expect(notes.join(" ")).toMatch(/sent to your destination as-is/);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
  });

  it("stops before the merge when the token can't be converted or sent", async () => {
    const d = deps({ rebuildSorobanNode: rebuild });
    d.submitSoroban.mockRejectedValue(new Error("submitSoroban: transaction H failed on-chain"));
    const t = convertTree();
    await expect(run(t, d)).rejects.toMatchObject({ kind: "position_open" });
    expect(t.allNodes.get("convert")!.status).toBe("failed");
    expect(d.submitClassic).not.toHaveBeenCalled();
  });

  it("stops before the merge on an exchange close, which can't receive the token", async () => {
    const d = deps({ rebuildSorobanNode: rebuild });
    d.submitSoroban.mockRejectedValue(new Error("submitSoroban: transaction H failed on-chain"));
    const t = convertTree(true);
    await expect(run(t, d)).rejects.toMatchObject({ kind: "position_open" });
    // only the swap was ever signed; no transfer to a shared exchange address
    expect(d.connector.signed).toHaveLength(1);
    expect(d.submitClassic).not.toHaveBeenCalled();
  });
});

describe("plain-object rpc errors keep their message", () => {
  it("puts the rpc's message on the failed node, not [object Object]", async () => {
    const pool = allowlisted("blend", "BlendPool::");
    const node = {
      id: "claim",
      kind: "ClaimBlendEmissions",
      dependencies: [],
      description: "claim",
      status: "simulated",
      metadata: { kind: "ClaimBlendEmissions", poolId: pool, reserveTokenIds: [0] },
    } as unknown as PlanNode;
    const d = deps({
      rebuildSorobanNode: async (n) => {
        const args = [addr(USER), xdr.ScVal.scvVec([u32(0)]), addr(USER)];
        (n.metadata as { transaction?: Transaction }).transaction = invokeTx(
          new Account(USER, "1"),
          pool,
          "claim",
          args,
          [sourceAuth(inv(pool, "claim", args))],
        );
      },
    });
    d.submitSoroban.mockRejectedValue({ code: -32600, message: "transaction too large" });
    await expect(run(tree(node), d)).rejects.toMatchObject({ message: "transaction too large" });
    expect(node.error).toBe("transaction too large");
  });
});

describe("the allowance revoke has a fee ceiling too", () => {
  it("skips a revoke whose resource fee a hostile token inflated, without signing it", async () => {
    const spender = allowlisted("soroswap", "SoroswapRouter");
    const revoke = {
      id: "revoke",
      kind: "RevokeAllowance",
      dependencies: [],
      description: "revoke",
      status: "simulated",
      metadata: { kind: "RevokeAllowance", contractId: HOSTILE_TOKEN, spender },
    } as PlanNode;
    const d = deps({
      rebuildSorobanNode: async (node) => {
        const args = [addr(USER), addr(spender), i128(0n), u32(1000)];
        (node.metadata as { transaction?: Transaction }).transaction = invokeTx(
          new Account(USER, "1"),
          HOSTILE_TOKEN,
          "approve",
          args,
          [sourceAuth(inv(HOSTILE_TOKEN, "approve", args))],
          "90000000",
        );
      },
    });
    const notes: string[] = [];
    const t = tree(revoke, finalNode(["revoke"]));
    await run(t, d, notes);
    expect(revoke.status).toBe("skipped");
    expect(revoke.error).toMatch(/over the 0\.2 XLM cap/);
    expect(d.submitSoroban).not.toHaveBeenCalled();
    // only the merge was signed
    expect(d.connector.signed).toHaveLength(1);
  });
});

function addrMap(req: { address: string; amount: bigint; request_type: number }) {
  // blend's Request struct as the pool reads it, fields in key order
  return xdrVec([
    xdrMap([
      ["address", addr(req.address)],
      ["amount", i128(req.amount)],
      ["request_type", u32(req.request_type)],
    ]),
  ]);
}

function xdrMap(entries: [string, xdr.ScVal][]) {
  return xdr.ScVal.scvMap(
    entries.map(
      ([k, v]) => new xdr.ScMapEntry({ key: nativeToScVal(k, { type: "symbol" }), val: v }),
    ),
  );
}
function xdrVec(items: xdr.ScVal[]) {
  return xdr.ScVal.scvVec(items);
}

// a horizon that also serves its latest ledger, as production's does: the merge
// is timed by it and its claims judged against it
function clockedDeps(
  over: Partial<ExecutorDeps> = {},
  table = accounts(),
  closedAt = 1_900_000_000,
) {
  const ledgers = () => ({
    order: () => ({
      limit: () => ({
        call: async () => ({
          records: [ledgerRecord({ closed_at: new Date(closedAt * 1000).toISOString() })],
        }),
      }),
    }),
  });
  return deps({ horizon: fakeHorizon(table, { ledgers: ledgers as never }), ...over }, table);
}

describe("a close batch is timed by the network's clock, never the browser's", () => {
  it("refuses to sign the merge when horizon serves no latest ledger", async () => {
    const table = accounts();
    const { loadAccount } = fakeHorizon(table);
    const d = deps({ horizon: { loadAccount } as never }, table);
    await expect(run(tree(finalNode()), d)).rejects.toThrow(/latest ledger/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });
});

describe("the merge guard checks what this close really does", () => {
  it("refuses a self-sponsored claimable balance the batch leaves behind (IS_SPONSOR)", async () => {
    // the stored audit counted it as released, but it is not claimable for the
    // whole signing window, so the batch does not claim it
    const closedAt = 1_900_000_000;
    auditAccount.mockResolvedValue(
      makeAudit({
        sponsorship: { numSponsoring: 1, numSponsored: 0, coverable: 1 },
        claimableBalances: [
          {
            id: "00000000aa",
            asset: { kind: "native" },
            amount: "1.0000000",
            sponsor: USER,
            claimants: [USER],
            claimantsRaw: [
              { destination: USER, predicate: { abs_before_epoch: String(closedAt + 60) } },
            ],
            claimableNow: true,
          },
        ],
      }),
    );
    const d = clockedDeps({}, accounts(), closedAt);
    await expect(run(tree(finalNode()), d)).rejects.toThrow(/account_merge blocked: IS_SPONSOR/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("judges the claims at the fee the batch is bid at, as the batch does", async () => {
    // 0.6 XLM spendable pays the new line's 0.5 XLM reserve and two ops at the
    // 100 stroop bid, not at the 0.1 XLM per-op ceiling, so the batch claims the
    // self-sponsored balance and the merge check must count it as claimed
    const EURT_ISSUER = "GAP5LETOV6YIE62YAM56STDANPRDO7ZFDBGSNHJQIYGGKSMOZAHOOS2S";
    const eurt = { kind: "credit" as const, code: "EURT", issuer: EURT_ISSUER };
    // after the claim phase lands: the balance sits on its new line
    const claimed = makeAudit({
      subentryCount: 1,
      balances: [
        {
          asset: { kind: "native" },
          amount: "1.5999800",
          buyingLiabilities: "0.0000000",
          sellingLiabilities: "0.0000000",
        },
        {
          asset: eurt,
          amount: "1.0000000",
          buyingLiabilities: "0.0000000",
          sellingLiabilities: "0.0000000",
          limit: "922337203685.4775807",
          isAuthorized: true,
        },
      ],
    });
    auditAccount.mockResolvedValueOnce(
      makeAudit({
        balances: [
          {
            asset: { kind: "native" },
            amount: "2.1000000",
            buyingLiabilities: "0.0000000",
            sellingLiabilities: "0.0000000",
          },
        ],
        sponsorship: { numSponsoring: 1, numSponsored: 0, coverable: 1 },
        claimableBalances: [
          {
            id: `00000000${"bb".repeat(32)}`,
            asset: eurt,
            amount: "1.0000000",
            sponsor: USER,
            claimants: [USER],
            claimantsRaw: [{ destination: USER, predicate: { unconditional: true } }],
            claimableNow: true,
            issuerAuthRequired: false,
          },
        ],
      }),
    );
    auditAccount.mockResolvedValue(claimed);
    const d = deps();
    const t = tree(finalNode([], { returnToIssuerAssetKeys: [`EURT:${EURT_ISSUER}`] }));
    await expect(run(t, d)).resolves.toBeDefined();
    const signed = d.connector.signed.flatMap((tx) => tx.operations.map((op) => op.type));
    expect(signed).toContain("claimClaimableBalance");
    expect(signed).toContain("accountMerge");
  });

  it("refuses a balance frozen by its issuer (FROZEN_TRUSTLINE), even with consent to return it", async () => {
    auditAccount.mockResolvedValue(
      makeAudit({
        subentryCount: 1,
        balances: [
          ...makeAudit().balances,
          {
            asset: { kind: "credit", code: "USDC", issuer: USDC_ISSUER },
            amount: "5.0000000",
            buyingLiabilities: "0",
            sellingLiabilities: "0",
            limit: "1000",
            isAuthorized: false,
          },
        ],
      }),
    );
    const d = deps();
    const t = tree(finalNode([], { returnToIssuerAssetKeys: [`USDC:${USDC_ISSUER}`] }));
    await expect(run(t, d)).rejects.toThrow(/FROZEN_TRUSTLINE/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("refuses an account whose sequence was bumped past what the network merges (SEQNUM_TOO_FAR)", async () => {
    // the audit ledger is 1000, so core refuses a merge at a sequence of 1001 << 32
    auditAccount.mockResolvedValue(makeAudit({ sequence: ((1001n << 32n) - 1n).toString() }));
    const d = deps();
    await expect(run(tree(finalNode()), d)).rejects.toThrow(/SEQNUM_TOO_FAR/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });
});

describe("the merge is timed by the network's clock", () => {
  it("anchors the batch's time bounds to the latest ledger, read right before building", async () => {
    const closedAt = 1_900_000_000;
    const d = clockedDeps({}, accounts(), closedAt);
    await run(tree(finalNode()), d);
    expect(d.connector.signed[0]!.timeBounds?.maxTime).toBe(String(closedAt + 300));
  });

  it("leaves out a claim that would expire inside the signing window", async () => {
    const closedAt = 1_900_000_000;
    auditAccount.mockResolvedValue(
      makeAudit({
        claimableBalances: [
          {
            id: `00000000${"bb".repeat(32)}`,
            asset: { kind: "native" },
            amount: "1.0000000",
            sponsor: ATTACKER,
            claimants: [USER],
            claimantsRaw: [
              { destination: USER, predicate: { abs_before_epoch: String(closedAt + 60) } },
            ],
            claimableNow: true,
          },
        ],
      }),
    );
    const d = clockedDeps({}, accounts(), closedAt);
    await run(tree(finalNode()), d);
    const ops = d.connector.signed[0]!.operations.map((o) => o.type);
    expect(ops).not.toContain("claimClaimableBalance");
    expect(ops).toContain("accountMerge");
  });
});

describe("a conversion the user did not agree to is never signed", () => {
  const usdc = {
    asset: { kind: "credit" as const, code: "USDC", issuer: USDC_ISSUER },
    amount: "500.0000000",
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    limit: "1000",
  };
  const key = `USDC:${USDC_ISSUER}`;
  const quote = (full: string, ref: string): Map<string, PathResultRef> =>
    new Map([
      [
        key,
        {
          destinationAmount: full,
          path: [],
          sourceAmount: "500",
          reference: { sourceAmount: "0.5000000", destinationAmount: ref },
        },
      ],
    ]);

  beforeEach(() => {
    auditAccount.mockResolvedValue(
      makeAudit({ balances: [...makeAudit().balances, usdc], subentryCount: 1 }),
    );
  });

  it("stops before signing when the market fell below the reviewed price", async () => {
    resolveCreditPaths.mockResolvedValue(quote("1500.0000000", "1.5000000"));
    const d = deps();
    const t = tree(
      finalNode([], {
        reviewedReferenceQuotes: {
          [key]: { sourceAmount: "0.5000000", destinationAmount: "2.0000000" },
        },
      }),
    );
    await expect(run(t, d)).rejects.toMatchObject({ kind: "conversion_refused" });
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("sells at an over-cap price only once the user accepted it", async () => {
    // the full balance gets 1000 where the reference slice says 2000: 50% impact
    resolveCreditPaths.mockResolvedValue(quote("1000.0000000", "2.0000000"));
    const refused = deps();
    await expect(run(tree(finalNode()), refused)).rejects.toMatchObject({
      kind: "conversion_refused",
    });
    expect(refused.connector.signTransaction).not.toHaveBeenCalled();

    const accepted = deps();
    const t = tree(finalNode([], { acceptedPriceImpactAssetKeys: [key] }));
    await run(t, accepted);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
    expect(accepted.connector.signed[0]!.operations.map((o) => o.type)).toContain(
      "pathPaymentStrictSend",
    );
  });

  it("stops before signing when the whole balance now sells below the reviewed quote", async () => {
    // no price impact, but the full-size quote fell from 4 to 3 XLM per USDC
    resolveCreditPaths.mockResolvedValue(quote("1500.0000000", "1.5000000"));
    const d = deps();
    const t = tree(
      finalNode([], {
        reviewedConversionQuotes: {
          [key]: { sourceAmount: "500.0000000", destinationAmount: "2000.0000000" },
        },
      }),
    );
    await expect(run(t, d)).rejects.toMatchObject({ kind: "conversion_refused" });
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("does not send a held token as-is when its swap was refused for its price", async () => {
    const convert = {
      id: "convert",
      kind: "ConvertSorobanToXLM",
      dependencies: [],
      description: "convert",
      status: "simulated",
      metadata: {
        kind: "ConvertSorobanToXLM",
        asset: { kind: "contract", contractId: HOSTILE_TOKEN },
        amount: 500n,
      },
    } as PlanNode;
    const d = deps({
      rebuildSorobanNode: async () => {
        throw new PriceImpactRefusedError("selling the whole balance has a 9.00% price impact");
      },
    });
    const t = tree(convert, finalNode(["convert"]));
    await expect(run(t, d)).rejects.toMatchObject({ kind: "conversion_refused" });
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
    expect(convert.status).toBe("failed");
  });
});

describe("a credit the close claims is quoted with the claim", () => {
  const CB_CC = `00000000${"cc".repeat(32)}`;
  const CB_DD = `00000000${"dd".repeat(32)}`;
  it("converts a claimed balance landing on an empty trustline instead of refusing it", async () => {
    const key = `USDC:${USDC_ISSUER}`;
    const usdcLine = (amount: string) => ({
      asset: { kind: "credit" as const, code: "USDC", issuer: USDC_ISSUER },
      amount,
      buyingLiabilities: "0",
      sellingLiabilities: "0",
      limit: "1000",
    });
    // the claim lands in the first phase; the next audit holds what it paid in
    auditAccount
      .mockResolvedValueOnce(
        makeAudit({
          subentryCount: 1,
          balances: [...makeAudit().balances, usdcLine("0.0000000")],
          claimableBalances: [
            {
              id: CB_CC,
              asset: { kind: "credit", code: "USDC", issuer: USDC_ISSUER },
              amount: "5.0000000",
              sponsor: ATTACKER,
              claimants: [USER],
              claimantsRaw: [{ destination: USER, predicate: { unconditional: true } }],
              claimableNow: true,
            },
          ],
        }),
      )
      .mockResolvedValue(
        makeAudit({ subentryCount: 1, balances: [...makeAudit().balances, usdcLine("5.0000000")] }),
      );
    // the path search quotes only what the account will hold, so the claim must be
    // in the request: the empty line alone has nothing to quote
    resolveCreditPaths.mockImplementation(
      async (
        a: { balances: { amount: string }[] },
        _n: unknown,
        opts?: { claimedBalanceIds?: readonly string[] },
      ) =>
        opts?.claimedBalanceIds?.includes(CB_CC) || a.balances[1]?.amount === "5.0000000"
          ? new Map<string, PathResultRef>([
              [
                key,
                {
                  sourceAmount: "5.0000000",
                  destinationAmount: "10.0000000",
                  path: [],
                  reference: { sourceAmount: "0.5000000", destinationAmount: "1.0000000" },
                },
              ],
            ])
          : new Map(),
    );
    const d = deps();
    const t = tree(finalNode([], { claimableBalanceIds: [CB_CC] }));
    await run(t, d);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
    const ops = d.connector.signed.flatMap((tx) => tx.operations.map((o) => o.type));
    expect(ops).toContain("claimClaimableBalance");
    expect(ops).toContain("pathPaymentStrictSend");
  });

  it("quotes again without a claim the signing window leaves out", async () => {
    const closedAt = 1_900_000_000;
    const key = `USDC:${USDC_ISSUER}`;
    auditAccount.mockResolvedValue(
      makeAudit({
        subentryCount: 1,
        balances: [
          ...makeAudit().balances,
          {
            asset: { kind: "credit", code: "USDC", issuer: USDC_ISSUER },
            amount: "500.0000000",
            buyingLiabilities: "0",
            sellingLiabilities: "0",
            limit: "1000",
          },
        ],
        claimableBalances: [
          {
            id: CB_DD,
            asset: { kind: "credit", code: "USDC", issuer: USDC_ISSUER },
            amount: "5.0000000",
            sponsor: ATTACKER,
            claimants: [USER],
            claimantsRaw: [
              { destination: USER, predicate: { abs_before_epoch: String(closedAt + 60) } },
            ],
            claimableNow: true,
          },
        ],
      }),
    );
    const path = (source: string, dest: string): PathResultRef => ({
      sourceAmount: source,
      destinationAmount: dest,
      path: [],
      reference: { sourceAmount: "0.5000000", destinationAmount: "1.0000000" },
    });
    resolveCreditPaths.mockImplementation(
      async (_a: unknown, _n: unknown, opts?: { claimedBalanceIds?: readonly string[] }) =>
        new Map([
          [
            key,
            opts?.claimedBalanceIds?.includes(CB_DD)
              ? path("505.0000000", "1010.0000000")
              : path("500.0000000", "1000.0000000"),
          ],
        ]),
    );
    const d = clockedDeps({}, accounts(), closedAt);
    const t = tree(finalNode([], { claimableBalanceIds: [CB_DD] }));
    await run(t, d);
    expect(resolveCreditPaths.mock.calls.map((c) => c[2])).toEqual([
      { claimedBalanceIds: [CB_DD] },
      { claimedBalanceIds: [] },
    ]);
    const sale = d.connector.signed
      .flatMap((tx) => tx.operations)
      .find((o) => o.type === "pathPaymentStrictSend") as { sendAmount: string; destMin: string };
    expect(sale).toMatchObject({ sendAmount: "500.0000000", destMin: "990.0000000" });
  });
});

describe("the merge claims only the claimable balances the review listed", () => {
  const CB_EE = `00000000${"ee".repeat(32)}`;
  // a claimable-now xlm balance the execute-time audit finds; the review either
  // listed it or not
  function auditWithCb() {
    return makeAudit({
      claimableBalances: [
        {
          id: CB_EE,
          asset: { kind: "native" },
          amount: "5.0000000",
          sponsor: ATTACKER,
          claimants: [USER],
          claimantsRaw: [{ destination: USER, predicate: { unconditional: true } }],
          claimableNow: true,
        },
      ],
    });
  }

  it("claims none when the reviewed selection is empty, even though one is claimable now", async () => {
    auditAccount.mockResolvedValue(auditWithCb());
    const d = deps();
    const t = tree(finalNode([], { claimableBalanceIds: [] }));
    await run(t, d);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
    const ops = d.connector.signed.flatMap((tx) => tx.operations.map((o) => o.type));
    expect(ops).toContain("accountMerge");
    expect(ops).not.toContain("claimClaimableBalance");
  });

  it("claims the balance once the review listed it", async () => {
    auditAccount.mockResolvedValue(auditWithCb());
    const d = deps();
    const t = tree(finalNode([], { claimableBalanceIds: [CB_EE] }));
    await run(t, d);
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
    const ops = d.connector.signed.flatMap((tx) => tx.operations.map((o) => o.type));
    expect(ops).toContain("claimClaimableBalance");
  });
});

describe("tokens the defi exits paid out are not merged away", () => {
  function exitedTree() {
    const lp = {
      id: "lp",
      kind: "WithdrawSoroswapLp",
      dependencies: [],
      description: "lp",
      status: "confirmed",
      executed: { txHash: "LP", ledger: 1 },
      metadata: {
        kind: "WithdrawSoroswapLp",
        tokenA: HOSTILE_TOKEN,
        tokenB: Asset.native().contractId(NETWORK.passphrase),
        shareBalance: 10n,
      },
    } as PlanNode;
    return tree(lp, finalNode(["lp"]));
  }

  it("refuses the merge while a paid-out token is still on the account", async () => {
    const read = vi.fn<(id: string, holder: string) => Promise<bigint>>(async () => 5n);
    const d = deps({ readTokenBalance: read });
    await expect(run(exitedTree(), d)).rejects.toThrow(/paid out by your DeFi exits/);
    // the native SAC is the account's own XLM, not a token to sweep
    expect(read.mock.calls.map((c) => c[0])).toEqual([HOSTILE_TOKEN]);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("merges once the paid-out token is gone", async () => {
    const t = exitedTree();
    await run(t, deps({ readTokenBalance: async () => 0n }));
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
  });

  it("refuses when it has no way to read the paid-out token", async () => {
    const d = deps();
    await expect(run(exitedTree(), d)).rejects.toThrow(/can't read the tokens/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });
});

describe("soroban fees are capped per kind of step before signing", () => {
  const pool = allowlisted("blend", "BlendPool::");
  function withdraw(fee: string) {
    const node = {
      id: "withdraw",
      kind: "WithdrawBlend",
      dependencies: [],
      description: "withdraw",
      status: "simulated",
      metadata: { kind: "WithdrawBlend", poolId: pool, asset: USDC_SAC, bucket: "supply" },
    } as PlanNode;
    const rebuild = async (n: PlanNode) => {
      const args = [
        addr(USER),
        addr(USER),
        addr(USER),
        addrMap({ address: USDC_SAC, amount: 5n, request_type: 1 }),
      ];
      (n.metadata as { transaction?: Transaction }).transaction = invokeTx(
        new Account(USER, "1"),
        pool,
        "submit",
        args,
        [sourceAuth(inv(pool, "submit", args))],
        fee,
      );
    };
    return { node, rebuild };
  }

  it("refuses a defi exit whose resource fee is over the exit cap, and stops the close", async () => {
    const { node, rebuild } = withdraw("90000000");
    const d = deps({ rebuildSorobanNode: rebuild });
    await expect(run(tree(node, finalNode(["withdraw"])), d)).rejects.toMatchObject({
      kind: "unsafe",
    });
    expect(node.status).toBe("failed");
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("tells the user the fee each signature authorizes before the wallet asks", async () => {
    const { node, rebuild } = withdraw("350000");
    const onSigning = vi.fn();
    const d = deps({ rebuildSorobanNode: rebuild, onSigning });
    await run(tree(node), d);
    expect(onSigning).toHaveBeenCalledWith(node, 350_000n);
  });

  it("bounds the writes a soroswap lp exit may declare, since its pair can hold any token", async () => {
    const router = allowlisted("soroswap", "SoroswapRouter");
    const xlmSac = Asset.native().contractId(NETWORK.passphrase);
    const pair = soroswapPairFor(NETWORK, USDC_SAC, xlmSac);
    const lp = {
      id: "lp",
      kind: "WithdrawSoroswapLp",
      dependencies: [],
      description: "lp",
      status: "simulated",
      metadata: { kind: "WithdrawSoroswapLp", tokenA: USDC_SAC, tokenB: xlmSac, shareBalance: 10n },
    } as PlanNode;
    const d = deps({
      rebuildSorobanNode: async (n) => {
        const args = [
          addr(USDC_SAC),
          addr(xlmSac),
          i128(10n),
          i128(0n),
          i128(0n),
          addr(USER),
          nativeToScVal(1_791_000_000n, { type: "u64" }),
        ];
        (n.metadata as { transaction?: Transaction }).transaction = invokeTx(
          new Account(USER, "1"),
          router,
          "remove_liquidity",
          args,
          [
            sourceAuth(
              inv(router, "remove_liquidity", args, [
                inv(pair, "transfer", [addr(USER), addr(pair), i128(10n)]),
              ]),
            ),
          ],
          "400000",
          { writeBytes: 64_000 },
        );
      },
    });
    await expect(run(tree(lp, finalNode(["lp"])), d)).rejects.toMatchObject({ kind: "unsafe" });
    expect(lp.error).toMatch(/write 64000 bytes/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  describe("an aquarius exit runs pool tokens nobody vetted, so its writes are bounded too", () => {
    const router = allowlisted("aquarius", "AquariusAmmRouter");
    const xlmSac = Asset.native().contractId(NETWORK.passphrase);
    const poolIndex = "ab".repeat(32);
    // the router resolves the pool on chain; any contract shaped like a pool
    const pool = HOSTILE_TOKEN;
    const claimNode = (): PlanNode =>
      ({
        id: "aq-claim",
        kind: "ClaimAquariusRewards",
        dependencies: [],
        description: "claim aquarius rewards",
        status: "simulated",
        metadata: { kind: "ClaimAquariusRewards", poolIndex, tokens: [xlmSac, USDC_SAC] },
      }) as PlanNode;
    // router claim(user, tokens, pool_index) -> pool.claim(user)
    const claimRebuild =
      (fee: bigint, resources: { writeBytes: number; readWriteEntries: number }) =>
      async (n: PlanNode) => {
        const args = [
          addr(USER),
          xdrVec([addr(xlmSac), addr(USDC_SAC)]),
          nativeToScVal(Buffer.from(poolIndex, "hex")),
        ];
        (n.metadata as { transaction?: Transaction }).transaction = invokeTx(
          new Account(USER, "1"),
          router,
          "claim",
          args,
          [sourceAuth(inv(router, "claim", args, [inv(pool, "claim", [addr(USER)])]))],
          (fee + 100_000n).toString(),
          resources,
        );
      };

    it("refuses a claim that declares one byte over the pool-exit write bound", async () => {
      const node = claimNode();
      const d = deps({
        rebuildSorobanNode: claimRebuild(400_000n, { writeBytes: 32_769, readWriteEntries: 1 }),
      });
      await expect(run(tree(node, finalNode(["aq-claim"])), d)).rejects.toMatchObject({
        kind: "unsafe",
      });
      expect(node.error).toMatch(/write 32769 bytes/);
      expect(d.connector.signTransaction).not.toHaveBeenCalled();
    });

    it("refuses a claim that declares 41 read-write entries", async () => {
      const node = claimNode();
      const d = deps({
        rebuildSorobanNode: claimRebuild(400_000n, { writeBytes: 200, readWriteEntries: 41 }),
      });
      await expect(run(tree(node, finalNode(["aq-claim"])), d)).rejects.toMatchObject({
        kind: "unsafe",
      });
      expect(d.connector.signTransaction).not.toHaveBeenCalled();
    });

    it("signs the largest exit measured on mainnet", async () => {
      // 15,993,759 stroops, 10,564 bytes and 12 entries: a router exit measured
      // on mainnet restoring archived reward pages (pool CDRRLX)
      const node = claimNode();
      const d = deps({
        rebuildSorobanNode: claimRebuild(15_993_759n, { writeBytes: 10_564, readWriteEntries: 12 }),
      });
      await run(tree(node), d);
      expect(node.status).toBe("confirmed");
      expect(d.connector.signTransaction).toHaveBeenCalledTimes(1);
    });
  });
});

describe("the BLND trustline step", () => {
  it("signs and submits exactly the change_trust", async () => {
    const blnd = new Asset("BLND", "GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY");
    const node = {
      id: "blnd",
      kind: "AddBlndTrustline",
      dependencies: [],
      description: "open BLND trustline",
      status: "simulated",
      metadata: { kind: "AddBlndTrustline" },
    } as unknown as PlanNode;
    const d = deps({
      rebuildSorobanNode: async (n) => {
        (n.metadata as { transaction?: Transaction }).transaction = new TransactionBuilder(
          new Account(USER, "1"),
          { fee: "100000", networkPassphrase: NETWORK.passphrase },
        )
          .addOperation(Operation.changeTrust({ asset: blnd }))
          .setTimeout(300)
          .build();
      },
    });
    await run(tree(node), d);
    expect(node.status).toBe("confirmed");
    expect(d.connector.signed[0]!.operations[0]!.type).toBe("changeTrust");
  });
});

describe("the trustline a pool exit pays into", () => {
  const usdc = new Asset("USDC", USDC_ISSUER);
  const lineNode = (): PlanNode =>
    ({
      id: "exit-line",
      kind: "AddExitTrustline",
      dependencies: [],
      description: "open USDC trustline",
      status: "simulated",
      metadata: {
        kind: "AddExitTrustline",
        code: "USDC",
        issuer: USDC_ISSUER,
        contractId: USDC_SAC,
      },
    }) as unknown as PlanNode;
  const rebuildAt = (fee: string) => async (n: PlanNode) => {
    (n.metadata as { transaction?: Transaction }).transaction = new TransactionBuilder(
      new Account(USER, "1"),
      { fee, networkPassphrase: NETWORK.passphrase },
    )
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(300)
      .build();
  };

  it("signs and submits exactly the change_trust at a classic bid", async () => {
    const node = lineNode();
    const d = deps({ rebuildSorobanNode: rebuildAt("100000") });
    await run(tree(node), d);
    expect(node.status).toBe("confirmed");
    expect(d.connector.signed[0]!.operations[0]).toMatchObject({ type: "changeTrust" });
  });

  it("refuses a bid over the classic per-op ceiling before signing", async () => {
    const node = lineNode();
    const d = deps({ rebuildSorobanNode: rebuildAt(String(MAX_PER_OP_FEE + 1)) });
    await expect(run(tree(node), d)).rejects.toThrow(/trustline bid over/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });
});

describe("the classic unwind ahead of the repays", () => {
  const usdc = { kind: "credit" as const, code: "USDC", issuer: USDC_ISSUER };
  const offer = {
    id: "77",
    selling: usdc,
    buying: { kind: "native" as const },
    amount: "10.0000000",
    priceR: { n: 3, d: 2 },
  };
  const unwindNode = (): PlanNode =>
    ({
      id: "classic-unwind",
      kind: "ClassicUnwind",
      dependencies: [],
      description: "unwind offers",
      status: "simulated",
      metadata: {
        kind: "ClassicUnwind",
        batches: [{ operations: [], destination: DEST }],
        offerIds: ["77"],
        poolIds: [],
        repayAssets: [USDC_SAC],
        destination: DEST,
      },
    }) as unknown as PlanNode;

  it("cancels the offer that locks the repay asset, re-audits, then lets the close go on", async () => {
    auditAccount
      .mockResolvedValueOnce(makeAudit({ offers: [offer], subentryCount: 1 }))
      .mockResolvedValue(makeAudit());
    const t = tree(unwindNode(), finalNode(["classic-unwind"]));
    const d = deps();
    await run(t, d);
    const cancel = d.connector.signed[0]!;
    expect(cancel.operations).toHaveLength(1);
    expect(cancel.operations[0]).toMatchObject({
      type: "manageSellOffer",
      amount: "0.0000000",
      offerId: "77",
    });
    expect(t.allNodes.get("classic-unwind")!.status).toBe("confirmed");
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
    // the second audit found nothing left to unwind, so only one unwind batch
    expect(d.submitClassic).toHaveBeenCalledTimes(2);
  });

  it("confirms without signing when nothing locks a repay asset any more", async () => {
    const t = tree(unwindNode());
    const d = deps();
    await run(t, d);
    expect(t.allNodes.get("classic-unwind")!.status).toBe("confirmed");
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("cancels only the offers the review listed, not one placed since", async () => {
    // offer 78 sells the repay asset too, but it appeared after the review
    const later = { ...offer, id: "78" };
    auditAccount
      .mockResolvedValueOnce(makeAudit({ offers: [offer, later], subentryCount: 2 }))
      .mockResolvedValue(makeAudit({ offers: [later], subentryCount: 1 }));
    const t = tree(unwindNode());
    const d = deps();
    await run(t, d);
    expect(d.connector.signed).toHaveLength(1);
    expect(
      d.connector.signed[0]!.operations.map((o) => (o as { offerId?: string }).offerId),
    ).toEqual(["77"]);
    expect(t.allNodes.get("classic-unwind")!.status).toBe("confirmed");
  });

  it("stops the close when the unwind fails, so nothing that depends on it runs", async () => {
    auditAccount.mockResolvedValue(makeAudit({ offers: [offer], subentryCount: 1 }));
    const t = tree(unwindNode(), finalNode(["classic-unwind"]));
    const d = deps();
    d.submitClassic.mockRejectedValue(
      new SubmitRejectedError({ transaction: "tx_failed", operations: ["op_malformed"] }, 400),
    );
    await expect(run(t, d)).rejects.toThrow(/op_malformed/);
    expect(t.allNodes.get("classic-unwind")!.status).toBe("failed");
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("pending");
    expect(d.submitClassic).toHaveBeenCalledTimes(1);
  });
});

describe("a payout SAC whose trustline an earlier phase removed", () => {
  it("is treated as the classic asset it is and not read through the token", async () => {
    const withdraw = {
      id: "withdraw",
      kind: "WithdrawBlend",
      dependencies: [],
      description: "withdraw usdc",
      status: "confirmed",
      executed: { txHash: "W", ledger: 1 },
      metadata: {
        kind: "WithdrawBlend",
        poolId: allowlisted("blend", "BlendPool"),
        asset: USDC_SAC,
        bucket: "supply",
      },
    } as PlanNode;
    // the reviewed close removed the USDC line; the live audit no longer has it
    const reviewed = [
      {
        operations: [
          {
            kind: "change_trust_remove",
            summary: "Remove trustline USDC",
            metadata: { asset: { kind: "credit", code: "USDC", issuer: USDC_ISSUER } },
          },
        ],
        destination: DEST,
      },
    ];
    // what the USDC SAC answers on chain for an account without the trustline
    const read = vi.fn(async () => {
      throw new Error("HostError: Error(Contract, #13) trustline entry is missing for account");
    });
    const t = tree(withdraw, finalNode(["withdraw"], { batches: reviewed }));
    await run(t, deps({ readTokenBalance: read }));
    expect(read).not.toHaveBeenCalled();
    expect(t.allNodes.get("final-classic-tx")!.status).toBe("confirmed");
  });
});

describe("a refused conversion found at execute time asks the user", () => {
  it("stops before signing when the token has no route any more", async () => {
    const convert = {
      id: "convert",
      kind: "ConvertSorobanToXLM",
      dependencies: [],
      description: "convert",
      status: "simulated",
      metadata: {
        kind: "ConvertSorobanToXLM",
        asset: { kind: "contract", contractId: HOSTILE_TOKEN },
        amount: 500n,
      },
    } as PlanNode;
    const d = deps({
      rebuildSorobanNode: async () => {
        throw new NoSoroswapRouteError(HOSTILE_TOKEN, ["no pair holds it"]);
      },
    });
    const t = tree(convert, finalNode(["convert"]));
    await expect(run(t, d)).rejects.toMatchObject({ kind: "conversion_refused" });
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
    expect(convert.status).toBe("failed");
    expect(convert.error).toContain(HOSTILE_TOKEN);
  });
});

describe("a backstop emissions claim that can no longer run", () => {
  it("stops before signing and sends the user back to review the forfeit", async () => {
    const pool = allowlisted("blend", "BlendPool");
    const claim = {
      id: "backstop-claim",
      kind: "ClaimBackstopEmissions",
      dependencies: [],
      description: "claim backstop emissions",
      status: "simulated",
      metadata: { kind: "ClaimBackstopEmissions", poolId: pool, accruedEmissions: 7_114_578_242n },
    } as PlanNode;
    const queue = {
      id: "backstop-queue",
      kind: "BackstopQueue",
      dependencies: ["backstop-claim"],
      description: "queue",
      status: "simulated",
      metadata: { kind: "BackstopQueue", poolId: pool, shares: 10n, queueEndsAt: new Date(0) },
    } as PlanNode;
    const d = deps({
      rebuildSorobanNode: async (n) => {
        if (n.kind === "ClaimBackstopEmissions") {
          throw new BackstopEmissionsClaimError(
            new BackstopClaimUnavailableError(pool, "CBACKSTOP", 7_114_578_242n, "VM call trapped"),
          );
        }
        throw new Error("the queue must not be built");
      },
    });
    const p = run(tree(claim, queue), d);
    await expect(p).rejects.toMatchObject({ kind: "claim_unavailable" });
    await expect(p).rejects.toThrow(/711\.4578242 BLND/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
    expect(claim.status).toBe("failed");
    expect(queue.status).toBe("simulated");
  });
});

describe("the execute-time re-batch is bid at the real fee", () => {
  it("keeps the close marker on a small account the 0.1 XLM per-op ceiling would refuse it", async () => {
    // 1.6 XLM: one free base reserve after the merge's fees at 100 stroops per
    // op, but not at the 1,000,000 stroop ceiling
    auditAccount.mockResolvedValue(
      makeAudit({
        balances: [
          {
            asset: { kind: "native" },
            amount: "1.6000000",
            buyingLiabilities: "0",
            sellingLiabilities: "0",
          },
        ],
      }),
    );
    const d = deps();
    await run(tree(finalNode()), d);
    expect(d.connector.signed[0]!.operations.map((o) => o.type)).toEqual([
      "manageData",
      "manageData",
      "accountMerge",
    ]);
  });
});

describe("an aquarius gauge claim runs on the pool the router resolved", () => {
  // standard pools are permissionless and not on the allow-list; the claim's
  // build records the pool the pinned router listed for its tokens and index
  const pool = HOSTILE_TOKEN;
  const xlmSac = Asset.native().contractId(NETWORK.passphrase);
  const gaugeNode = (): PlanNode =>
    ({
      id: "gauge",
      kind: "ClaimAquariusGaugeRewards",
      dependencies: [],
      description: "claim gauge rewards",
      status: "simulated",
      metadata: {
        kind: "ClaimAquariusGaugeRewards",
        poolAddress: pool,
        tokens: [xlmSac, USDC_SAC],
        poolIndex: "ab".repeat(32),
        rewards: [{ token: xlmSac, amount: 108_996_593n }],
      },
    }) as PlanNode;
  const rebuild =
    (
      routerPool: string | undefined,
      fee: bigint,
      resources: { writeBytes: number; readWriteEntries: number },
    ) =>
    async (n: PlanNode) => {
      const md = n.metadata as { transaction?: Transaction; routerPool?: string };
      if (routerPool !== undefined) md.routerPool = routerPool;
      md.transaction = invokeTx(
        new Account(USER, "1"),
        pool,
        "gauges_claim",
        [addr(USER)],
        [sourceAuth(inv(pool, "gauges_claim", [addr(USER)]))],
        (fee + 100_000n).toString(),
        resources,
      );
    };

  it("signs the claim measured on mainnet", async () => {
    // pool CCNXGPE4..., 2026-10-08: 1,694,330 stroops, 1,532 bytes, 6 entries
    const node = gaugeNode();
    const d = deps({
      rebuildSorobanNode: rebuild(pool, 1_694_330n, { writeBytes: 1_532, readWriteEntries: 6 }),
    });
    await run(tree(node), d);
    expect(node.status).toBe("confirmed");
    expect(d.connector.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses a pool the router did not resolve, as off the allow-list", async () => {
    const node = gaugeNode();
    const d = deps({
      rebuildSorobanNode: rebuild(undefined, 1_694_330n, {
        writeBytes: 1_532,
        readWriteEntries: 6,
      }),
    });
    await expect(run(tree(node, finalNode(["gauge"])), d)).rejects.toMatchObject({
      kind: "unsafe",
    });
    expect(node.error).toMatch(/not on MAINNET_ALLOWLIST|not on TESTNET_ALLOWLIST/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });

  it("bounds the writes like any exit through a permissionless pool", async () => {
    const node = gaugeNode();
    const d = deps({
      rebuildSorobanNode: rebuild(pool, 400_000n, { writeBytes: 32_769, readWriteEntries: 1 }),
    });
    await expect(run(tree(node, finalNode(["gauge"])), d)).rejects.toMatchObject({
      kind: "unsafe",
    });
    expect(node.error).toMatch(/write 32769 bytes/);
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
  });
});
