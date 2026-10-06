import { describe, it, expect } from "vitest";

import { nodeFeeStroops, nodeMaxFeeStroops } from "@/app/demolish/_lib/fees";
import type { PlanNode } from "@/lib/plan/tree";
import type { ClassicBatch } from "@/lib/types/plan";

// minimal PlanNode carrying only the fields the fee helpers read (id/kind/status
// are required by the base shape); `simulated` drives the soroban fee.
function sorobanNode(minResourceFee: string): PlanNode {
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

// a two-batch close: the preview simulation only reports the FIRST batch, so the
// fee must come from every batch in the node metadata
function classicNode(batches: readonly ClassicBatch[]): PlanNode {
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
      operationCount: batches[0]?.operations.length ?? 0,
      estimatedFee: String((batches[0]?.operations.length ?? 0) * 100),
    },
  } as unknown as PlanNode;
}

describe("nodeFeeStroops, the fee each step is built with", () => {
  it("adds the 100000-stroop soroban inclusion fee every builder bids to minResourceFee", () => {
    // assembleTransaction sets fee = inclusion fee + minResourceFee, and every
    // soroban builder here passes SOROBAN_INCLUSION_FEE ("100000")
    expect(nodeFeeStroops(sorobanNode("12345"))).toBe(112_345);
  });

  it("still adds the inclusion fee when the resource fee is zero", () => {
    expect(nodeFeeStroops(sorobanNode("0"))).toBe(100_000);
  });

  it("counts every classic batch at the network minimum per operation", () => {
    expect(nodeFeeStroops(classicNode([batch(100), batch(2)]))).toBe(10_200);
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
    expect(nodeMaxFeeStroops(sorobanNode("12345"))).toBe(112_345);
  });
});
