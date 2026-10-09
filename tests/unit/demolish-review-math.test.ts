import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { topologicalOrder, type PlanNode } from "@/lib/plan/tree";
import type { PathResultRef } from "@/lib/types/plan";

import { computeReviewMoney, reserveReleasedStroops } from "@/app/demolish/_lib/review-money";

import { blendPositions, makeAudit, makeTree } from "./demolish-fixtures";

const ISSUER = Keypair.random().publicKey();

function auditWithUsdc() {
  return makeAudit({
    subentryCount: 1,
    balances: [
      {
        asset: { kind: "native" },
        amount: "50.0000000",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
      {
        asset: { kind: "credit", code: "USDC", issuer: ISSUER },
        amount: "10000.0000000",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ],
  });
}

function usdcPath(): ReadonlyMap<string, PathResultRef> {
  return new Map([
    [
      `USDC:${ISSUER}`,
      {
        destinationAmount: "40000.0000000",
        sourceAmount: "10000",
        path: [],
        // the 1/1000 reference trade at the same rate: no price impact
        reference: { sourceAmount: "10.0000000", destinationAmount: "40.0000000" },
      },
    ],
  ]);
}

function simulateSoroban(node: PlanNode, minResourceFee: string, maxFee: string): void {
  node.status = "simulated";
  node.simulated = {
    kind: "soroban",
    retval: null,
    minResourceFee,
    maxFee,
    transactionData: undefined as never,
    latestLedger: 1,
    auth: [],
    restorePreambleRequired: false,
  };
}

describe("computeReviewMoney (M-33)", () => {
  it("adds the signed conversion minimums to the native balance", () => {
    const audit = auditWithUsdc();
    const tree = makeTree({ audit, opts: { paths: usdcPath() } });
    const money = computeReviewMoney({ audit, ordered: topologicalOrder(tree) });
    // the signed floor is the batcher's destMin (the quote less slippage)
    const final = tree.allNodes.get("final-classic-tx")!;
    if (final.kind !== "FinalClassicTx") throw new Error("expected the final node");
    const pp = final.metadata.batches
      .flatMap((b) => b.operations)
      .find((o) => o.kind === "path_payment_strict_send")!;
    const destMin = String(pp.metadata["destMin"]);
    const [w, f = ""] = destMin.split(".");
    expect(money.conversionMinStroops).toBe(BigInt(w!) * 10_000_000n + BigInt(f.padEnd(7, "0")));
    expect(money.conversionMinStroops).toBeGreaterThan(30_000n * 10_000_000n);
    expect(money.nativeBalanceStroops).toBe(500_000_000n);
    // a merge that converts USDC is far above the bare native balance
    expect(money.atLeastStroops).toBeGreaterThan(money.nativeBalanceStroops);
  });

  it("subtracts the worst-case fee the executor may bid, not the 100-stroop preview", () => {
    const audit = auditWithUsdc();
    const tree = makeTree({ audit, opts: { paths: usdcPath() } });
    const money = computeReviewMoney({ audit, ordered: topologicalOrder(tree) });
    const final = tree.allNodes.get("final-classic-tx")!;
    if (final.kind !== "FinalClassicTx") throw new Error("expected the final node");
    const ops = final.metadata.batches.reduce((n, b) => n + b.operations.length, 0);
    // executor surge ceiling is 1,000,000 stroops per operation
    expect(money.maxFeeStroops).toBe(BigInt(ops) * 1_000_000n);
    expect(money.typicalFeeStroops).toBe(BigInt(ops) * 100n);
    expect(money.atLeastStroops).toBe(
      money.nativeBalanceStroops + money.conversionMinStroops - money.maxFeeStroops,
    );
  });

  it("counts each Soroban step at its built fee as usual, and at its class cap as the most", () => {
    const audit = makeAudit();
    const tree = makeTree({ audit, positions: blendPositions() });
    const ordered = topologicalOrder(tree);
    // a measured archived-state exit authorizes millions of stroops, far above a
    // flat inclusion-plus-resource guess
    for (const n of ordered) if (n.kind !== "FinalClassicTx") simulateSoroban(n, "5000", "2524898");
    const sorobanCount = ordered.filter((n) => n.kind !== "FinalClassicTx").length;
    expect(sorobanCount).toBe(2);
    const money = computeReviewMoney({ audit, ordered });
    const final = tree.allNodes.get("final-classic-tx")!;
    if (final.kind !== "FinalClassicTx") throw new Error("expected the final node");
    const ops = final.metadata.batches.reduce((n, b) => n + b.operations.length, 0);
    expect(money.typicalFeeStroops).toBe(BigInt(sorobanCount) * 2_524_898n + BigInt(ops) * 100n);
    // each step is re-simulated before signing, so the preview's fee is not its
    // most: a blend step is never signed above 0.01 XLM inclusion + 3.3 XLM
    expect(money.maxFeeStroops).toBe(BigInt(sorobanCount) * 33_100_000n + BigInt(ops) * 1_000_000n);
    expect(money.unbuiltFeeSteps).toBe(0);
  });

  it("counts a step built only at execute time at its cap, and says it is unpriced", () => {
    const audit = makeAudit();
    const tree = makeTree({ audit, positions: blendPositions() });
    const ordered = topologicalOrder(tree);
    const repay = ordered.find((n) => n.kind === "RepayBlend")!;
    const withdraw = ordered.find((n) => n.kind === "WithdrawBlend")!;
    simulateSoroban(repay, "5000", "2524898");
    withdraw.status = "pending";
    withdraw.deferred = { after: [repay.id], reason: "the collateral is known after the repay" };
    const money = computeReviewMoney({ audit, ordered });
    const final = tree.allNodes.get("final-classic-tx")!;
    if (final.kind !== "FinalClassicTx") throw new Error("expected the final node");
    const ops = final.metadata.batches.reduce((n, b) => n + b.operations.length, 0);
    expect(money.unbuiltFeeSteps).toBe(1);
    expect(money.typicalFeeStroops).toBe(2_524_898n + BigInt(ops) * 100n);
    expect(money.maxFeeStroops).toBe(2n * 33_100_000n + BigInt(ops) * 1_000_000n);
  });

  it("flags DeFi steps it cannot express in XLM instead of folding them in", () => {
    const audit = makeAudit();
    const tree = makeTree({ audit, positions: blendPositions() });
    const money = computeReviewMoney({ audit, ordered: topologicalOrder(tree) });
    // a repay spends from the balance, so the floor is only valid before it
    expect(money.spendsBalance).toBe(true);
    expect(money.notCounted.length).toBeGreaterThan(0);
  });
});

describe("reserveReleasedStroops (M-33)", () => {
  it("uses the live base reserve and the account's sponsorship counts", () => {
    const audit = makeAudit({
      subentryCount: 3,
      sponsorship: { numSponsoring: 2, numSponsored: 1, coverable: 2 },
    });
    // (2 + 3 + 2 - 1) * 5,000,000
    expect(reserveReleasedStroops(audit, 5_000_000)).toBe(30_000_000n);
  });

  it("returns null when the base reserve is unknown rather than guessing", () => {
    expect(reserveReleasedStroops(makeAudit(), null)).toBeNull();
  });
});
