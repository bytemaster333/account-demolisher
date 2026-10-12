// @vitest-environment happy-dom

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import type { ClaimableBalanceEntry } from "@/lib/types/account";

import { AcknowledgePanel } from "@/app/demolish/_components/AcknowledgePanel";
import { claimableSplit } from "@/app/demolish/_lib/claimables";
import { heldSelectionDirty } from "@/app/demolish/_lib/held-selection";

import { ACC, TOKEN_C, makeAudit, makeTree } from "./demolish-fixtures";

afterEach(cleanup);

const NOW = Date.parse("2026-10-02T12:00:00Z");
const UNLOCK = "2026-10-09T12:00:00Z";

function cb(id: string, predicate: unknown, claimableNow: boolean): ClaimableBalanceEntry {
  return {
    id,
    asset: { kind: "native" },
    amount: "25.0000000",
    sponsor: Keypair.random().publicKey(),
    claimantsRaw: [{ destination: ACC, predicate }],
    claimants: [ACC],
    claimableNow,
  };
}

const READY = `00000000${"a1".repeat(32)}`;
const LOCKED = `00000000${"c3".repeat(32)}`;

function split() {
  const audit = makeAudit({
    claimableBalances: [
      cb(READY, { unconditional: true }, true),
      // "not before UNLOCK": locked until next week
      cb(LOCKED, { not: { abs_before: UNLOCK } }, false),
    ],
  });
  return claimableSplit({ audit, tree: makeTree({ audit }), publicKey: ACC, nowMs: NOW });
}

type Props = Parameters<typeof AcknowledgePanel>[0];

function renderPanel(over: Partial<Props> = {}) {
  const props: Props = {
    network: TESTNET,
    scamFindings: [],
    discoveryWarnings: [],
    claimables: { collectCount: 0, leftBehind: [], trustlineChanges: [] },
    sponsorshipCount: 0,
    baseReserveStroops: 5_000_000,
    highValue: null,
    rebuildRequired: null,
    onRebuild: () => {},
    onBack: () => {},
    onContinue: () => {},
    ...over,
  };
  return render(<AcknowledgePanel {...props} />);
}

