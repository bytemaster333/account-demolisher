import { describe, it, expect } from "vitest";

import { feeIsUnbuilt, nodeFeeStroops, nodeMaxFeeStroops } from "@/app/demolish/_lib/fees";
import { MAX_FORWARD_FEE } from "@/lib/mediator/forward-terms";
import type { PlanNode } from "@/lib/plan/tree";
import type { ClassicBatch } from "@/lib/types/plan";

// minimal PlanNode carrying only the fields the fee helpers read (id/kind/status
// are required by the base shape); `simulated` drives the soroban fee. maxFee is
// the fee the built transaction authorizes (inclusion bid plus resource fee).
function sorobanNode(minResourceFee: string, maxFee: string): PlanNode {
  return {
    id: "n",
    kind: "RevokeAllowance",
    dependencies: [],
    description: "",
    status: "simulated",
    metadata: { kind: "RevokeAllowance", contractId: "C", spender: "G" },
    simulated: {
      kind: "soroban",
      retval: null,
      minResourceFee,
      maxFee,
      transactionData: undefined as never,
      latestLedger: 1,
      auth: [],
      restorePreambleRequired: false,
    },
  } as unknown as PlanNode;
}

// a soroban step of `kind` the preview has not built
function kindNode(kind: PlanNode["kind"]): PlanNode {
  return {
    id: kind,
    kind,
    dependencies: [],
    description: "",
    status: "pending",
    metadata: { kind },
  } as unknown as PlanNode;
}

function batch(opCount: number): ClassicBatch {
  return {
    operations: Array.from({ length: opCount }, (_, i) => ({
      kind: "manage_data_delete" as const,
      summary: `delete data k${i}`,
      metadata: { name: `k${i}` },
    })),
    destination: "GDEST",
  };
}

// a close the preview built at `feePerOp` per operation: the simulator totals
// every batch, so estimatedFee covers all of them
function classicNode(batches: readonly ClassicBatch[], feePerOp = 100): PlanNode {
  const ops = batches.reduce((n, b) => n + b.operations.length, 0);
  return {
    id: "final-classic-tx",
    kind: "FinalClassicTx",
    dependencies: [],
    description: "",
    status: "simulated",
    metadata: { kind: "FinalClassicTx", batches, destination: "GDEST", useMediator: false },
    simulated: {
      kind: "classic",
      xdr: "",
      operationCount: ops,
      estimatedFee: String(ops * feePerOp),
      transactionCount: batches.length,
    },
  } as unknown as PlanNode;
}

describe("nodeFeeStroops, the fee each step is built with", () => {
  it("uses the fee the built soroban transaction authorizes, not minResourceFee plus a guess", () => {
    // the assembled tx can carry more than minResourceFee (instruction leeway),
    // and that is what the signer pays at most
    expect(nodeFeeStroops(sorobanNode("12345", "131000"))).toBe(131_000);
  });

  it("totals every classic batch at the fee base the preview built them with", () => {
    expect(nodeFeeStroops(classicNode([batch(100), batch(2)]))).toBe(10_200);
    expect(nodeFeeStroops(classicNode([batch(100), batch(2)], 250))).toBe(25_500);
  });

  it("returns 0 for an un-simulated soroban node", () => {
    const node = {
      id: "n",
      kind: "RevokeAllowance",
      dependencies: [],
      description: "",
      status: "pending",
    } as unknown as PlanNode;
    expect(nodeFeeStroops(node)).toBe(0);
  });
});

describe("nodeMaxFeeStroops, the most execution may bid", () => {
  it("prices classic batches at the executor's 1,000,000-stroop per-op surge ceiling", () => {
    expect(nodeMaxFeeStroops(classicNode([batch(100), batch(2)]))).toBe(102_000_000);
  });

  // the executor rebuilds and re-simulates every soroban step right before
  // signing, so the preview's simulated fee is not a ceiling; the per-class cap
  // the executor checks is (NP5-42)
  it("bounds a soroban step by its class's cap, not by the preview's simulated fee", () => {
    // an allowance revoke runs an untrusted token: 0.01 XLM inclusion + 0.2 XLM cap
    expect(nodeMaxFeeStroops(sorobanNode("12345", "131000"))).toBe(2_100_000);
    // a blend repay is a pinned defi exit: 0.01 XLM inclusion + 3.3 XLM cap
    expect(nodeMaxFeeStroops(kindNode("RepayBlend"))).toBe(33_100_000);
    expect(nodeMaxFeeStroops(kindNode("WithdrawAquarius"))).toBe(33_100_000);
    expect(nodeMaxFeeStroops(kindNode("ConvertSorobanToXLM"))).toBe(14_100_000);
  });

  // a step built only at execute time has no simulated fee, but the executor
  // still never signs it above its cap, so that cap is what the review counts
  // (NP5-35)
  it("counts a step built at execute time at its cap, with no usual fee", () => {
    const deferred = { ...kindNode("WithdrawBlend"), deferred: { after: ["x"], reason: "r" } };
    expect(nodeFeeStroops(deferred)).toBe(0);
    expect(feeIsUnbuilt(deferred)).toBe(true);
    expect(nodeMaxFeeStroops(deferred)).toBe(33_100_000);
    expect(feeIsUnbuilt(sorobanNode("12345", "131000"))).toBe(false);
  });
});

describe("the mediator forward's fee (NP5-21)", () => {
  function forward(estimatedFee?: string): PlanNode {
    return {
      id: "mediator-forward",
      kind: "MediatorForward",
      dependencies: [],
      description: "",
      status: estimatedFee === undefined ? "pending" : "simulated",
      metadata: { kind: "MediatorForward" },
      ...(estimatedFee === undefined
        ? {}
        : {
            simulated: {
              kind: "classic",
              xdr: "",
              operationCount: 2,
              estimatedFee,
              transactionCount: 1,
            },
          }),
    } as unknown as PlanNode;
  }

  it("is priced at the starting bid the preview read from the network's fees", () => {
    // under surge the preview's per-op bid is the p90, for example 25,000 stroops
    expect(nodeFeeStroops(forward("50000"))).toBe(50_000);
  });

  it("counts an unpriced forward at the network minimum, never a made-up figure", () => {
    expect(nodeFeeStroops(forward())).toBe(200);
  });

  it("may cost at most the ceiling the forward escalates to", () => {
    expect(nodeMaxFeeStroops(forward("50000"))).toBe(MAX_FORWARD_FEE);
    expect(nodeMaxFeeStroops(forward())).toBe(MAX_FORWARD_FEE);
  });
});
