import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { topologicalOrder } from "@/lib/plan/tree";

import { failureNoteFor } from "@/app/demolish/_lib/failure-note";
import { buildReceiptText, sumDeliveredXlm } from "@/app/demolish/_lib/receipt";

import { ACC, DEST, blendPositions, makeTree } from "./demolish-fixtures";

const MEDIATOR = Keypair.random().publicKey();

function mediatorTree() {
  return makeTree({
    opts: { useMediator: true, mediatorPublicKey: MEDIATOR, flowToken: "token" },
  });
}

describe("failure note derived from the tree (H-30)", () => {
  it("says the funds sit in the helper account when the merge landed but the forward didn't", () => {
    const tree = mediatorTree();
    const final = tree.allNodes.get("final-classic-tx")!;
    final.status = "confirmed";
    final.executed = { txHash: "a".repeat(64), ledger: 10 };
    const forward = tree.allNodes.get("mediator-forward")!;
    forward.status = "failed";
    const note = failureNoteFor(tree);
    expect(note.kind).toBe("in-mediator");
    if (note.kind === "in-mediator") {
      expect(note.mergeHash).toBe("a".repeat(64));
      expect(note.mediatorPublicKey).toBe(MEDIATOR);
    }
  });

  it("still reports the helper account when a blocked event overwrote the merge status", () => {
    const tree = mediatorTree();
    const final = tree.allNodes.get("final-classic-tx")!;
    final.executed = { txHash: "b".repeat(64), ledger: 10 };
    // applyProgressToTree marks the final node failed on a blocked event
    final.status = "failed";
    expect(failureNoteFor(tree).kind).toBe("in-mediator");
  });

  it("lists the steps that already ran when the account is still open", () => {
    const tree = makeTree({ positions: blendPositions() });
    const repay = topologicalOrder(tree).find((n) => n.kind === "RepayBlend")!;
    repay.status = "confirmed";
    repay.executed = { txHash: "c".repeat(64), ledger: 5 };
    const note = failureNoteFor(tree);
    expect(note.kind).toBe("partial");
    if (note.kind === "partial") expect(note.ran.map((n) => n.id)).toEqual([repay.id]);
  });

  it("only says nothing ran when no step has a receipt", () => {
    expect(failureNoteFor(makeTree()).kind).toBe("nothing-ran");
  });
});

describe("delivered amount from chain effects (M-34)", () => {
  it("sums native credits to the destination and ignores everything else", () => {
    const other = Keypair.random().publicKey();
    const total = sumDeliveredXlm(
      [
        { type: "account_credited", account: DEST, asset_type: "native", amount: "19.9999" },
        { type: "account_credited", account: DEST, asset_type: "native", amount: "1.5000000" },
        { type: "account_credited", account: other, asset_type: "native", amount: "500" },
        {
          type: "account_credited",
          account: DEST,
          asset_type: "credit_alphanum4",
          amount: "7",
        },
        { type: "account_debited", account: ACC, asset_type: "native", amount: "21.4999" },
      ],
      DEST,
    );
    expect(total).toBe("21.4999");
  });
});

describe("receipt text (M-34)", () => {
  function closedTree() {
    const tree = makeTree({ positions: blendPositions() });
    for (const n of tree.allNodes.values()) {
      n.status = "confirmed";
      n.executed = { txHash: `${n.id.length}`.padStart(64, "d"), ledger: 1 };
    }
    return tree;
  }

  it("states the delivered amount, the closed account and the merge hash once", () => {
    const tree = closedTree();
    const mergeHash = tree.allNodes.get("final-classic-tx")!.executed!.txHash;
    const text = buildReceiptText({
      closedAccount: ACC,
      destination: DEST,
      deliveredXlm: "120.5",
      network: TESTNET,
      mergeHash,
      ordered: topologicalOrder(tree),
    });
    expect(text).toContain(`Closed account: ${ACC}`);
    expect(text).toContain(`Delivered 120.5 XLM to ${DEST}`);
    expect(text.split(mergeHash).length - 1).toBe(1);
  });

  it("does not invent an amount when the delivered figure is unknown", () => {
    const tree = closedTree();
    const text = buildReceiptText({
      closedAccount: ACC,
      destination: DEST,
      deliveredXlm: null,
      network: TESTNET,
      mergeHash: tree.allNodes.get("final-classic-tx")!.executed!.txHash,
      ordered: topologicalOrder(tree),
    });
    expect(text).toContain(`Your remaining balance was sent to ${DEST}`);
    expect(text).not.toMatch(/\d+(\.\d+)? XLM to/);
  });

  it("records a run that only prepared the close as not closed (M-25)", () => {
    const text = buildReceiptText({
      closedAccount: ACC,
      destination: DEST,
      deliveredXlm: null,
      network: TESTNET,
      mergeHash: null,
      ordered: [],
      preparedUntil: new Date("2026-10-24T00:00:00Z"),
    });
    expect(text).toMatch(/still open/);
    expect(text).not.toMatch(/Closed account/);
    expect(text).toContain("2026-10-24");
  });
});
