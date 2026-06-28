import { describe, it, expect, vi } from "vitest";

// Importing the demolish page pulls in the wallet stack, whose kit wrapper eagerly
// evaluates @creit.tech/stellar-wallets-kit (a CJS/ESM-incompatible module in the
// node test env). Stub the leaf kit wrapper so the page module imports cleanly;
// nodeFeeStroops (the unit under test) does not touch it.
vi.mock("@/lib/wallet/kit", () => ({
  getKit: vi.fn(),
}));

import { nodeFeeStroops } from "@/app/demolish/page";
import type { PlanNode } from "@/lib/plan/tree";

// minimal PlanNode carrying only the fields nodeFeeStroops reads (id/kind/status
// are required by the base shape); `simulated` drives the fee.
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

function classicNode(estimatedFee: string): PlanNode {
  return {
    id: "n",
    kind: "FinalClassicTx",
    dependencies: [],
    description: "",
    status: "simulated",
    simulated: {
      kind: "classic",
      xdr: "",
      operationCount: 3,
      estimatedFee,
    },
  } as unknown as PlanNode;
}

describe("nodeFeeStroops — soroban fee includes the per-op inclusion fee", () => {
  it("adds BASE_FEE (100) to minResourceFee for a soroban node", () => {
    // the submitted fee assembles as minResourceFee + BASE_FEE (single-op tx),
    // so the estimate must be 12_345 + 100, not the bare 12_345.
    expect(nodeFeeStroops(sorobanNode("12345"))).toBe(12_445);
  });

  it("still adds BASE_FEE when the resource fee is zero", () => {
    expect(nodeFeeStroops(sorobanNode("0"))).toBe(100);
  });

  it("returns the classic estimatedFee verbatim (already tallies BASE_FEE * ops)", () => {
    expect(nodeFeeStroops(classicNode("300"))).toBe(300);
  });

  it("returns 0 for an un-simulated node", () => {
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
