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
const submitMediatorForward = vi.fn();

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

vi.mock("@/lib/mediator/forward", () => ({
  submitMediatorForward: (...args: unknown[]) => submitMediatorForward(...args),
}));

// the transfer-guard is exhaustively tested on its own; here we control it to
// exercise the executor's best-effort SKIP behavior for a held-token drain.
const assertSafeTransferInvocation = vi.fn();
vi.mock("@/lib/soroban/transfer-guard", () => ({
  assertSafeTransferInvocation: (...args: unknown[]) => assertSafeTransferInvocation(...args),
  UnsafeTransferError: class UnsafeTransferError extends Error {},
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

  it("blocks the merge when the Soroban re-probe still finds an open position (SEC-10)", async () => {
    auditAccount.mockResolvedValue(MERGEABLE_AUDIT);
    const { tree } = makeFinalClassicTree();
    const deps = makeDeps({
      reprobeSorobanPositions: async () =>
        ({
          blend: [{ poolId: "P" }],
          backstop: [],
          aquarius: [],
          soroswap: [],
          fxdao: [],
          errors: [],
        }) as never,
    });

    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    const settled = expect(promise).rejects.toThrow(/Soroban DeFi position\(s\) still open/);
    await vi.runAllTimersAsync();
    await settled;
    expect(deps.submitClassic).not.toHaveBeenCalled();
  });

  it("blocks the merge when the Soroban re-probe itself fails (fail-closed)", async () => {
    auditAccount.mockResolvedValue(MERGEABLE_AUDIT);
    const { tree } = makeFinalClassicTree();
    const deps = makeDeps({
      reprobeSorobanPositions: async () => {
        throw new Error("discovery RPC unavailable");
      },
    });

    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    const settled = expect(promise).rejects.toThrow(/discovery RPC unavailable/);
    await vi.runAllTimersAsync();
    await settled;
    expect(deps.submitClassic).not.toHaveBeenCalled();
  });

  it("blocks the merge when the re-probe cannot confirm a protocol (empty arrays + errors, fail-closed)", async () => {
    // The real failure mode: getPositions uses allSettled, so a rate-limited /
    // timed-out protocol probe returns an EMPTY array for that protocol and
    // records the failure in errors[]. An empty-array-with-error must NOT read
    // as "no positions" — otherwise an undiscovered position is merged around.
    auditAccount.mockResolvedValue(MERGEABLE_AUDIT);
    const { tree } = makeFinalClassicTree();
    const deps = makeDeps({
      reprobeSorobanPositions: async () =>
        ({
          blend: [],
          backstop: [],
          aquarius: [],
          soroswap: [],
          fxdao: [],
          errors: [{ protocol: "blend", message: "429 Too Many Requests" }],
        }) as never,
    });

    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    const settled = expect(promise).rejects.toThrow(/could not confirm/i);
    await vi.runAllTimersAsync();
    await settled;
    expect(deps.submitClassic).not.toHaveBeenCalled();
  });

  it("proceeds with the merge when the Soroban re-probe finds nothing open", async () => {
    auditAccount.mockResolvedValue(MERGEABLE_AUDIT);
    const { tree } = makeFinalClassicTree();
    const deps = makeDeps({
      reprobeSorobanPositions: async () =>
        ({ blend: [], backstop: [], aquarius: [], soroswap: [], fxdao: [], errors: [] }) as never,
    });

    const promise = executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );
    await vi.runAllTimersAsync();
    await promise;
    expect(tree.allNodes.get("final")!.status).toBe("confirmed");
    expect(deps.submitClassic).toHaveBeenCalledTimes(1);
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

  it("recovers from a stale sequence (tx_bad_seq): re-audits, rebuilds in-sequence, succeeds", async () => {
    const deps = makeDeps();
    // the account's sequence advanced between build and submit; the retry reloads
    // the account (fresh sequence) and rebuilds the merge so it is in-sequence.
    (deps.submitClassic as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('submitClassic rejected: {"transaction":"tx_bad_seq"}'))
      .mockResolvedValueOnce({ txHash: "HASH2", ledger: 45 });

    const { tree } = makeFinalClassicTree();
    const promise = executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps);
    await vi.runAllTimersAsync();
    const output = await promise;

    // re-audited on the retry (fresh sequence); fee held steady (not congestion)
    expect(auditAccount).toHaveBeenCalledTimes(2);
    const fees = (buildClassicTransaction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3]);
    expect(fees[1]).toBe(fees[0]);
    expect(output.receipts["final"]).toEqual({ txHash: "HASH2", ledger: 45 });
  });

  it("gives up after MAX attempts on a persistent tx_bad_seq (bounded, fails loudly)", async () => {
    const deps = makeDeps();
    (deps.submitClassic as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('submitClassic rejected: {"transaction":"tx_bad_seq"}'),
    );

    const { tree } = makeFinalClassicTree();
    const promise = executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps);
    const settled = expect(promise).rejects.toThrow(/tx_bad_seq/);
    await vi.runAllTimersAsync();
    await settled;
    // a genuine (non-race) bad-seq isn't cleared by rebuilding, so the bounded
    // retry exhausts MAX_MERGE_ATTEMPTS and then fails rather than looping.
    expect(deps.submitClassic).toHaveBeenCalledTimes(3);
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

// The MediatorForward hop is the ONLY leg that reaches the exchange, and a
// swallowed forward failure would falsely report the CEX deposit as delivered.
// These lock in that the branch confirms only on a real forward and throws (never
// returns a phantom success) on failure, carrying the CEX memo through verbatim.
function makeMediatorForwardTree() {
  const node = {
    id: "forward",
    kind: "MediatorForward" as const,
    dependencies: [] as string[],
    description: "forward to exchange",
    status: "ready",
    metadata: {
      kind: "MediatorForward" as const,
      mediatorPublicKey: "GMEDIATOR",
      flowToken: "FLOWTOKEN",
      ultimateDestination: "GEXCHANGE",
      memo: { type: "id" as const, value: "12345" },
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

describe("executePlanTreeOnChain, MediatorForward honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirms the forward with the returned hash and passes the CEX memo through", async () => {
    submitMediatorForward.mockResolvedValue({ ok: true, txHash: "FWDHASH" });
    const { tree } = makeMediatorForwardTree();
    const deps = makeDeps();

    const output = await executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );

    expect(tree.allNodes.get("forward")!.status).toBe("confirmed");
    expect(output.receipts["forward"]).toEqual({ txHash: "FWDHASH", ledger: 0 });
    expect(submitMediatorForward).toHaveBeenCalledTimes(1);
    const input = submitMediatorForward.mock.calls[0]![0] as {
      memo?: unknown;
      destination?: string;
    };
    // the full memo (type + value) must reach the exchange verbatim on this hop
    expect(input.memo).toEqual({ type: "id", value: "12345" });
    expect(input.destination).toBe("GEXCHANGE");
  });

  it("marks the node failed and rejects (never phantom success) when the forward fails", async () => {
    submitMediatorForward.mockResolvedValue({ ok: false, error: "no native balance" });
    const { tree } = makeMediatorForwardTree();
    const deps = makeDeps();

    await expect(
      executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps),
    ).rejects.toThrow(/MediatorForward failed: no native balance/);

    expect(tree.allNodes.get("forward")!.status).toBe("failed");
    expect(tree.allNodes.get("forward")!.error).toBe("no native balance");
    // no receipt is recorded for a failed forward: a failed hop leaves no
    // confirmed trace (belt-and-suspenders on the never-phantom-success guarantee)
    expect(tree.allNodes.get("forward")!.executed).toBeUndefined();
  });
});

// A discovered standalone SEP-41 token is airdrop-reachable (attacker-controlled),
// so its auto-drain must be BEST-EFFORT: a failing or unsafe drain is SKIPPED, and
// because a skipped dependency still lets the merge proceed, one un-drainable token
// can never wedge the close. These lock in that fail-open-for-the-close behavior.
function makeDrainThenMergeTree() {
  const drain = {
    id: "drain",
    kind: "TransferAsIs" as const,
    dependencies: [] as string[],
    status: "pending",
    metadata: {
      kind: "TransferAsIs" as const,
      asset: {
        kind: "contract" as const,
        contractId: "CDRAINTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
      },
      amount: 500n,
      destination: "GDEST",
      // dummy tx: the guard and the connector are mocked, so it is never inspected
      transaction: {} as never,
    },
  };
  const final = {
    id: "final",
    kind: "FinalClassicTx" as const,
    dependencies: ["drain"],
    status: "pending",
    metadata: {
      kind: "FinalClassicTx" as const,
      batches: [],
      destination: "GDEST",
      useMediator: false,
    },
  };
  return {
    tree: {
      rootNodes: [drain],
      allNodes: new Map<string, typeof drain | typeof final>([
        [drain.id, drain],
        [final.id, final],
      ]),
    } as unknown as PlanTree,
  };
}

describe("executePlanTreeOnChain, held-token drain is best-effort (never wedges the close)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditAccount.mockResolvedValue(MERGEABLE_AUDIT);
    resolveCreditPaths.mockResolvedValue(new Map());
    batchClassicDemolition.mockReturnValue([{ ops: [] }]);
    buildClassicTransaction.mockReturnValue({ transaction: {} });
    // default: the guard passes (no-op)
    assertSafeTransferInvocation.mockReset();
  });

  it("skips a drain whose transfer reverts (griefing token) and still completes the merge", async () => {
    const deps = makeDeps();
    (deps.submitSoroban as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("transfer reverted"),
    );
    const { tree } = makeDrainThenMergeTree();

    await executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps);

    // the drain is SKIPPED (not failed), so the merge's dependency check passes
    expect(tree.allNodes.get("drain")!.status).toBe("skipped");
    expect(tree.allNodes.get("drain")!.error).toMatch(/Token drain skipped/);
    expect(tree.allNodes.get("final")!.status).toBe("confirmed");
    expect(deps.submitClassic).toHaveBeenCalledTimes(1);
  });

  it("skips a drain whose auth tree fails the guard (hostile token) WITHOUT signing it, and still merges", async () => {
    assertSafeTransferInvocation.mockImplementation(() => {
      throw new Error("auth[0] carries 1 sub-invocation(s)");
    });
    const deps = makeDeps();
    const { tree } = makeDrainThenMergeTree();

    await executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps);

    expect(tree.allNodes.get("drain")!.status).toBe("skipped");
    // the unsafe transfer was never submitted (guard rejected it before signing)
    expect(deps.submitSoroban).not.toHaveBeenCalled();
    expect(tree.allNodes.get("final")!.status).toBe("confirmed");
    expect(deps.submitClassic).toHaveBeenCalledTimes(1);
  });
});

