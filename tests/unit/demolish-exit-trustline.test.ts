import { describe, it, expect } from "vitest";

import { nodeFeeStroops, nodeMaxFeeStroops } from "@/app/demolish/_lib/fees";
import {
  nodeExplainer,
  nodeLabel,
  nodePlainLabel,
  phaseForNode,
} from "@/app/demolish/_lib/plan-copy";
import { computeReviewMoney } from "@/app/demolish/_lib/review-money";
import { MAX_PER_OP_FEE } from "@/lib/orchestrator/executor";
import type { PlanNode } from "@/lib/plan/tree";

import { makeAudit } from "./demolish-fixtures";

function exitTrustline(): PlanNode {
  return {
    id: "add-exit-trustline:C1",
    kind: "AddExitTrustline",
    dependencies: [],
    description: "",
    status: "pending",
    metadata: {
      kind: "AddExitTrustline",
      code: "USDC",
      issuer: "GISSUER",
      contractId: "C1",
    },
  } as PlanNode;
}

describe("the payout trustline step a pool exit needs", () => {
  it("is listed with the withdrawals it runs ahead of", () => {
    const node = exitTrustline();
    expect(phaseForNode(node)).toBe("DeFi withdrawals");
    expect(nodeLabel(node)).toBe("Add payout trustline");
    expect(nodePlainLabel(node)).toBe("Let the account hold a token a pool pays out");
    expect(nodeExplainer(node, { deterministic: false })).toMatch(/reserve, which comes back/);
  });

  it("is priced as one classic operation, not as a free soroban step", () => {
    const node = exitTrustline();
    expect(nodeFeeStroops(node)).toBe(100);
    expect(nodeMaxFeeStroops(node)).toBe(MAX_PER_OP_FEE);
  });

  it("uses the built envelope's fee once the preview has checked it", () => {
    const node = exitTrustline();
    node.status = "simulated";
    node.simulated = {
      kind: "classic",
      xdr: "",
      operationCount: 1,
      estimatedFee: "250",
      transactionCount: 1,
    };
    expect(nodeFeeStroops(node)).toBe(250);
  });

  it("counts in the review's worst-case fee and claims no proceeds", () => {
    const money = computeReviewMoney({ audit: makeAudit(), ordered: [exitTrustline()] });
    expect(money.maxFeeStroops).toBe(BigInt(MAX_PER_OP_FEE));
    expect(money.notCounted).toEqual([]);
  });
});
