import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";

import { pageFlowMachine, type PageFlowInput } from "@/lib/orchestrator/page-flow-machine";
import type { PlanTree } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";
import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";

// Minimal stand-ins — the machine only cares about identity/shape here because
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
 * tree in context) and the first execute rejects — mirroring a partial
 * on-chain failure. When false, discover itself rejects, so the machine reaches
 * `failed` before any tree exists (context.tree stays null).
 */
function actorInFailed(opts: { withTree: boolean; onExecute: () => Promise<unknown> }) {
  const executeSpy = vi.fn(opts.onExecute);
  const machine = pageFlowMachine.provide({
    actors: {
      // cast to `never` to sidestep the machine's strict actor output typing
      // under exactOptionalPropertyTypes — these mocks only need to resolve/reject.
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
    actor.send({ type: "CONFIRM" });
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
