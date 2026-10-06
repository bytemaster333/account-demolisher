// @vitest-environment happy-dom

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { topologicalOrder, type PlanTree } from "@/lib/plan/tree";
import type { ClassicMemo } from "@/lib/types/plan";

import { ReviewPanel } from "@/app/demolish/_components/ReviewPanel";
import { stroopsToXlm } from "@/app/demolish/_lib/fees";
import { groupPlanNodes } from "@/app/demolish/_lib/plan-copy";
import { computeReviewMoney } from "@/app/demolish/_lib/review-money";

import { DEST, blendPositions, makeAudit, makeTree } from "./demolish-fixtures";

afterEach(cleanup);

type Props = Parameters<typeof ReviewPanel>[0];

function renderPanel(tree: PlanTree, over: Partial<Props> = {}) {
  const ordered = topologicalOrder(tree);
  const props: Props = {
    planGroups: groupPlanNodes(ordered),
    audit: makeAudit(),
    baseReserveStroops: 5_000_000,
    destination: DEST,
    memo: null,
    useMediator: false,
    deterministic: false,
    network: TESTNET,
    onBack: () => {},
    onDemolish: () => {},
    ...over,
  };
  return render(<ReviewPanel {...props} />);
}

describe("memo on Review (M-40)", () => {
  it("shows the memo type and value next to the destination", () => {
    const memo: ClassicMemo = { type: "id", value: "12345" };
    renderPanel(makeTree({ opts: { memo } }), { memo });
    expect(screen.getByTestId("review-memo").textContent).toMatch(/ID.*12345/);
  });

  it("says explicitly when there is no memo", () => {
    renderPanel(makeTree());
    expect(screen.getByTestId("review-memo").textContent).toMatch(/No memo/i);
  });

  it("explains the memo rides on the delivery payment for an exchange close", () => {
    const memo: ClassicMemo = { type: "text", value: "abc" };
    const mediator = Keypair.random().publicKey();
    renderPanel(
      makeTree({
        opts: { memo, useMediator: true, mediatorPublicKey: mediator, flowToken: "t" },
      }),
      { memo, useMediator: true },
    );
    expect(screen.getByTestId("review-memo").textContent).toMatch(/delivery payment/i);
  });
});

describe("money figures (M-33)", () => {
  it("shows the at-least floor computed from the plan, not the bare balance", () => {
    const tree = makeTree();
    const audit = makeAudit();
    renderPanel(tree, { audit });
    const money = computeReviewMoney({ audit, ordered: topologicalOrder(tree) });
    const text = document.body.textContent ?? "";
    expect(text).toContain(`at least ${stroopsToXlm(money.atLeastStroops)} XLM`);
    expect(text).toContain(`at most ${stroopsToXlm(money.maxFeeStroops)} XLM`);
  });

  it("does not show a reserve figure when the base reserve is unknown", () => {
    renderPanel(makeTree(), { baseReserveStroops: null });
    expect(document.body.textContent ?? "").not.toMatch(/≈ 1 XLM/);
  });
});

describe("step counts and skipped steps (L-60)", () => {
  it("counts only steps that will run and lists the skipped one with its reason", () => {
    const tree = makeTree({ positions: blendPositions() });
    const ordered = topologicalOrder(tree);
    const withdraw = ordered.find((n) => n.kind === "WithdrawBlend")!;
    withdraw.status = "skipped";
    withdraw.error = "Could not build the WithdrawBlend transaction";
    renderPanel(tree);
    const text = document.body.textContent ?? "";
    expect(text).toContain(`${ordered.length - 1} steps run in order`);
    expect(screen.getByTestId("review-skipped").textContent).toMatch(/Could not build/);
  });
});

