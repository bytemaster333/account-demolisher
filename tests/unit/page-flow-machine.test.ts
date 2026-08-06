import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";

import {
  pageFlowMachine,
  classifyFailure,
  discoveryWarningFor,
  heldTokenDispositionWarnings,
  isRetryableFailure,
  type FailureKind,
  type PageFlowInput,
} from "@/lib/orchestrator/page-flow-machine";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";
import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";

// Minimal stand-ins, the machine only cares about identity/shape here because
// we replace the async actors with deterministic mocks.
const fakeInput = {
  publicKey: "GTEST",
  network: { passphrase: "Test SDF Network ; September 2015" },
  connector: {},
  destination: "GDEST",
  useMediator: false,
} as unknown as PageFlowInput;

const fakeAudit = { accountId: "GTEST" } as unknown as AccountAudit;
const fakeTree = { allNodes: new Map(), roots: [] } as unknown as PlanTree;

/**
 * Drive the machine toward `failed` and return a running actor plus the execute
 * spy. When `withTree` is true, discover+preview succeed (leaving a non-null
 * tree in context) and the first execute rejects, mirroring a partial
 * on-chain failure. When false, discover itself rejects, so the machine reaches
 * `failed` before any tree exists (context.tree stays null).
 */
function actorInFailed(opts: { withTree: boolean; onExecute: () => Promise<unknown> }) {
  const executeSpy = vi.fn(opts.onExecute);
  const machine = pageFlowMachine.provide({
    actors: {
      // cast to `never` to sidestep the machine's strict actor output typing
      // under exactOptionalPropertyTypes, these mocks only need to resolve/reject.
      discover: fromPromise(async () => {
        if (!opts.withTree) throw new Error("discovery failed");
        return {
          audit: fakeAudit,
          positions: EMPTY_POSITIONS,
          allowances: [],
          discoveryWarnings: [],
        };
      }) as never,
      preview: fromPromise(async () => ({
        tree: fakeTree,
        unroutableCredits: [],
      })) as never,
      // first execution fails, driving the machine to `failed`
      execute: fromPromise(executeSpy as never),
    },
  });
  const actor = createActor(machine).start();
  actor.send({ type: "START", input: fakeInput });
  return { actor, executeSpy };
}