describe("claimable balances that can't be collected yet (M-38)", () => {
  it("splits collectable from locked balances and finds the unlock time", () => {
    const s = split();
    expect(s.collectCount).toBe(1);
    expect(s.leftBehind.map((l) => l.id)).toEqual([LOCKED]);
    const unlock = s.leftBehind[0]!.unlock;
    expect(unlock.kind).toBe("at");
    if (unlock.kind === "at") expect(unlock.at.toISOString()).toBe(new Date(UNLOCK).toISOString());
  });

  it("does not call a balance it could claim now locked when the plan leaves it out", () => {
    const audit = makeAudit({ claimableBalances: [cb(READY, { unconditional: true }, true)] });
    // a plan built before this balance arrived (or with it unticked) doesn't claim it
    const tree = makeTree({ audit, opts: { selectedClaimableBalanceIds: [] } });
    const s = claimableSplit({ audit, tree, publicKey: ACC, nowMs: NOW });
    expect(s.leftBehind.map((l) => l.unlock.kind)).toEqual(["now"]);
    renderPanel({ claimables: s });
    const notice = screen.getByTestId("locked-claimables-notice").textContent ?? "";
    expect(notice).toMatch(/isn't part of this close/);
    expect(notice).not.toMatch(/can no longer be collected/);
  });

  it("counts only collectable balances and gates Continue on the left-behind card", () => {
    renderPanel({ claimables: split() });
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Collects 1 pending payment/);
    expect(text).not.toMatch(/into your XLM/);
    expect(screen.getByTestId("locked-claimables-notice").textContent).toMatch(/25\.0000000 XLM/);
    fireEvent.click(screen.getByTestId("ack-autohandled"));
    const cont = screen.getByTestId("acknowledge-continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("ack-locked-claimables"));
    expect(cont.disabled).toBe(false);
  });
});

describe("token choices must be rebuilt before Continue (M-39)", () => {
  it("blocks Continue with the reason and offers the rebuild", () => {
    renderPanel({ rebuildRequired: "Rebuild the plan to apply your token choices." });
    const cont = screen.getByTestId("acknowledge-continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(document.body.textContent ?? "").toMatch(/Rebuild the plan to apply your token choices/);
    expect(screen.getByTestId("acknowledge-rebuild")).toBeTruthy();
  });

  it("detects a ticked token or a flipped convert toggle that the plan doesn't have", () => {
    const token = { contractId: TOKEN_C, balance: 9n };
    expect(heldSelectionDirty([token], false, { selectedHeldTokens: [] })).toBe(true);
    expect(heldSelectionDirty([token], false, { selectedHeldTokens: [token] })).toBe(false);
    expect(
      heldSelectionDirty([token], true, {
        selectedHeldTokens: [token],
        convertHeldTokensToXLM: false,
      }),
    ).toBe(true);
    expect(heldSelectionDirty([], false, { selectedHeldTokens: [token] })).toBe(true);
    // a balance change on the same contract is a different sweep amount
    expect(
      heldSelectionDirty([{ contractId: TOKEN_C, balance: 10n }], false, {
        selectedHeldTokens: [token],
      }),
    ).toBe(true);
    // convert with nothing selected is not applied by the plan either way
    expect(heldSelectionDirty([], true, {})).toBe(false);
  });
});

describe("released reserves wording (L-59)", () => {
  it("states the count of reserves and the live per-reserve amount", () => {
    renderPanel({ sponsorshipCount: 2 });
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/2 sponsored reserves \(0\.5 XLM each\)/);
    expect(text).not.toMatch(/2 XLM deposits/);
  });
});

describe("what the plan does with pending payments (H-09)", () => {
  const ISSUER = Keypair.random().publicKey();
  const usdc = { kind: "credit" as const, code: "USDC", issuer: ISSUER };
  const balance = (id: string, issuerAuthRequired: boolean): ClaimableBalanceEntry => ({
    ...cb(id, { unconditional: true }, true),
    asset: usdc,
    issuerAuthRequired,
  });

  it("opens a trustline it can and says why it leaves one it can't", () => {
    const opened = makeAudit({ claimableBalances: [balance(READY, false)] });
    const s1 = claimableSplit({
      audit: opened,
      tree: makeTree({ audit: opened }),
      publicKey: ACC,
      nowMs: NOW,
    });
    expect(s1.collectCount).toBe(1);
    expect(s1.trustlineChanges).toEqual([{ asset: usdc, change: "add" }]);
    renderPanel({ claimables: s1 });
    expect(screen.getByTestId("auto-handled-notice").textContent).toMatch(
      /Opens a trustline \(USDC\).*0\.5 XLM reserve/,
    );
    cleanup();

    const refused = makeAudit({ claimableBalances: [balance(LOCKED, true)] });
    const s2 = claimableSplit({
      audit: refused,
      tree: makeTree({ audit: refused }),
      publicKey: ACC,
      nowMs: NOW,
    });
    expect(s2.leftBehind.map((l) => l.reason)).toEqual(["no_trustline"]);
    renderPanel({ claimables: s2 });
    expect(screen.getByTestId("locked-claimables-notice").textContent).toMatch(
      /25\.0000000 USDC, the account has no trustline for it/,
    );
  });

  it("lets the user untick a payment, but not one this account sponsors", () => {
    const toggled: [string, boolean][] = [];
    renderPanel({
      claimChoices: {
        balances: [
          { id: READY, asset: { kind: "native" }, amount: "25.0000000", locked: false },
          { id: LOCKED, asset: { kind: "native" }, amount: "3.0000000", locked: true },
        ],
        selected: new Set([READY]),
        onToggle: (id, v) => toggled.push([id, v]),
      },
    });
    fireEvent.click(screen.getByTestId(`cb-checkbox-${READY}`));
    expect(toggled).toEqual([[READY, false]]);
    expect(screen.queryByTestId(`cb-checkbox-${LOCKED}`)).toBeNull();
    expect(screen.getByTestId("claim-choices").textContent).toMatch(/always collected/);
  });
});

describe("the high-value acknowledgement counts what the close moves (M-22)", () => {
  it("states the estimated XLM and the holdings it can't price", () => {
    renderPanel({ highValue: { estimatedXlm: "1500.0000000", unpricedHoldings: 2 } });
    const text = screen.getByTestId("high-value-notice").textContent ?? "";
    expect(text).toMatch(/about 1500\.0000000 XLM/);
    expect(text).toMatch(/plus 2 holdings whose value couldn't be estimated/);
  });
});

describe("the Check the plan step separates choices from notes", () => {
  const ISSUER = Keypair.random().publicKey();
  const conversionChoices = {
    credits: [{ key: `USDC:${ISSUER}`, code: "USDC", issuer: ISSUER, amount: "3.0000000" }],
    viaExchange: false,
    choiceFor: () => "sell" as const,
    onChoose: () => {},
  };

  it("puts the conversion choices under Your choices and the notes under Things to know", () => {
    renderPanel({ conversionChoices, planNotes: ["A note about this plan."] });
    const choices = screen.getByTestId("acknowledge-choices");
    const notes = screen.getByTestId("acknowledge-notes");
    expect(choices.textContent).toMatch(/^Your choices/);
    expect(notes.textContent).toMatch(/^Things to know/);
    expect(choices.contains(screen.getByTestId("conversion-choices"))).toBe(true);
    expect(notes.contains(screen.getByTestId("plan-notes"))).toBe(true);
    // choices come first
    expect(choices.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/Just read, nothing to fix/)).toBeNull();
  });

  it("shows no notes section when there is only a choice, and lets it continue", () => {
    renderPanel({ conversionChoices });
    expect(screen.queryByTestId("acknowledge-notes")).toBeNull();
    expect(screen.getByTestId("acknowledge-continue").hasAttribute("disabled")).toBe(false);
  });
});
