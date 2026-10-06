import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";

import {
  pageFlowMachine,
  classifyFailure,
  discoveryWarningFor,
  heldTokenDispositionWarnings,
  isRetryableFailure,
  previewBlockers,
  type FailureKind,
  type PageFlowInput,
} from "@/lib/orchestrator/page-flow-machine";
import { CloseFailure, SubmitRejectedError } from "@/lib/orchestrator/failures";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";
import type { DemolishResult } from "@/lib/types/plan";
import type { Connector } from "@/lib/wallet/connector";
import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";

// the machine's transitions and guards with stand-in actors. the stand-ins keep
// the real actors' contract: execute resolves with { result, tree, failureKind,
// notes, landedPhases } on a failed close and only rejects on a bug. the real
// actors run in orchestrator-actors.test.ts.

const connector = { kind: "secret" } as unknown as Connector;
const otherConnector = { kind: "walletkit" } as unknown as Connector;

const fakeInput = {
  publicKey: "GTEST",
  network: { id: "testnet", passphrase: "Test SDF Network ; September 2015" },
  connector,
  destination: "GDEST",
  useMediator: false,
} as unknown as PageFlowInput;

const fakeAudit = { accountId: "GTEST" } as unknown as AccountAudit;

function node(id: string, kind: string, over: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    kind,
    dependencies: [],
    description: id,
    status: "simulated",
    metadata: { kind },
    ...over,
  } as unknown as PlanNode;
}

function treeOf(...nodes: PlanNode[]): PlanTree {
  return {
    rootNodes: nodes.filter((n) => n.dependencies.length === 0),
    allNodes: new Map(nodes.map((n) => [n.id, n])),
  };
}

const emptyTree = (): PlanTree => ({ allNodes: new Map(), rootNodes: [] });

interface ExecuteCall {
  readonly tree: PlanTree;
  readonly connector: Connector;
  readonly signedBundleXdr?: string;
  readonly interrupt: AbortSignal;
}

function failedOutput(tree: PlanTree, errors: string[], failureKind?: FailureKind) {
  return {
    result: { ok: false, errors } as DemolishResult,
    tree,
    ...(failureKind ? { failureKind } : {}),
    notes: [],
    landedPhases: [],
  };
}

function machineWith(opts: {
  tree?: () => PlanTree;
  discover?: () => Promise<unknown>;
  execute: (input: ExecuteCall) => Promise<unknown>;
}) {
  const execute = vi.fn(opts.execute);
  const discover = vi.fn(
    opts.discover ??
      (async () => ({
        audit: fakeAudit,
        positions: EMPTY_POSITIONS,
        allowances: [],
        heldTokens: [],
        unreadableHeldTokens: [],
        heldTokenScanFailed: false,
        discoveryWarnings: [],
        discoveryDiagnostics: [],
      })),
  );
  const machine = pageFlowMachine.provide({
    actors: {
      discover: fromPromise(discover) as never,
      preview: fromPromise(async () => ({
        tree: (opts.tree ?? emptyTree)(),
        unroutableCredits: [],
        heldTokenWarnings: [],
      })) as never,
      execute: fromPromise(({ input }) => execute(input as ExecuteCall)) as never,
    },
  });
  const actor = createActor(machine).start();
  actor.send({ type: "START", input: fakeInput });
  return { actor, execute, discover };
}

const hang = () => new Promise<never>(() => {});

describe("discoveryWarningFor", () => {
  it("surfaces a Blend backstop stranding warning verbatim (not a generic frame)", () => {
    const message =
      "You hold a Blend backstop deposit in pool CXXX (5 shares). The close does not unwind " +
      "backstop deposits: withdraw it (a queued, 17-day process) before closing, or those funds " +
      "will be stranded.";
    expect(discoveryWarningFor({ protocol: "blend", message })).toBe(message);
  });

  it("keeps a generic frame for a technical load failure", () => {
    const out = discoveryWarningFor({
      protocol: "blend",
      message: "pool CXXX stage=user: Positions.load failed: RPC 500",
    });
    expect(out).toContain("We couldn't check your blend positions");
    expect(out).not.toContain("stage=user");
  });
});