describe("discoveryWarningFor (SEC-11: surface actionable adapter warnings verbatim)", () => {
  it("surfaces a Blend backstop stranding warning verbatim (not a generic frame)", () => {
    const message =
      "You hold a Blend backstop deposit in pool CXXX (5 shares). The close does NOT unwind " +
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

describe("heldTokenDispositionWarnings (SEP-41 opt-in: surface, never silently skip)", () => {
  function treeWith(nodes: PlanNode[]): PlanTree {
    return { allNodes: new Map(nodes.map((n) => [n.id, n])) } as unknown as PlanTree;
  }
  function drainNode(id: string, contractId: string, status: PlanNode["status"]): PlanNode {
    return {
      id,
      kind: "TransferAsIs",
      dependencies: [],
      status,
      description: "drain",
      metadata: {
        kind: "TransferAsIs",
        asset: { kind: "contract", contractId },
        amount: 1n,
        destination: "GDEST",
      },
    } as unknown as PlanNode;
  }

  it("warns that selected tokens can't be forwarded on a CEX/mediator close (path 3)", () => {
    const out = heldTokenDispositionWarnings(treeWith([]), { useMediator: true, selectedCount: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/can't be forwarded to an exchange/);
  });

  it("stays silent on a mediator close when nothing was selected", () => {
    expect(
      heldTokenDispositionWarnings(treeWith([]), { useMediator: true, selectedCount: 0 }),
    ).toEqual([]);
  });

  it("warns that a drain which failed simulation will be left behind (path 2)", () => {
    const tree = treeWith([
      drainNode(
        "drain-token:cxxx",
        "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1",
        "failed",
      ),
    ]);
    const out = heldTokenDispositionWarnings(tree, { useMediator: false, selectedCount: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/left behind on the deleted account/);
  });

  it("says nothing about a drain that simulated cleanly", () => {
    const tree = treeWith([
      drainNode(
        "drain-token:cyyy",
        "CYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY2",
        "simulated",
      ),
    ]);
    expect(heldTokenDispositionWarnings(tree, { useMediator: false, selectedCount: 1 })).toEqual(
      [],
    );
  });
});

describe("pageFlowMachine CONFIRM gate (gates→XState machine-level enforcement)", () => {
  function actorAwaitingConfirmation() {
    const machine = pageFlowMachine.provide({
      actors: {
        discover: fromPromise(async () => ({
          audit: fakeAudit,
          positions: EMPTY_POSITIONS,
          allowances: [],
          discoveryWarnings: [],
        })) as never,
        preview: fromPromise(async () => ({ tree: fakeTree, unroutableCredits: [] })) as never,
        // hang in `executing` so we can observe the transition without completing
        execute: fromPromise(() => new Promise(() => {})) as never,
      },
    });
    const actor = createActor(machine).start();
    actor.send({ type: "START", input: fakeInput });
    return actor;
  }

  it("refuses a CONFIRM whose typed value does not match the destination's last 4", async () => {
    const actor = actorAwaitingConfirmation();
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "WRONG" });
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    actor.stop();
  });

  it("executes on a CONFIRM whose typed value matches the destination's last 4", async () => {
    const actor = actorAwaitingConfirmation();
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    // destination "GDEST" -> last-4 "DEST"
    actor.send({ type: "CONFIRM", typed: "DEST" });
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    actor.stop();
  });
});

describe("pageFlowMachine RETRY resume", () => {
  it("re-executes the existing tree instead of rediscovering when a tree is present", async () => {
    // execute rejects the first time (partial failure) so the machine lands in
    // `failed` with context.tree still set (preview produced a non-null tree).
    let calls = 0;
    const { actor, executeSpy } = actorInFailed({
      withTree: true,
      onExecute: async () => {
        calls += 1;
        if (calls === 1) throw new Error("partial failure");
        // second run (after RETRY) never resolves within the test window; we
        // only assert we re-entered `executing`.
        return new Promise(() => {});
      },
    });

    // discover -> preview -> awaiting_confirmation, then CONFIRM -> executing
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    // destination "GDEST" -> last-4 "DEST" satisfies the confirm guard
    actor.send({ type: "CONFIRM", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    expect(actor.getSnapshot().context.tree).not.toBeNull();
    expect(executeSpy).toHaveBeenCalledTimes(1);

    actor.send({ type: "RETRY" });

    // Fix: RETRY with a non-null tree re-enters `executing` (reusing the tree so
    // the executor can skip already-confirmed nodes). Without the fix it would
    // route to `discovering` and rebuild a fresh tree, re-running everything.
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    expect(actor.getSnapshot().matches("discovering")).toBe(false);
    expect(executeSpy).toHaveBeenCalledTimes(2);

    actor.stop();
  });

  it("falls back to rediscovery when no tree exists (failure before preview)", async () => {
    // discovery itself fails, so the machine reaches `failed` before any tree
    // is built (context.tree stays null); execute is never reached.
    const { actor } = actorInFailed({
      withTree: false,
      onExecute: async () => {
        throw new Error("should not run");
      },
    });

    await waitFor(actor, (s) => s.matches("failed"));
    expect(actor.getSnapshot().context.tree).toBeNull();

    actor.send({ type: "RETRY" });

    // With no tree to resume, RETRY must fall back to a full rediscovery.
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(actor.getSnapshot().matches("executing")).toBe(false);

    actor.stop();
  });
});

describe("failure taxonomy (typed recovery)", () => {
  it("classifies each failure kind from its message", () => {
    expect(classifyFailure("submitClassic rejected: {tx_bad_seq}")).toBe("bad_seq");
    expect(classifyFailure("simulation failed: restorePreamble required")).toBe(
      "changed_footprint",
    );
    expect(classifyFailure("account_merge blocked: 1 Soroban DeFi position(s) still open")).toBe(
      "position_open",
    );
    expect(classifyFailure("account_merge blocked: account is auth immutable")).toBe(
      "not_mergeable",
    );
    expect(classifyFailure("Failed to sign envelope")).toBe("signing");
    expect(classifyFailure("Bad Gateway (502)")).toBe("network");
    expect(classifyFailure("something entirely unexpected")).toBe("unknown");
  });

  it("makes diverged-state failures rediscover and transient ones re-execute", () => {
    expect(isRetryableFailure("position_open")).toBe(false);
    expect(isRetryableFailure("not_mergeable")).toBe(false);
    for (const k of ["bad_seq", "changed_footprint", "network", "signing", "unknown"] as const) {
      expect(isRetryableFailure(k as FailureKind)).toBe(true);
    }
  });
});

describe("pageFlowMachine typed recovery", () => {
  it("rediscovers (not re-executes) a diverged-state failure (position still open)", async () => {
    const { actor, executeSpy } = actorInFailed({
      withTree: true,
      onExecute: async () => {
        throw new Error("account_merge blocked: 1 Soroban DeFi position(s) still open");
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST" });
    await waitFor(actor, (s) => s.matches("failed"));
    // the failure was typed
    expect(actor.getSnapshot().context.failureKind).toBe("position_open");
    expect(executeSpy).toHaveBeenCalledTimes(1);

    actor.send({ type: "RETRY" });
    // diverged state -> rebuild from discovery rather than replay the stale tree
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(actor.getSnapshot().matches("executing")).toBe(false);
    actor.stop();
  });
});