describe("shared account without a bundleable close (C-08)", () => {
  it("offers no signing request and no close button, only the reason", () => {
    renderPanel(makeTree({ positions: blendPositions() }), {
      shared: {
        gate: { ok: false, reason: "This close includes a step that needs its own transaction." },
        claimRisks: [],
        onCreate: () => {},
        creating: false,
        error: null,
      },
    });
    expect(screen.queryByTestId("review-create-request")).toBeNull();
    expect(screen.queryByTestId("demolish-confirm")).toBeNull();
    expect(screen.getByTestId("review-shared-blocked").textContent).toMatch(/own transaction/);
  });

  it("offers the signing request when the gate passes", () => {
    renderPanel(makeTree(), {
      deterministic: true,
      shared: {
        gate: { ok: true },
        claimRisks: [],
        onCreate: () => {},
        creating: false,
        error: null,
      },
    });
    expect(screen.getByTestId("review-create-request")).toBeTruthy();
  });
});

describe("what keeps the close from starting (H-05)", () => {
  it("lists the blockers and keeps the confirmation off", () => {
    renderPanel(makeTree(), { blockers: ["Blend: positions could not be read."] });
    expect(screen.getByTestId("review-blockers").textContent).toMatch(/could not be read/);
    expect((screen.getByTestId("demolish-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the signing request off while a blocker is open", () => {
    renderPanel(makeTree(), {
      blockers: ["The account can't be merged yet."],
      shared: {
        gate: { ok: true },
        claimRisks: [],
        onCreate: () => {},
        creating: false,
        error: null,
      },
    });
    expect((screen.getByTestId("review-create-request") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the exchange close says what the merge leg delivers (L-06)", () => {
  it("discloses the roughly 1 XLM merge the exchange may not credit", () => {
    const memo: ClassicMemo = { type: "text", value: "abc" };
    const mediator = Keypair.random().publicKey();
    renderPanel(
      makeTree({ opts: { memo, useMediator: true, mediatorPublicKey: mediator, flowToken: "t" } }),
      { memo, useMediator: true },
    );
    expect(screen.getByTestId("review-merge-leg").textContent).toMatch(
      /About 1 XLM .* account merge, which most exchanges do not credit/,
    );
  });

  it("says nothing about a merge leg on a direct close", () => {
    renderPanel(makeTree());
    expect(screen.queryByTestId("review-merge-leg")).toBeNull();
  });
});

describe("a shared close never signs a claim that can't land in the window (L-25)", () => {
  it("offers to leave the claim out and keeps the request off until then", () => {
    let leftOut = 0;
    renderPanel(makeTree(), {
      shared: {
        gate: { ok: true },
        claimRisks: [
          { id: "cb", asset: { kind: "native" }, amount: "5.0000000", reason: "expires" },
        ],
        onLeaveOutRisky: () => {
          leftOut += 1;
        },
        onCreate: () => {},
        creating: false,
        error: null,
      },
    });
    expect((screen.getByTestId("review-create-request") as HTMLButtonElement).disabled).toBe(true);
    screen.getByTestId("review-leave-out-risky").click();
    expect(leftOut).toBe(1);
  });
});

describe("conversions show what they sell and the floor they sign (M-18)", () => {
  it("lists the amount sold, the reviewed quote and the signed minimum", () => {
    const issuer = Keypair.random().publicKey();
    const audit = makeAudit({
      balances: [
        ...makeAudit().balances,
        {
          asset: { kind: "credit", code: "USDC", issuer },
          amount: "10.0000000",
          buyingLiabilities: "0",
          sellingLiabilities: "0",
        },
      ],
    });
    const paths = new Map([
      [
        `USDC:${issuer}`,
        {
          sourceAmount: "10.0000000",
          destinationAmount: "40.0000000",
          path: [],
          reference: { sourceAmount: "0.0100000", destinationAmount: "0.0400000" },
        },
      ],
    ]);
    renderPanel(makeTree({ audit, opts: { paths } }), { audit });
    const text = screen.getByTestId("review-conversions").textContent ?? "";
    expect(text).toMatch(/Sells 10\.0000000 USDC for about 40\.0000000 XLM/);
    expect(text).toMatch(/refuses less than \d+\.\d+ XLM/);
  });
});