describe("heldTokenDispositionWarnings", () => {
  function heldNode(kind: "TransferAsIs" | "ConvertSorobanToXLM", status: PlanNode["status"]) {
    return node(`${kind}:c`, kind, {
      status,
      error: "simulation reverted",
      metadata: {
        kind,
        asset: {
          kind: "contract",
          contractId: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1",
        },
        amount: 1n,
        destination: "GDEST",
      },
    } as Partial<PlanNode>);
  }

  it("warns that selected tokens can't be forwarded on an exchange close", () => {
    const out = heldTokenDispositionWarnings(emptyTree(), { useMediator: true, selectedCount: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/can't be forwarded to an exchange/);
  });

  it("stays silent on an exchange close when nothing was selected", () => {
    expect(
      heldTokenDispositionWarnings(emptyTree(), { useMediator: true, selectedCount: 0 }),
    ).toEqual([]);
  });

  it("says a drain that failed preview is tried again, and stays behind only if it fails again", () => {
    const out = heldTokenDispositionWarnings(treeOf(heldNode("TransferAsIs", "failed")), {
      useMediator: false,
      selectedCount: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/tries it again; if it still fails, the token stays/);
    expect(out[0]).not.toMatch(/\u2014/);
  });

  it("warns about a conversion that failed preview too", () => {
    const out = heldTokenDispositionWarnings(treeOf(heldNode("ConvertSorobanToXLM", "failed")), {
      useMediator: false,
      selectedCount: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/sends the token to your destination as-is/);
  });

  it("says nothing about a drain that simulated cleanly", () => {
    expect(
      heldTokenDispositionWarnings(treeOf(heldNode("TransferAsIs", "simulated")), {
        useMediator: false,
        selectedCount: 1,
      }),
    ).toEqual([]);
  });
});

describe("the CONFIRM gate", () => {
  it("refuses a CONFIRM whose typed value does not match the destination's last 4", async () => {
    const { actor } = machineWith({ execute: hang });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "WRONG" });
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    actor.stop();
  });

  it("executes on a CONFIRM whose typed value matches the destination's last 4", async () => {
    const { actor, execute } = machineWith({ execute: hang });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    expect(execute.mock.calls[0]![0].connector).toBe(connector);
    actor.stop();
  });

  it("refuses to confirm a plan whose merge or a required step failed preview", async () => {
    for (const failed of [
      node("final-classic-tx", "FinalClassicTx", { status: "failed", error: "fee overflow" }),
      node("withdraw", "WithdrawBlend", { status: "failed", error: "simulation reverted" }),
      node("mediator-forward", "MediatorForward", { status: "failed", error: "no flow" }),
    ]) {
      const { actor, execute } = machineWith({
        tree: () => treeOf(failed),
        execute: hang,
      });
      await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
      expect(previewBlockers(actor.getSnapshot().context.tree)).toHaveLength(1);
      actor.send({ type: "CONFIRM", typed: "DEST" });
      expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      actor.stop();
    }
  });

  it("lets a best-effort step that failed preview through, to be tried again", async () => {
    const { actor } = machineWith({
      tree: () =>
        treeOf(
          node("drain", "TransferAsIs", { status: "failed", error: "rpc timeout" }),
          node("final-classic-tx", "FinalClassicTx", { dependencies: ["drain"] }),
        ),
      execute: hang,
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    // the executor gets it back as pending, so it runs again
    expect(actor.getSnapshot().context.tree!.allNodes.get("drain")!.status).toBe("pending");
    actor.stop();
  });
});

describe("the multisig bundle has the same typed-destination gate", () => {
  it("refuses a SUBMIT_BUNDLE without the typed last 4 of the destination", async () => {
    const { actor, execute } = machineWith({ execute: hang });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "SUBMIT_BUNDLE", signedXdr: "AAAA" });
    actor.send({ type: "SUBMIT_BUNDLE", signedXdr: "AAAA", typed: "NOPE" });
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });

  it("submits the bundle once the typed value matches", async () => {
    const { actor, execute } = machineWith({ execute: hang });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "SUBMIT_BUNDLE", signedXdr: "AAAA", typed: "DEST" });
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    expect(execute.mock.calls[0]![0].signedBundleXdr).toBe("AAAA");
    actor.stop();
  });

  it("drops a stale bundle: RETRY after a bundle_stale failure rebuilds instead of resubmitting", async () => {
    const { actor, execute } = machineWith({
      execute: async (input) =>
        failedOutput(
          input.tree,
          ['submitClassic rejected: {"transaction":"tx_too_late"}'],
          "bundle_stale",
        ),
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "SUBMIT_BUNDLE", signedXdr: "AAAA", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY", connector });
    const snap = actor.getSnapshot();
    expect(snap.matches("discovering")).toBe(true);
    expect(snap.context.signedBundleXdr).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });
});

describe("RETRY", () => {
  it("re-executes the same tree with the wallet connected now, classified from the real result", async () => {
    const tree = treeOf(node("final-classic-tx", "FinalClassicTx"));
    let calls = 0;
    const { actor, execute } = machineWith({
      tree: () => tree,
      execute: async (input) => {
        calls += 1;
        if (calls === 1) return failedOutput(input.tree, ["Bad Gateway (502)"]);
        return hang();
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    const failed = actor.getSnapshot().context;
    expect(failed.failureKind).toBe("network");
    expect(failed.tree!.allNodes).toBe(tree.allNodes);
    // the close ended, so the wallet it captured is gone
    expect(failed.connector).toBeNull();

    actor.send({ type: "RETRY", connector: otherConnector });
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0].connector).toBe(otherConnector);
    actor.stop();
  });

  it("resets what did not land so the failed step and the merge run again", async () => {
    const landed = node("withdraw", "WithdrawBlend", {
      status: "confirmed",
      executed: { txHash: "W", ledger: 1 },
    });
    const failedExit = node("repay", "RepayBlend");
    const keptSkip = node("drain", "TransferAsIs", {
      status: "skipped",
      error: "Token drain skipped: reverted",
    });
    const final = node("final-classic-tx", "FinalClassicTx", {
      dependencies: ["withdraw", "repay", "drain"],
    });
    const tree = treeOf(landed, failedExit, keptSkip, final);
    let calls = 0;
    const seen: Record<string, string>[] = [];
    const { actor } = machineWith({
      tree: () => tree,
      execute: async (input) => {
        calls += 1;
        seen.push(
          Object.fromEntries([...input.tree.allNodes.values()].map((n) => [n.id, n.status])),
        );
        if (calls === 1) {
          failedExit.status = "failed";
          failedExit.error = "rpc timeout";
          final.status = "skipped";
          final.error = 'Skipped: dependency "repay" did not complete: rpc timeout';
          return failedOutput(input.tree, ["rpc timeout"], "network");
        }
        return hang();
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY", connector });
    expect(seen[1]).toEqual({
      withdraw: "confirmed",
      repay: "pending",
      drain: "skipped",
      "final-classic-tx": "pending",
    });
    expect(final.error).toBeUndefined();
    actor.stop();
  });

  it("rebuilds the plan when there is no wallet to sign with", async () => {
    const { actor, execute } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      execute: async (input) => failedOutput(input.tree, ["Bad Gateway (502)"], "network"),
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY" });
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(actor.getSnapshot().context.tree).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("rediscovers a diverged-state failure instead of replaying the old tree", async () => {
    const { actor, execute } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      execute: async (input) =>
        failedOutput(input.tree, ["account_merge blocked: 1 Soroban DeFi position(s) still open"]),
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    expect(actor.getSnapshot().context.failureKind).toBe("position_open");
    actor.send({ type: "RETRY", connector });
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("never executes a stale tree after a failed rediscovery", async () => {
    let discoveries = 0;
    const { actor, execute } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      discover: async () => {
        discoveries += 1;
        if (discoveries > 1) throw new Error("auditAccount timed out after 30000ms");
        return {
          audit: fakeAudit,
          positions: EMPTY_POSITIONS,
          allowances: [],
          heldTokens: [],
          unreadableHeldTokens: [],
          heldTokenScanFailed: false,
          discoveryWarnings: [],
          discoveryDiagnostics: [],
        };
      },
      execute: async (input) =>
        failedOutput(input.tree, ["account_merge blocked: account is auth immutable"]),
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY", connector });
    await waitFor(actor, (s) => s.matches("failed"));
    const snap = actor.getSnapshot();
    expect(snap.context.failureKind).toBe("network");
    expect(snap.context.tree).toBeNull();
    expect(snap.context.signedBundleXdr).toBeNull();
    actor.send({ type: "RETRY", connector });
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("treats a rejected execute actor as a bug in the onError branch, keeping the tree", async () => {
    const tree = treeOf(node("final-classic-tx", "FinalClassicTx"));
    const { actor } = machineWith({
      tree: () => tree,
      execute: async () => {
        throw new Error("executing: missing tree from preview");
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    const snap = actor.getSnapshot().context;
    expect(snap.error).toBe("executing: missing tree from preview");
    expect(snap.failureKind).toBe("unknown");
    expect(snap.tree!.allNodes).toBe(tree.allNodes);
    actor.stop();
  });
});

describe("a running close can be stopped", () => {
  it("CANCEL while executing aborts the close at the next step boundary", async () => {
    let signal: AbortSignal | undefined;
    const { actor } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      execute: (input) => {
        signal = input.interrupt;
        return new Promise((resolve) => {
          input.interrupt.addEventListener("abort", () =>
            resolve(failedOutput(input.tree, ["The close was stopped."], "interrupted")),
          );
        });
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    expect(signal?.aborted).toBe(false);
    actor.send({ type: "CANCEL" });
    expect(signal?.aborted).toBe(true);
    await waitFor(actor, (s) => s.matches("failed"));
    expect(actor.getSnapshot().context.failureKind).toBe("interrupted");
    expect(actor.getSnapshot().context.connector).toBeNull();
    actor.stop();
  });

  it("stopping the actor aborts the signal the execute actor runs under", async () => {
    let signal: AbortSignal | undefined;
    const machine = pageFlowMachine.provide({
      actors: {
        discover: fromPromise(async () => ({
          audit: fakeAudit,
          positions: EMPTY_POSITIONS,
          allowances: [],
          heldTokens: [],
          unreadableHeldTokens: [],
          heldTokenScanFailed: false,
          discoveryWarnings: [],
          discoveryDiagnostics: [],
        })) as never,
        preview: fromPromise(async () => ({
          tree: treeOf(node("final-classic-tx", "FinalClassicTx")),
          unroutableCredits: [],
          heldTokenWarnings: [],
        })) as never,
        execute: fromPromise(({ signal: s }) => {
          signal = s;
          return hang();
        }) as never,
      },
    });
    const actor = createActor(machine).start();
    actor.send({ type: "START", input: fakeInput });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    actor.stop();
    expect(signal?.aborted).toBe(true);
  });
});

describe("failure taxonomy", () => {
  it("classifies typed failures by their kind", () => {
    expect(classifyFailure(new CloseFailure("signing", "The wallet did not sign"))).toBe("signing");
    expect(classifyFailure(new SubmitRejectedError({ transaction: "tx_bad_seq" }, 400))).toBe(
      "bad_seq",
    );
    expect(
      classifyFailure(
        new SubmitRejectedError({ transaction: "tx_failed", operations: ["op_no_issuer"] }, 400),
      ),
    ).toBe("not_mergeable");
  });

  it("classifies the messages real code emits", () => {
    expect(classifyFailure('submitClassic rejected: {"transaction":"tx_bad_seq"}')).toBe("bad_seq");
    expect(classifyFailure("submitSoroban: sendTransaction returned ERROR; result txBadSeq")).toBe(
      "bad_seq",
    );
    expect(classifyFailure("simulation failed: restorePreamble required")).toBe(
      "changed_footprint",
    );
    expect(classifyFailure("account_merge blocked: 1 Soroban DeFi position(s) still open")).toBe(
      "position_open",
    );
    expect(classifyFailure("account_merge blocked: account is auth immutable")).toBe(
      "not_mergeable",
    );
    expect(classifyFailure("Bad Gateway (502)")).toBe("network");
    expect(classifyFailure({ code: -32603, message: "fetch failed" })).toBe("network");
    expect(classifyFailure("submitSoroban: transaction ABC123 failed on-chain")).toBe("reverted");
    // a stop whose detail mentions "archived" stays a diverged-state stop
    expect(
      classifyFailure("account_merge blocked: DeFi position(s) still open (entry archived)"),
    ).toBe("position_open");
    // a wallet's own wording is not guessed at; the executor types it
    expect(classifyFailure("User declined")).toBe("unknown");
    // the word "network" alone says nothing
    expect(classifyFailure("the network passphrase does not match")).toBe("unknown");
  });

  it("re-executes only transient kinds; an unknown fault rebuilds the plan", () => {
    for (const k of [
      "position_open",
      "not_mergeable",
      "reverted",
      "unsafe",
      "bundle_stale",
      "mediator_expired",
      "unknown",
    ] as const) {
      expect(isRetryableFailure(k)).toBe(false);
    }
    for (const k of [
      "bad_seq",
      "changed_footprint",
      "network",
      "signing",
      "ambiguous",
      "forward_pending",
      "interrupted",
    ] as const) {
      expect(isRetryableFailure(k)).toBe(true);
    }
  });

  it("does not nest the previous failure into the next one", async () => {
    let calls = 0;
    const { actor } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      execute: async (input) => {
        calls += 1;
        return failedOutput(input.tree, [`HTTP 503 attempt ${calls}`], "network");
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY", connector });
    await waitFor(actor, (s) => s.matches("failed") && calls === 2);
    expect(actor.getSnapshot().context.error).toBe("HTTP 503 attempt 2");
    actor.stop();
  });
});
