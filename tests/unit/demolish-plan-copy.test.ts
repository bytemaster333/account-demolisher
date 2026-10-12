import { describe, it, expect } from "vitest";

import { topologicalOrder, type PlanNode } from "@/lib/plan/tree";

import {
  groupPlanNodes,
  nodeExplainer,
  planStepNumbers,
  runProgress,
  runnableSteps,
  simulatedBadgeLabel,
} from "@/app/demolish/_lib/plan-copy";

import { TOKEN_C, blendPositions, emptyPositions, makeTree } from "./demolish-fixtures";

function treeWithBlendAquariusAndToken() {
  const positions = {
    ...blendPositions(),
    aquarius: [{ poolIndex: "aa".repeat(32), shareBalance: 10n, tokens: ["CA", "CB"] }],
  };
  return makeTree({
    positions,
    opts: { heldTokens: [{ contractId: TOKEN_C, balance: 5n }] },
  });
}

describe("review step numbering follows execution order (L-61)", () => {
  it("numbers each step in the order it runs", () => {
    const tree = treeWithBlendAquariusAndToken();
    const ordered = topologicalOrder(tree);
    const groups = groupPlanNodes(ordered);
    const numbers = planStepNumbers(groups);
    // the held-token sweep waits on every exit, since an exit can pay out more
    // of the same token, so it is numbered after the Blend withdraw
    const withdraw = ordered.find((n) => n.kind === "WithdrawBlend")!;
    const transfer = ordered.find((n) => n.kind === "TransferAsIs")!;
    expect(transfer.dependencies).toContain(withdraw.id);
    expect(numbers.get(transfer.id)!).toBeGreaterThan(numbers.get(withdraw.id)!);
    ordered.forEach((n, i) => expect(numbers.get(n.id)).toBe(i + 1));
    // the displayed sequence (groups flattened) is exactly the execution order
    expect(groups.flatMap((g) => g.nodes).map((n) => n.id)).toEqual(ordered.map((n) => n.id));
  });
});

describe("skipped steps get no step number (NP5-47)", () => {
  it("numbers only the steps that run, so the last number is the run count", () => {
    const tree = treeWithBlendAquariusAndToken();
    const ordered = topologicalOrder(tree);
    const skippedNode = ordered[1]!;
    const marked = ordered.map((n) =>
      n.id === skippedNode.id ? ({ ...n, status: "skipped" } as PlanNode) : n,
    );
    const groups = groupPlanNodes(marked);
    const numbers = planStepNumbers(groups);
    const { runnable } = runnableSteps(marked);
    expect(numbers.has(skippedNode.id)).toBe(false);
    expect(Math.max(...numbers.values())).toBe(runnable);
    expect([...numbers.values()]).toEqual(Array.from({ length: runnable }, (_, i) => i + 1));
  });
});

describe("plan explainers say what actually happens (L-59)", () => {
  function finalNode(useMediator: boolean): PlanNode {
    const tree = makeTree(
      useMediator
        ? {
            opts: {
              useMediator: true,
              mediatorPublicKey: "GAMEDIATOR",
              flowToken: "token",
            },
          }
        : {},
    );
    return tree.allNodes.get("final-classic-tx")!;
  }

  it("does not claim the close is one transaction or that it always converts", () => {
    const direct = nodeExplainer(finalNode(false), { deterministic: true });
    expect(direct).not.toMatch(/all in one transaction/i);
    expect(direct).not.toMatch(/converts anything left/i);
    expect(direct).toMatch(/one or more transactions/i);
  });

  it("mentions the helper account hop on an exchange close", () => {
    const viaMediator = nodeExplainer(finalNode(true), { deterministic: false });
    expect(viaMediator).toMatch(/helper account/i);
  });

  // a memo-required address that is not an exchange forwards through the
  // mediator too (H-15), so the forward step must not call the memo an
  // exchange deposit memo (NPF-24)
  it("describes the forward's memo as the one the destination requires", () => {
    const tree = makeTree({
      opts: { useMediator: true, mediatorPublicKey: "GAMEDIATOR", flowToken: "token" },
    });
    const forward = tree.allNodes.get("mediator-forward")!;
    expect(forward.kind).toBe("MediatorForward");
    const text = nodeExplainer(forward, { deterministic: false });
    expect(text).toMatch(/the memo the destination requires/);
    expect(text).not.toMatch(/exchange/i);
  });

  it("does not describe a SEP-41 transfer as freeing a trustline", () => {
    const tree = makeTree({ opts: { heldTokens: [{ contractId: TOKEN_C, balance: 5n }] } });
    const node = [...tree.allNodes.values()].find((n) => n.kind === "TransferAsIs")!;
    const text = nodeExplainer(node, { deterministic: false });
    expect(text).not.toMatch(/trustline/i);
    expect(text).toMatch(/unchanged/i);
  });
});

describe("dry-run badges and step counts (L-60)", () => {
  it("labels the classic close as checked offline, not as a passed dry run", () => {
    const tree = makeTree({ positions: emptyPositions() });
    const final = tree.allNodes.get("final-classic-tx")!;
    expect(simulatedBadgeLabel(final)).toBe("Checked offline");
    const tree2 = makeTree({ positions: blendPositions() });
    const repay = [...tree2.allNodes.values()].find((n) => n.kind === "RepayBlend")!;
    expect(simulatedBadgeLabel(repay)).toBe("Dry run passed");
  });

  it("does not count skipped steps as steps that run", () => {
    const tree = makeTree({ positions: blendPositions() });
    const ordered = topologicalOrder(tree);
    const withdraw = ordered.find((n) => n.kind === "WithdrawBlend")!;
    withdraw.status = "skipped";
    withdraw.error = "Could not build the WithdrawBlend transaction";
    const { runnable, skipped } = runnableSteps(ordered);
    expect(runnable).toBe(ordered.length - 1);
    expect(skipped.map((n) => n.id)).toEqual([withdraw.id]);
  });
});

// the run's "N of M steps done" counter (NPF-25): a skipped step never ran, so
// it is neither done nor one of the steps the run counts, the same count the
// review header shows
describe("run progress counts only the steps that run", () => {
  it("leaves a skipped step out of both counts and counts only landed steps as done", () => {
    const tree = treeWithBlendAquariusAndToken();
    const ordered = topologicalOrder(tree);
    expect(ordered.length).toBeGreaterThan(3);
    const [first, second, third] = ordered;
    first!.status = "confirmed";
    second!.executed = { txHash: "ab".repeat(32), ledger: 7 };
    third!.status = "skipped";
    const { runnable } = runnableSteps(ordered);
    expect(runProgress(ordered)).toEqual({ done: 2, total: runnable });
    expect(runProgress(ordered).total).toBe(ordered.length - 1);
  });

  it("still counts a step that landed before a later status overwrote it", () => {
    const tree = treeWithBlendAquariusAndToken();
    const ordered = topologicalOrder(tree);
    const [first] = ordered;
    first!.executed = { txHash: "cd".repeat(32), ledger: 9 };
    first!.status = "skipped";
    expect(runProgress(ordered)).toEqual({ done: 1, total: ordered.length });
  });
});
