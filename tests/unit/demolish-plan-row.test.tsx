// @vitest-environment happy-dom

// the Review's step rows: which fee figure is labelled a maximum, the note on a
// step that is only built once the steps before it land, and a fee the page
// can't read

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { TESTNET } from "@/lib/config/networks";
import { topologicalOrder, type PlanNode, type PlanTree } from "@/lib/plan/tree";

import { PlanRow } from "@/app/demolish/_components/PlanRow";
import { ReviewPanel } from "@/app/demolish/_components/ReviewPanel";
import { nodeFeeStroops, nodeMaxFeeStroops, stroopsToXlm } from "@/app/demolish/_lib/fees";
import { groupPlanNodes } from "@/app/demolish/_lib/plan-copy";

import { DEST, blendPositions, makeAudit, makeTree } from "./demolish-fixtures";

afterEach(cleanup);

// a close of ten classic operations the preview built at 100 stroops each
function tenOpClose(): PlanNode {
  const tree = makeTree({
    audit: makeAudit({
      data: Array.from({ length: 9 }, (_, i) => ({ name: `k${i}`, value: "dg==" })),
      subentryCount: 9,
    }),
  });
  const final = tree.allNodes.get("final-classic-tx")!;
  if (final.kind !== "FinalClassicTx") throw new Error("no close node");
  const ops = final.metadata.batches.reduce((n, b) => n + b.operations.length, 0);
  final.status = "simulated";
  final.simulated = {
    kind: "classic",
    xdr: "",
    operationCount: ops,
    estimatedFee: String(ops * 100),
    transactionCount: final.metadata.batches.length,
  };
  return final;
}

function feeText(): string {
  return screen.getByTestId("plan-row-fee").textContent ?? "";
}

describe("fee labels on a step row (L-19)", () => {
  it("never shows a classic step's typical fee as its maximum", () => {
    const node = tenOpClose();
    const typical = stroopsToXlm(nodeFeeStroops(node));
    const max = stroopsToXlm(nodeMaxFeeStroops(node));
    expect(max).not.toBe(typical);
    render(<PlanRow node={node} network={TESTNET} mode="plan" index={1} />);
    const text = feeText();
    expect(text).not.toContain(`up to ${typical} XLM`);
    expect(text).toContain(`about ${typical} XLM`);
    expect(text).toContain(`up to ${max} XLM`);
  });

  it("labels a soroban step's signed fee as the maximum", () => {
    const tree = makeTree({ positions: blendPositions() });
    const repay = [...tree.allNodes.values()].find((n) => n.kind === "RepayBlend")!;
    repay.status = "simulated";
    repay.simulated = {
      kind: "soroban",
      retval: null,
      minResourceFee: "50000",
      maxFee: "131000",
      transactionData: undefined as never,
      latestLedger: 1,
      auth: [],
      restorePreambleRequired: false,
    } as never;
    render(<PlanRow node={repay} network={TESTNET} mode="plan" index={1} />);
    expect(feeText()).toBe("fee up to 0.0131 XLM");
  });

  it("shows an unreadable fee on its own row instead of failing the page", () => {
    const node = tenOpClose();
    if (node.simulated?.kind !== "classic") throw new Error("not classic");
    node.simulated = { ...node.simulated, estimatedFee: "12.5" };
    render(<PlanRow node={node} network={TESTNET} mode="plan" index={1} />);
    expect(screen.getByTestId("plan-row-fee-error").textContent).toMatch(/malformed fee "12\.5"/);
    expect(screen.queryByTestId("plan-row-fee")).toBeNull();
  });
});

describe("an unreadable fee on Review", () => {
  it("keeps the Review up, says why and blocks the confirm", () => {
    const node = tenOpClose();
    if (node.simulated?.kind !== "classic") throw new Error("not classic");
    node.simulated = { ...node.simulated, estimatedFee: "-1" };
    render(
      <ReviewPanel
        planGroups={[{ phase: "Merge", nodes: [node] }]}
        audit={makeAudit()}
        baseReserveStroops={5_000_000}
        destination={DEST}
        memo={null}
        useMediator={false}
        deterministic={false}
        network={TESTNET}
        onBack={() => {}}
        onDemolish={() => {}}
      />,
    );
    expect(screen.getByTestId("review-blockers").textContent).toMatch(/fees of this plan/);
    expect((screen.getByTestId("demolish-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("a step built only after earlier steps land (H-18)", () => {
  function deferredTree(): PlanTree {
    const tree = makeTree({ positions: blendPositions() });
    const repay = [...tree.allNodes.values()].find((n) => n.kind === "RepayBlend")!;
    const withdraw = [...tree.allNodes.values()].find((n) => n.kind === "WithdrawBlend")!;
    withdraw.status = "pending";
    withdraw.deferred = { after: [repay.id], reason: "the collateral is known after the repay" };
    return tree;
  }

  it("names the step it waits for and shows no fee or error", () => {
    const tree = deferredTree();
    const ordered = topologicalOrder(tree);
    render(
      <ReviewPanel
        planGroups={groupPlanNodes(ordered)}
        audit={makeAudit()}
        baseReserveStroops={5_000_000}
        destination={DEST}
        memo={null}
        useMediator={false}
        deterministic={false}
        network={TESTNET}
        onBack={() => {}}
        onDemolish={() => {}}
      />,
    );
    const note = screen.getByTestId("deferred-note").textContent ?? "";
    expect(note).toMatch(/Built after Repay a loan on Blend confirms/);
    expect(note).toMatch(/fee is shown when it is built/);
    const row = screen.getByTestId("deferred-note").closest("[data-testid='plan-row']")!;
    expect(row.querySelector("[data-testid='plan-row-fee']")).toBeNull();
    expect(row.querySelector("[data-testid='plan-row-error']")).toBeNull();
  });
});
