import { describe, it, expect } from "vitest";

import { nodeFeeStroops, nodeMaxFeeStroops } from "@/app/demolish/_lib/fees";
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

  it("keeps the soroban figure, which is already the signed maximum", () => {
    expect(nodeMaxFeeStroops(sorobanNode("12345", "131000"))).toBe(131_000);
  });
});
