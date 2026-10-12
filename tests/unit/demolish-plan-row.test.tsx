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

  it("shows a soroban step's built fee as usual and its class cap as the most (NP5-42)", () => {
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
    // the step is re-simulated before signing; a blend step is never signed
    // above 0.01 XLM inclusion + 3.3 XLM
    expect(feeText()).toBe("fee about 0.0131 XLM, up to 3.31 XLM");
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
        baseReserveError={null}
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

  it("names the step it waits for, shows the most it can be signed for and no error", () => {
    const tree = deferredTree();
    const ordered = topologicalOrder(tree);
    render(
      <ReviewPanel
        planGroups={groupPlanNodes(ordered)}
        audit={makeAudit()}
        baseReserveStroops={5_000_000}
        baseReserveError={null}
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
    expect(note).toMatch(/exact fee is known once it is built/);
    expect(note).toMatch(/never signed above the fee shown/);
    const row = screen.getByTestId("deferred-note").closest("[data-testid='plan-row']")!;
    expect(row.querySelector("[data-testid='plan-row-fee']")?.textContent).toBe(
      "fee up to 3.31 XLM",
    );
    expect(row.querySelector("[data-testid='plan-row-error']")).toBeNull();
    // the review's total names the steps it could not price yet (the repay is
    // not built in this fixture either)
    expect(document.body.textContent).toContain(
      "plus 2 steps priced when they are built, at most 6.92 XLM",
    );
  });
});

// the review shows a step's check result only as colour and a badge, so the
// screen-reader prefix has to say it (NPF-26)
describe("screen-reader status words on a review row", () => {
  function nodesOf(kind: PlanNode["kind"]): PlanNode {
    const node = topologicalOrder(makeTree({ positions: blendPositions() })).find(
      (n) => n.kind === kind,
    );
    if (node === undefined) throw new Error(`no ${kind} node`);
    return node;
  }

  function rowText(node: PlanNode, mode: "plan" | "live", index?: number): string {
    const { unmount } = render(
      <PlanRow
        node={node}
        network={TESTNET}
        mode={mode}
        {...(index !== undefined ? { index } : {})}
      />,
    );
    const text = screen.getByTestId("plan-row").textContent ?? "";
    unmount();
    return text;
  }

  it("says the classic close was checked offline, not dry run", () => {
    const close = tenOpClose();
    expect(rowText(close, "plan", 3)).toMatch(/^Step 3, Checked offline: /);
  });

  it("says a simulated soroban step passed its dry run", () => {
    const repay = nodesOf("RepayBlend");
    repay.status = "simulated";
    expect(rowText(repay, "plan", 1)).toMatch(/^Step 1, Dry run passed: /);
  });

  it("says a soroban step failed its dry run", () => {
    const repay = nodesOf("RepayBlend");
    repay.status = "failed";
    expect(rowText(repay, "plan", 2)).toMatch(/^Step 2, Dry run failed: /);
  });

  it("says a skipped step is skipped and gives it no step number", () => {
    const withdraw = nodesOf("WithdrawBlend");
    withdraw.status = "skipped";
    const text = rowText(withdraw, "plan");
    expect(text).toMatch(/^Skipped: /);
    expect(text).not.toMatch(/Step \d/);
  });

  it("says an unchecked step was not checked", () => {
    const repay = nodesOf("RepayBlend");
    expect(repay.status).toBe("pending");
    expect(rowText(repay, "plan", 1)).toMatch(/^Step 1, Not checked: /);
  });

  // during the run a step that has not run is still "simulated", and it must
  // read as waiting, not as a passed check
  it("reads a not-yet-run simulated step as pending during the run", () => {
    const repay = nodesOf("RepayBlend");
    repay.status = "simulated";
    expect(rowText(repay, "live")).toMatch(/^Pending: /);
  });
});
