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
import { PriceImpactRefusedError } from "@/lib/plan/hydration";
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
  type ConfirmationReceipt,
  type ExecutorDeps,
} from "@/lib/orchestrator/executor";
import {
  AmbiguousSubmitError,
  CloseFailure,
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
    // the merge really merges into the destination
    const merge = d.connector.signed[0]!;
    expect(merge.operations[0]).toMatchObject({ type: "accountMerge", destination: DEST });
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
            fee_charged: { p90: "6970" },
            max_fee: { p90: "1000000" },
          })) as never,
        }),
      },
      table,
    );
    await run(tree(finalNode()), d);
    // a single-op merge at 6970 stroops per op, not the 0.1 XLM cap
    expect(d.connector.signed[0]!.fee).toBe("6970");
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
          feeStats: vi.fn(async () => ({ fee_charged: { p90: "800000" } })) as never,
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
          feeStats: vi.fn(async () => ({ fee_charged: { p90: "20000" } })) as never,
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
    expect(d.connector.signed.map((tx) => tx.fee)).toEqual(["20000", "100"]);
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
    expect(d.connector.signed.map((tx) => tx.fee)).toEqual(["100", "300"]);
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

describe("conversions that share a market", () => {
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
    expect(t.allNodes.get("mediator-forward")!.status).toBe("skipped");
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
            predicate: [
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
            id: "00000000bb",
            asset: { kind: "native" },
            amount: "1.0000000",
            sponsor: ATTACKER,
            claimants: [USER],
            predicate: [
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
