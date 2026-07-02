import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AccountNotFoundError } from "@/lib/stellar/account-audit";
import type { NetworkConfig } from "@/lib/config/networks";

// The FinalClassicTx branch performs three live horizon reads (auditAccount,
// resolveCreditPaths, and the per-batch loadAccount) AFTER the soroban exits
// have already confirmed on-chain. A transient horizon 5xx must NOT abort the
// merge, the reads are pure/idempotent, so the executor rides out the blip with
// a bounded retry. A deterministic answer (AccountNotFoundError / 4xx) is fatal
// and must fail fast without wasting retries. These tests lock in both.

const auditAccount = vi.fn();
const resolveCreditPaths = vi.fn();
const batchClassicDemolition = vi.fn();
const buildClassicTransaction = vi.fn();

vi.mock("@/lib/stellar/account-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/account-audit")>(
    "@/lib/stellar/account-audit",
  );
  return {
    ...actual,
    auditAccount: (...args: unknown[]) => auditAccount(...args),
  };
});

vi.mock("@/lib/stellar/path-finder", () => ({
  resolveCreditPaths: (...args: unknown[]) => resolveCreditPaths(...args),
}));

vi.mock("@/lib/plan/classic-batcher", () => ({
  batchClassicDemolition: (...args: unknown[]) => batchClassicDemolition(...args),
  // the merge guard calls this against fresh state; MERGEABLE_AUDIT has no
  // credit balances, so no credit is unroutable
  unroutableCredits: () => [],
}));

vi.mock("@/lib/stellar/classic-builder", () => ({
  buildClassicTransaction: (...args: unknown[]) => buildClassicTransaction(...args),
}));

// imported AFTER the mocks are registered so the executor picks them up
import { executePlanTreeOnChain } from "@/lib/orchestrator/executor";
import type { ExecutorDeps } from "@/lib/orchestrator/executor";
import type { PlanTree } from "@/lib/plan/tree";

const NETWORK = {
  id: "mainnet",
  passphrase: "Public Global Stellar Network ; September 2015",
} as unknown as NetworkConfig;

// a fresh-state audit that passes the executor's execute-time merge guard
// (not auth-immutable, sponsors nothing foreign, no unroutable credit balances)
const MERGEABLE_AUDIT = {
  balances: [],
  flags: { authImmutable: false },
  sponsorship: { numSponsoring: 0, coverable: 0 },
};

function makeFinalClassicTree() {
  const node = {
    id: "final",
    kind: "FinalClassicTx" as const,
    dependencies: [] as string[],
    description: "close account",
    status: "ready",
    metadata: {
      kind: "FinalClassicTx" as const,
      batches: [],
      destination: "GDEST",
      useMediator: false,
    },
  };
  return {
    node,
    tree: {
      rootNodes: [node],
      allNodes: new Map([[node.id, node]]),
    } as unknown as PlanTree,
  };
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    network: NETWORK,
    connector: {
      signTransaction: vi.fn(async () => ({ signedXdr: "SIGNED" })),
    } as never,
    horizon: {
      loadAccount: vi.fn(async () => ({ accountId: () => "GUSER" })),
    } as never,
    submitClassic: vi.fn(async () => ({ txHash: "HASH", ledger: 42 })),
    submitSoroban: vi.fn(async () => ({ txHash: "HASH", ledger: 42 })),
    ...overrides,
  };
}

function horizon5xx(): Error {
  const err = new Error("Bad Gateway") as Error & { response: { status: number } };
  err.response = { status: 502 };
  return err;
}