// A single RevokeAllowance node: a Soroban step that is allow-list-exempt (it
// targets the user's own token contract), so it exercises the generic Soroban
// submit path without needing the DeFi allow-list mocked.
function makeRevokeTree() {
  const revoke = {
    id: "revoke",
    kind: "RevokeAllowance" as const,
    dependencies: [] as string[],
    status: "pending",
    metadata: {
      kind: "RevokeAllowance" as const,
      contractId: "CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
      spender: "CSPENDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
      // dummy pre-built tx (the preview build); the connector is mocked so it is
      // never inspected. rebuildSorobanNode is mocked, so it stays in place.
      transaction: {} as never,
    },
  };
  return {
    revoke,
    tree: {
      rootNodes: [revoke],
      allNodes: new Map([[revoke.id, revoke]]),
    } as unknown as PlanTree,
  };
}

describe("executePlanTreeOnChain, Soroban nodes are rebuilt fresh before signing + recover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds the node against fresh state immediately before signing (A1)", async () => {
    const rebuildSorobanNode = vi.fn(async () => {});
    const deps = makeDeps({ rebuildSorobanNode });
    const { tree, revoke } = makeRevokeTree();

    await executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps);

    // the fresh rebuild ran once, for THIS node, before the single submit
    expect(rebuildSorobanNode).toHaveBeenCalledTimes(1);
    expect(rebuildSorobanNode).toHaveBeenCalledWith(revoke, "GUSER");
    expect(deps.submitSoroban).toHaveBeenCalledTimes(1);
    expect(revoke.status).toBe("confirmed");
  });

  it("recovers from a stale sequence (tx_bad_seq) by rebuilding and retrying (A2)", async () => {
    const rebuildSorobanNode = vi.fn(async () => {});
    const deps = makeDeps({ rebuildSorobanNode });
    (deps.submitSoroban as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("submitSoroban: sendTransaction returned tx_bad_seq"))
      .mockResolvedValueOnce({ txHash: "OK", ledger: 9 });
    const { tree, revoke } = makeRevokeTree();

    const output = await executePlanTreeOnChain(
      { publicKey: "GUSER", tree, previousReceipts: {} },
      deps,
    );

    // rebuilt again on the retry (fresh sequence), then submitted successfully
    expect(rebuildSorobanNode).toHaveBeenCalledTimes(2);
    expect(deps.submitSoroban).toHaveBeenCalledTimes(2);
    expect(revoke.status).toBe("confirmed");
    expect(output.receipts["revoke"]).toEqual({ txHash: "OK", ledger: 9 });
  });

  it("recovers from a changed/expired footprint by re-simulating and retrying (A3)", async () => {
    const rebuildSorobanNode = vi.fn(async () => {});
    const deps = makeDeps({ rebuildSorobanNode });
    (deps.submitSoroban as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("transaction simulation failed: restorePreamble required"))
      .mockResolvedValueOnce({ txHash: "OK2", ledger: 10 });
    const { tree, revoke } = makeRevokeTree();

    await executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps);

    expect(rebuildSorobanNode).toHaveBeenCalledTimes(2);
    expect(revoke.status).toBe("confirmed");
  });

  it("gives up after MAX attempts on a persistent recoverable failure (bounded)", async () => {
    const rebuildSorobanNode = vi.fn(async () => {});
    const deps = makeDeps({ rebuildSorobanNode });
    (deps.submitSoroban as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("submitSoroban: sendTransaction returned tx_bad_seq"),
    );
    const { tree } = makeRevokeTree();

    await expect(
      executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps),
    ).rejects.toThrow(/tx_bad_seq/);
    expect(deps.submitSoroban).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-recoverable failure (contract revert), even with a rebuild callback", async () => {
    const rebuildSorobanNode = vi.fn(async () => {});
    const deps = makeDeps({ rebuildSorobanNode });
    (deps.submitSoroban as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("submitSoroban: transaction HASH failed on-chain"),
    );
    const { tree } = makeRevokeTree();

    await expect(
      executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps),
    ).rejects.toThrow(/failed on-chain/);
    // a genuine revert is not a seq/footprint race, so it is submitted exactly once
    expect(deps.submitSoroban).toHaveBeenCalledTimes(1);
  });

  it("without a rebuild callback, a Soroban failure is not retried (lighter-caller behavior)", async () => {
    const deps = makeDeps(); // no rebuildSorobanNode
    (deps.submitSoroban as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("submitSoroban: sendTransaction returned tx_bad_seq"),
    );
    const { tree } = makeRevokeTree();

    await expect(
      executePlanTreeOnChain({ publicKey: "GUSER", tree, previousReceipts: {} }, deps),
    ).rejects.toThrow(/tx_bad_seq/);
    // resubmitting the identical stale tx can't help, so it fails after one try
    expect(deps.submitSoroban).toHaveBeenCalledTimes(1);
  });
});
