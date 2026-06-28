import { describe, it, expect } from "vitest";
import { buildPlanTree, isSorobanNode, topologicalOrder } from "@/lib/plan/tree";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";

// buildPlanTree/topologicalOrder are the ordering backbone of the demolition
// run: every node must execute only after its dependencies are confirmed. These
// tests lock in the DAG invariants — validation, cycle rejection, and a stable
// parents-before-children order that is deterministic on input.

// Minimal, real PlanNodes. TransferAsIs is the simplest concrete shape (its
// metadata only needs an asset/amount/destination) so we use it as a stand-in
// node; ordering logic is kind-agnostic and only reads id/dependencies.
function node(id: string, dependencies: readonly string[] = []): PlanNode {
  return {
    id,
    kind: "TransferAsIs",
    dependencies,
    description: `transfer ${id}`,
    status: "pending",
    metadata: {
      kind: "TransferAsIs",
      asset: { kind: "native" },
      amount: 1n,
      destination: "GDESTINATION",
    },
  };
}

// index-of a node id within an ordered node list; -1 when absent
function indexOf(order: readonly PlanNode[], id: string): number {
  return order.findIndex((n) => n.id === id);
}

describe("buildPlanTree", () => {
  it("indexes every node by id and exposes dependency-free nodes as roots", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["a"])];
    const tree = buildPlanTree(nodes);
    expect(tree.allNodes.size).toBe(3);
    expect(tree.allNodes.get("b")).toBe(nodes[1]);
    expect(tree.rootNodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("treats a node with multiple satisfied dependencies as valid", () => {
    const nodes = [node("a"), node("b"), node("c", ["a", "b"])];
    const tree = buildPlanTree(nodes);
    expect(tree.rootNodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(tree.allNodes.get("c")!.dependencies).toEqual(["a", "b"]);
  });

  it("throws on a duplicate node id", () => {
    expect(() => buildPlanTree([node("dup"), node("dup")])).toThrow(/duplicate node id "dup"/);
  });

  it("throws when an edge points to a missing node", () => {
    expect(() => buildPlanTree([node("a", ["ghost"])])).toThrow(
      /"a" depends on missing node id "ghost"/,
    );
  });

  it("throws on a direct two-node cycle", () => {
    expect(() => buildPlanTree([node("a", ["b"]), node("b", ["a"])])).toThrow(/cycle detected/);
  });

  it("throws on a self-dependency", () => {
    expect(() => buildPlanTree([node("a", ["a"])])).toThrow(/cycle detected/);
  });

  it("throws on a longer indirect cycle and reports the offending path", () => {
    let caught: unknown;
    try {
      buildPlanTree([node("a", ["c"]), node("b", ["a"]), node("c", ["b"])]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/cycle detected/);
    // the reported path closes back on the node where the cycle was found
    const arrow = message.split(": ").pop() ?? "";
    const segments = arrow.split(" -> ");
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(segments[0]).toBe(segments[segments.length - 1]);
  });

  it("accepts a valid diamond dependency shape", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];
    expect(() => buildPlanTree(nodes)).not.toThrow();
  });
});

describe("topologicalOrder", () => {
  it("emits every node exactly once", () => {
    const tree = buildPlanTree([node("a"), node("b", ["a"]), node("c", ["b"])]);
    const order = topologicalOrder(tree);
    expect(order).toHaveLength(3);
    expect(new Set(order.map((n) => n.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("places every dependency before its dependent", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])];
    const order = topologicalOrder(buildPlanTree(nodes));
    for (const n of nodes) {
      for (const dep of n.dependencies) {
        expect(indexOf(order, dep)).toBeLessThan(indexOf(order, n.id));
      }
    }
  });

  it("orders a linear chain from root to leaf", () => {
    const order = topologicalOrder(buildPlanTree([node("z", ["y"]), node("y", ["x"]), node("x")]));
    expect(order.map((n) => n.id)).toEqual(["x", "y", "z"]);
  });

  it("is deterministic: identical input yields identical order", () => {
    const build = (): PlanTree =>
      buildPlanTree([
        node("a"),
        node("b", ["a"]),
        node("c", ["a"]),
        node("d", ["b", "c"]),
        node("e", ["d"]),
      ]);
    const first = topologicalOrder(build()).map((n) => n.id);
    const second = topologicalOrder(build()).map((n) => n.id);
    expect(second).toEqual(first);
  });

  it("preserves insertion order among independent roots", () => {
    // no edges: pure insertion order (map iteration order === insertion order)
    const order = topologicalOrder(buildPlanTree([node("first"), node("second"), node("third")]));
    expect(order.map((n) => n.id)).toEqual(["first", "second", "third"]);
  });

  it("returns the single node for a one-node tree", () => {
    const order = topologicalOrder(buildPlanTree([node("solo")]));
    expect(order.map((n) => n.id)).toEqual(["solo"]);
  });
});

describe("isSorobanNode", () => {
  it("classifies contract-touching kinds as soroban", () => {
    expect(isSorobanNode(node("t"))).toBe(true);
  });

  it("classifies classic-only kinds as non-soroban", () => {
    const finalTx: PlanNode = {
      id: "final",
      kind: "FinalClassicTx",
      dependencies: [],
      description: "final classic tx",
      status: "pending",
      metadata: {
        kind: "FinalClassicTx",
        batches: [],
        destination: "GDEST",
        useMediator: false,
      },
    };
    const forward: PlanNode = {
      id: "fwd",
      kind: "MediatorForward",
      dependencies: [],
      description: "mediator forward",
      status: "pending",
      metadata: {
        kind: "MediatorForward",
        mediatorPublicKey: "GMED",
        flowToken: "nonce.exp.mac",
        ultimateDestination: "GCEX",
      },
    };
    expect(isSorobanNode(finalTx)).toBe(false);
    expect(isSorobanNode(forward)).toBe(false);
  });
});