describe("executePlanTreeOnChain, horizon retry on FinalClassicTx prep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // healthy defaults; individual tests override auditAccount to inject failures
    auditAccount.mockResolvedValue(MERGEABLE_AUDIT);
    resolveCreditPaths.mockResolvedValue(new Map());
    batchClassicDemolition.mockReturnValue([{ ops: [] }]);
    buildClassicTransaction.mockReturnValue({ transaction: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient horizon 5xx during merge prep and still completes", async () => {
    // first two auditAccount calls blip, third succeeds
    auditAccount
      .mockRejectedValueOnce(horizon5xx())
      .mockRejectedValueOnce(horizon5xx())
      .mockResolvedValueOnce(MERGEABLE_AUDIT);

    const { tree } = makeFinalClassicTree();
    const deps = makeDeps();

    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    // drain the backoff sleeps (300ms, 600ms)
    await vi.runAllTimersAsync();
    const output = await promise;

    expect(auditAccount).toHaveBeenCalledTimes(3);
    expect(output.receipts["final"]).toEqual({ txHash: "HASH", ledger: 42 });
    expect(tree.allNodes.get("final")!.status).toBe("confirmed");
    expect(deps.submitClassic).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry AccountNotFoundError, fails fast with no wasted attempts", async () => {
    auditAccount.mockRejectedValue(new AccountNotFoundError("GUSER"));

    const { tree } = makeFinalClassicTree();
    const deps = makeDeps();

    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    // attach the rejection expectation before draining timers so the rejection
    // is always handled (avoids a dangling unhandled-rejection warning)
    const settled = expect(promise).rejects.toBeInstanceOf(AccountNotFoundError);
    await vi.runAllTimersAsync();
    await settled;
    expect(auditAccount).toHaveBeenCalledTimes(1);
    expect(deps.submitClassic).not.toHaveBeenCalled();
  });

  it("does NOT retry a deterministic 4xx, fails fast", async () => {
    const err = new Error("Bad Request") as Error & { response: { status: number } };
    err.response = { status: 400 };
    auditAccount.mockRejectedValue(err);

    const { tree } = makeFinalClassicTree();
    const deps = makeDeps();

    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    const settled = expect(promise).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await settled;
    expect(auditAccount).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries on a persistent 5xx", async () => {
    auditAccount.mockRejectedValue(horizon5xx());

    const { tree } = makeFinalClassicTree();
    const deps = makeDeps();

    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    const settled = expect(promise).rejects.toThrow(/Bad Gateway/);
    await vi.runAllTimersAsync();
    await settled;
    expect(auditAccount).toHaveBeenCalledTimes(3);
    expect(deps.submitClassic).not.toHaveBeenCalled();
  });

  it("refuses to build/sign the merge when fresh state is no longer mergeable", async () => {
    // between preview and execute the account became auth-immutable; the merge
    // guard must throw BEFORE anything is signed, not commit a doomed batch.
    auditAccount.mockResolvedValue({
      balances: [],
      flags: { authImmutable: true },
      sponsorship: { numSponsoring: 0, coverable: 0 },
    });

    const { tree } = makeFinalClassicTree();
    const deps = makeDeps();

    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    const settled = expect(promise).rejects.toThrow(/account_merge blocked: AUTH_IMMUTABLE/);
    await vi.runAllTimersAsync();
    await settled;
    expect(deps.connector.signTransaction).not.toHaveBeenCalled();
    expect(deps.submitClassic).not.toHaveBeenCalled();
  });
});

describe("executePlanTreeOnChain, merge fee/reprice retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    auditAccount.mockResolvedValue(MERGEABLE_AUDIT);
    resolveCreditPaths.mockResolvedValue(new Map());
    batchClassicDemolition.mockReturnValue([{ ops: [] }]);
    buildClassicTransaction.mockReturnValue({ transaction: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries with a higher fee on tx_insufficient_fee, then succeeds", async () => {
    const deps = makeDeps();
    (deps.submitClassic as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new Error('submitClassic rejected: {"transaction":"tx_insufficient_fee"}'),
      )
      .mockResolvedValueOnce({ txHash: "HASH2", ledger: 43 });

    const { tree } = makeFinalClassicTree();
    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    await vi.runAllTimersAsync();
    const output = await promise;

    // re-audited on retry, and the second build bid a strictly higher fee
    expect(auditAccount).toHaveBeenCalledTimes(2);
    const fees = (buildClassicTransaction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3]);
    expect(fees[1]).toBeGreaterThan(fees[0]);
    expect(output.receipts["final"]).toEqual({ txHash: "HASH2", ledger: 43 });
  });

  it("retries on op_under_dest_min (re-resolving paths) without changing the fee", async () => {
    const deps = makeDeps();
    (deps.submitClassic as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new Error('submitClassic rejected: {"operations":["op_under_dest_min"]}'),
      )
      .mockResolvedValueOnce({ txHash: "HASH2", ledger: 44 });

    const { tree } = makeFinalClassicTree();
    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    await vi.runAllTimersAsync();
    await promise;

    // paths re-resolved on the retry; fee held steady (price, not congestion)
    expect(resolveCreditPaths).toHaveBeenCalledTimes(2);
    const fees = (buildClassicTransaction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3]);
    expect(fees[1]).toBe(fees[0]);
  });

  it("does NOT retry a deterministic rejection (tx_bad_seq), fails fast", async () => {
    const deps = makeDeps();
    (deps.submitClassic as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('submitClassic rejected: {"transaction":"tx_bad_seq"}'),
    );

    const { tree } = makeFinalClassicTree();
    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    const settled = expect(promise).rejects.toThrow(/tx_bad_seq/);
    await vi.runAllTimersAsync();
    await settled;
    expect(deps.submitClassic).toHaveBeenCalledTimes(1);
    expect(auditAccount).toHaveBeenCalledTimes(1);
  });

  it("bids a surge-aware fee from feeStats on the first attempt", async () => {
    const deps = makeDeps({
      horizon: {
        loadAccount: vi.fn(async () => ({ accountId: () => "GUSER" })),
        feeStats: vi.fn(async () => ({ max_fee: { p90: "5000" } })),
      } as never,
    });

    const { tree } = makeFinalClassicTree();
    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    await vi.runAllTimersAsync();
    await promise;

    const firstFee = (buildClassicTransaction as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(firstFee).toBe(5000);
  });

  it("gives up after MAX attempts on a persistent fee rejection", async () => {
    const deps = makeDeps();
    (deps.submitClassic as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('submitClassic rejected: {"transaction":"tx_insufficient_fee"}'),
    );

    const { tree } = makeFinalClassicTree();
    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    const settled = expect(promise).rejects.toThrow(/tx_insufficient_fee/);
    await vi.runAllTimersAsync();
    await settled;
    // MAX_MERGE_ATTEMPTS = 3
    expect(deps.submitClassic).toHaveBeenCalledTimes(3);
  });
});
