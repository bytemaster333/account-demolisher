// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { savePendingForward, clearPendingForward } from "@/lib/mediator/pending-flow";
import { topologicalOrder, type PlanTree } from "@/lib/plan/tree";

import { DemolishStatusWidget } from "@/app/demolish/_components/StatusWidget";
import { groupPlanNodes } from "@/app/demolish/_lib/plan-copy";

import { ACC, DEST, blendPositions, makeTree } from "./demolish-fixtures";

const MEDIATOR = Keypair.random().publicKey();

afterEach(() => {
  cleanup();
  clearPendingForward();
  vi.unstubAllGlobals();
});

type WidgetProps = Parameters<typeof DemolishStatusWidget>[0];

function renderWidget(tree: PlanTree, over: Partial<WidgetProps> = {}) {
  const ordered = topologicalOrder(tree);
  const props: WidgetProps = {
    state: "failed",
    tree,
    planGroups: groupPlanNodes(ordered),
    doneCount: 0,
    activeCount: ordered.length,
    network: TESTNET,
    closedAccount: ACC,
    destination: DEST,
    mergeHash: tree.allNodes.get("final-classic-tx")?.executed?.txHash ?? null,
    delivered: { status: "loading" },
    error: "MediatorForward failed: Could not load mediator account",
    signingMode: "wallet",
    retryResumes: true,
    onRetry: () => {},
    onReset: () => {},
    ...over,
  };
  return render(<DemolishStatusWidget {...props} />);
}

function mediatorTreeMergedForwardFailed(): PlanTree {
  const tree = makeTree({
    opts: { useMediator: true, mediatorPublicKey: MEDIATOR, flowToken: "token" },
  });
  const final = tree.allNodes.get("final-classic-tx")!;
  final.executed = { txHash: "a".repeat(64), ledger: 9 };
  final.status = "failed";
  tree.allNodes.get("mediator-forward")!.status = "failed";
  return tree;
}

describe("failed state copy follows what actually ran (H-30)", () => {
  it("after the merge into the helper account, never says the account is open", () => {
    savePendingForward({
      publicKey: ACC,
      mediatorPublicKey: MEDIATOR,
      flowToken: "token",
      ultimateDestination: DEST,
      networkId: "testnet",
      savedAt: Date.now(),
    });
    renderWidget(mediatorTreeMergedForwardFailed());
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/still open/i);
    expect(text).not.toMatch(/Nothing was lost/i);
    expect(text).not.toMatch(/funds are safe/i);
    expect(text).toMatch(/temporary forwarding account/i);
    expect(screen.getByRole("button", { name: /Resume the forward/i })).toBeTruthy();
  });

  it("doesn't point at a resume button that isn't there when no record was saved", () => {
    // storage was blocked when the forward was recorded
    renderWidget(mediatorTreeMergedForwardFailed());
    const note = screen.getByTestId("demolish-failure-note").textContent ?? "";
    expect(note).toMatch(/temporary forwarding account/i);
    expect(note).not.toMatch(/Resume the forward now/);
    expect(note).toMatch(/no saved record/i);
    expect(screen.queryByRole("button", { name: /Resume the forward/i })).toBeNull();
  });

  it("says steps already ran when a Soroban step confirmed", () => {
    const tree = makeTree({ positions: blendPositions() });
    const repay = [...tree.allNodes.values()].find((n) => n.kind === "RepayBlend")!;
    repay.status = "confirmed";
    repay.executed = { txHash: "c".repeat(64), ledger: 3 };
    renderWidget(tree, { error: "submitSoroban: transaction x failed on-chain" });
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Some steps already ran/i);
    expect(text).not.toMatch(/balance is untouched/i);
    expect(text).not.toMatch(/Nothing was lost/i);
  });

  it("may say the account is unchanged only when nothing ran", () => {
    renderWidget(makeTree(), { error: "tx_bad_seq" });
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/still open/i);
    expect(text).not.toMatch(/Nothing was lost/i);
  });

  it("does not promise Retry resumes when it will rebuild instead", () => {
    renderWidget(makeTree(), {
      error: "account_merge blocked: position(s) still open",
      retryResumes: false,
    });
    expect(document.body.textContent ?? "").not.toMatch(/continue from where it stopped/i);
  });
});

describe("success state amount and receipt (M-34, L-56)", () => {
  function closedTree(): PlanTree {
    const tree = makeTree();
    const final = tree.allNodes.get("final-classic-tx")!;
    final.status = "confirmed";
    final.executed = { txHash: "e".repeat(64), ledger: 4 };
    return tree;
  }

  it("shows the delivered amount from chain data", () => {
    renderWidget(closedTree(), {
      state: "succeeded",
      delivered: { status: "ok", xlm: "120.5" },
      error: null,
    });
    expect(document.body.textContent ?? "").toMatch(/120\.5 XLM/);
    expect(document.body.textContent ?? "").not.toMatch(/100\.0000000 XLM/);
  });

  it("says no number while the amount is unknown", () => {
    renderWidget(closedTree(), {
      state: "succeeded",
      delivered: { status: "unavailable" },
      error: null,
    });
    expect(document.body.textContent ?? "").toMatch(/Your remaining balance was sent/i);
  });

  it("falls back to a selectable receipt when the clipboard is missing", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    renderWidget(closedTree(), {
      state: "succeeded",
      delivered: { status: "ok", xlm: "1" },
      error: null,
    });
    fireEvent.click(screen.getByTestId("demolish-copy-receipt"));
    const area = await screen.findByTestId("demolish-receipt-text");
    expect((area as HTMLTextAreaElement).value).toContain(`Closed account: ${ACC}`);
    expect(screen.getByTestId("demolish-download-receipt")).toBeTruthy();
  });

  it("falls back when writeText rejects", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
    });
    renderWidget(closedTree(), {
      state: "succeeded",
      delivered: { status: "ok", xlm: "1" },
      error: null,
    });
    fireEvent.click(screen.getByTestId("demolish-copy-receipt"));
    await waitFor(() => expect(screen.getByTestId("demolish-receipt-text")).toBeTruthy());
  });

  it("announces a successful copy in a live region (L-64)", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: () => Promise.resolve() },
    });
    renderWidget(closedTree(), {
      state: "succeeded",
      delivered: { status: "ok", xlm: "1" },
      error: null,
    });
    fireEvent.click(screen.getByTestId("demolish-copy-receipt"));
    await waitFor(() =>
      expect(screen.getByTestId("demolish-copy-status").textContent).toMatch(/copied/i),
    );
    expect(screen.getByTestId("demolish-copy-status").getAttribute("role")).toBe("status");
  });
});

describe("executing copy matches how steps are signed (L-58)", () => {
  it("does not tell a secret-key user to wait for a wallet popup", () => {
    renderWidget(makeTree(), { state: "executing", signingMode: "secret", error: null });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/wallet will pop up/i);
    expect(text).toMatch(/with your key in this browser/i);
  });

  it("says a bundle submit signs nothing", () => {
    renderWidget(makeTree(), { state: "executing", signingMode: "bundle", error: null });
    expect(document.body.textContent ?? "").toMatch(/Submitting the collected signatures/i);
  });

  it("keeps the wallet prompt for a wallet connector", () => {
    renderWidget(makeTree(), { state: "executing", signingMode: "wallet", error: null });
    expect(document.body.textContent ?? "").toMatch(/wallet will pop up/i);
  });
});
