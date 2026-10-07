// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { savePendingForward, type PendingForwardStatus } from "@/lib/mediator/pending-flow";
import { topologicalOrder, type PlanTree } from "@/lib/plan/tree";

import { DemolishStatusWidget } from "@/app/demolish/_components/StatusWidget";
import { groupPlanNodes } from "@/app/demolish/_lib/plan-copy";

import { ACC, DEST, blendPositions, makeTree } from "./demolish-fixtures";

const MEDIATOR = Keypair.random().publicKey();

// the forward banner reads the mediator's state from Horizon; here the chain's
// answer is set per test, and the rest of the record store is the real one
const chain = vi.hoisted(() => ({
  status: { kind: "awaiting-forward" } as PendingForwardStatus,
  inspected: [] as string[],
}));
vi.mock("@/lib/mediator/pending-flow", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/mediator/pending-flow")>();
  return {
    ...orig,
    isCloseInFlight: async () => false,
    inspectPendingForward: async (r: { mediatorPublicKey: string }) => {
      chain.inspected.push(r.mediatorPublicKey);
      return chain.status;
    },
  };
});

beforeEach(() => {
  // a record is only removed by naming its flow, so each test starts clean
  window.localStorage.clear();
  chain.status = { kind: "awaiting-forward" };
  chain.inspected = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function saveRecord(mediatorPublicKey: string = MEDIATOR): void {
  savePendingForward({
    publicKey: ACC,
    mediatorPublicKey,
    flowToken: "token",
    ultimateDestination: DEST,
    networkId: "testnet",
    savedAt: Date.now(),
  });
}

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
  it("after the merge into the helper account, never says the account is open", async () => {
    saveRecord();
    renderWidget(mediatorTreeMergedForwardFailed());
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/still open/i);
    expect(text).not.toMatch(/Nothing was lost/i);
    expect(text).not.toMatch(/funds are safe/i);
    expect(text).toMatch(/temporary forwarding account/i);
    expect(await screen.findByRole("button", { name: /Resume the forward/i })).toBeTruthy();
    // the note points at the resume, not at the generic retry promise
    const note = screen.getByTestId("demolish-failure-note").textContent ?? "";
    expect(note).not.toMatch(/steps marked done are not repeated/);
  });

  it("offers only the failed close's own forward, not another flow's record", async () => {
    const other = Keypair.random().publicKey();
    saveRecord(other);
    renderWidget(mediatorTreeMergedForwardFailed());
    // this close's record is missing, so there is nothing to resume from here
    expect(screen.getByTestId("demolish-failure-note").textContent ?? "").toMatch(
      /no saved record/i,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(chain.inspected).not.toContain(other);
    expect(screen.queryByRole("button", { name: /Resume the forward/i })).toBeNull();
  });

  it("switches the note once the forward is found delivered", async () => {
    saveRecord();
    chain.status = { kind: "delivered", txHash: "f".repeat(64), ledger: 12 };
    renderWidget(mediatorTreeMergedForwardFailed());
    await waitFor(() =>
      expect(screen.getByTestId("demolish-failure-note").textContent ?? "").toMatch(
        /forward was delivered/i,
      ),
    );
    expect(document.body.textContent ?? "").toMatch(/Exchange forward delivered/);
  });

  it("marks a step with a landed receipt done even after a later event failed it", () => {
    renderWidget(mediatorTreeMergedForwardFailed());
    const rows = document.body.textContent ?? "";
    expect(rows).toMatch(/Done: Close the account and send everything/);
    expect(rows).not.toMatch(/Failed: Close the account and send everything/);
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

  it("says the storage couldn't be read instead of crashing (H-03)", () => {
    const spy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage is disabled");
    });
    try {
      renderWidget(mediatorTreeMergedForwardFailed());
      const note = screen.getByTestId("demolish-failure-note").textContent ?? "";
      expect(note).toMatch(/storage couldn't be read/);
      expect(note).toMatch(/storage is disabled/);
      expect(note).toMatch(/temporary forwarding account/i);
    } finally {
      spy.mockRestore();
    }
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

describe("the failed view says what landed and what Retry does (L-17)", () => {
  it("lists the close's landed transactions with explorer links", () => {
    const hash = "d".repeat(64);
    renderWidget(makeTree(), { landedPhases: [{ txHash: hash, ledger: 41 }] });
    const landed = screen.getByTestId("landed-phases");
    expect(landed.textContent).toMatch(/on chain and are not undone/);
    expect(landed.querySelector("a")?.getAttribute("href")).toBe(
      `https://stellar.expert/explorer/testnet/tx/${hash}`,
    );
  });

  it("lists nothing and claims nothing extra when no transaction landed", () => {
    renderWidget(makeTree(), { landedPhases: [] });
    expect(screen.queryByTestId("landed-phases")).toBeNull();
    expect(screen.getByTestId("demolish-failure-note").getAttribute("data-kind")).toBe(
      "nothing-ran",
    );
  });

  it("never says nothing finished when an intermediate close batch landed (H-30)", () => {
    const hash = "b".repeat(64);
    renderWidget(makeTree(), { landedPhases: [{ txHash: hash, ledger: 7 }] });
    const note = screen.getByTestId("demolish-failure-note");
    expect(note.getAttribute("data-kind")).toBe("partial");
    expect(note.textContent).not.toMatch(/No step of this close finished/);
    expect(note.textContent).toMatch(/still open/);
    // the landed transaction is listed inside the note, with its link
    const landed = within(note).getByTestId("landed-phases");
    expect(landed.querySelector("a")?.getAttribute("href")).toBe(
      `https://stellar.expert/explorer/testnet/tx/${hash}`,
    );
    expect(document.body.textContent).not.toMatch(/None of the close/);
  });

  it("doesn't deny a landed Soroban step when no close batch landed (H-30)", () => {
    const tree = makeTree({ positions: blendPositions() });
    for (const n of tree.allNodes.values()) {
      if (n.kind === "RepayBlend" || n.kind === "WithdrawBlend") {
        n.status = "confirmed";
        n.executed = {
          txHash: n.kind === "RepayBlend" ? "1".repeat(64) : "2".repeat(64),
          ledger: 5,
        };
      }
    }
    renderWidget(tree, { landedPhases: [] });
    const text = document.body.textContent ?? "";
    expect(screen.getByTestId("demolish-failure-note").textContent).toMatch(
      /Some steps already ran/,
    );
    expect(text).not.toMatch(/None of the close/);
    expect(text).not.toMatch(/No step of this close finished/);
  });

  it("doesn't deny the merge after the funds reached the helper account (H-30)", () => {
    saveRecord();
    renderWidget(mediatorTreeMergedForwardFailed(), { landedPhases: [] });
    expect(document.body.textContent ?? "").not.toMatch(/None of the close/);
  });

  it("explains each kind Retry handles differently", () => {
    renderWidget(makeTree(), { failureKind: "bundle_stale", retryResumes: false });
    expect(screen.getByTestId("failure-kind-note").textContent).toMatch(/new signing request/);
    cleanup();
    renderWidget(makeTree(), { failureKind: "conversion_refused", retryResumes: false });
    expect(screen.getByTestId("failure-kind-note").textContent).toMatch(/price moved/);
    cleanup();
    renderWidget(makeTree(), { failureKind: "claim_unavailable", retryResumes: false });
    expect(screen.getByTestId("failure-kind-note").textContent).toMatch(
      /leave those rewards unclaimed/,
    );
    cleanup();
    // the run guard raises this too, on a wallet or network change
    renderWidget(makeTree(), { failureKind: "interrupted", retryResumes: true });
    expect(screen.getByTestId("failure-kind-note").textContent).not.toMatch(/You stopped/);
  });

  it("shows what best-effort steps left undone, on success too", () => {
    renderWidget(makeTree(), {
      state: "succeeded",
      error: null,
      executionNotes: ["Token CABC was sent as-is: the swap had no route."],
    });
    expect(screen.getByTestId("execution-notes").textContent).toMatch(/sent as-is/);
  });

  it("keeps the discovery diagnostics in a collapsed section", () => {
    renderWidget(makeTree(), { discoveryDiagnostics: ["aquarius: rpc -32001 after 10s"] });
    const details = screen.getByTestId("discovery-diagnostics");
    expect(details.tagName).toBe("DETAILS");
    expect(details.textContent).toMatch(/-32001/);
  });
});

describe("a run that only prepared the close (M-25)", () => {
  it("doesn't call the account closed", () => {
    const tree: PlanTree = {
      ...makeTree(),
      prepareOnly: {
        unlocksAt: new Date("2026-10-24T00:00:00Z"),
        reason: "A Blend backstop withdrawal stays locked after this run.",
      },
    };
    const prepared = {
      unlocksAt: new Date("2026-10-25T12:00:00Z"),
      reason: "The queued backstop withdrawal unlocks later.",
    };
    let done = 0;
    renderWidget(tree, {
      state: "prepared",
      prepared,
      error: null,
      onPreparedDone: () => {
        done += 1;
      },
    });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Account closed/);
    expect(text).not.toMatch(/permanently closed/);
    expect(text).not.toMatch(/Back to landing/);
    const note = screen.getByTestId("prepared-note").textContent ?? "";
    expect(note).toMatch(/still open/);
    // the run's own unlock time and reason, not the plan's estimate
    expect(note).toMatch(/unlocks later/);
    expect(note).toMatch(/2026/);
    fireEvent.click(screen.getByTestId("demolish-prepared-done"));
    expect(done).toBe(1);
  });
});
