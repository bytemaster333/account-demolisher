import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { generatePlan } from "@/lib/plan/generator";
import { topologicalOrder, type PlanTree } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";

const ACC = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const MED = Keypair.random().publicKey();

// deterministic node ids: generatePlan's makeId lowercases each part and joins with ":"
const POOL_ID = "pool0000000000000000000000000000000000000000000000000000000000aa";
const ASSET_A = "casset0000000000000000000000000000000000000000000000000000000001";
const ASSET_B = "casset0000000000000000000000000000000000000000000000000000000002";
const DENOM = "USDC";

function makeAudit(over: Partial<AccountAudit> = {}): AccountAudit {
  return {
    accountId: ACC,
    sequence: "1",
    subentryCount: 0,
    thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
    flags: {
      authImmutable: false,
      authRequired: false,
      authRevocable: false,
      authClawbackEnabled: false,
    },
    balances: [],
    signers: [],
    offers: [],
    data: [],
    claimableBalances: [],
    poolShares: [],
    sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
    requiresMultisig: false,
    mergeability: { mergeable: true },
    ...over,
  };
}

function emptyPositions(over: Partial<ProtocolPositions> = {}): ProtocolPositions {
  return {
    blend: [],
    aquarius: [],
    soroswap: [],
    fxdao: [],
    errors: [],
    ...over,
  };
}

// one blend pool with both a liability and a collateral entry, and one fxdao
// vault carrying both debt and collateral, so every ordering edge is exercised.
function richPositions(): ProtocolPositions {
  return emptyPositions({
    blend: [
      {
        poolId: POOL_ID,
        liabilities: new Map([[ASSET_A, 100n]]),
        collateral: new Map([[ASSET_A, 200n]]),
        supply: new Map(),
      },
    ],
    fxdao: [{ denomination: DENOM, debt: 50n, collateral: 300n }],
  });
}

// lower-cased id parts joined with ":" — mirrors generator.ts makeId
function id(...parts: string[]): string {
  return parts.map((p) => p.toLowerCase()).join(":");
}

// direct dependency edge assertion: robustly catches a dropped/rewired edge,
// independent of any coincidental topological insertion order.
function dependsOn(tree: PlanTree, nodeId: string, depId: string): boolean {
  const node = tree.allNodes.get(nodeId);
  expect(node, `expected node "${nodeId}" to exist`).toBeDefined();
  return node!.dependencies.includes(depId);
}

function indexOf(order: readonly { id: string }[], nodeId: string): number {
  const i = order.findIndex((n) => n.id === nodeId);
  expect(i, `expected node "${nodeId}" in topological order`).toBeGreaterThanOrEqual(0);
  return i;
}

describe("generatePlan — protocol ordering invariants", () => {
  it("wires and orders Blend repay before that pool's withdraw", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST);
    const repayId = id("blend-repay", POOL_ID, ASSET_A);
    const withdrawId = id("blend-withdraw-collateral", POOL_ID, ASSET_A);
    // edge exists (dropping it would let the withdraw run first on-chain)
    expect(dependsOn(tree, withdrawId, repayId)).toBe(true);
    const order = topologicalOrder(tree);
    expect(indexOf(order, repayId)).toBeLessThan(indexOf(order, withdrawId));
  });

  it("wires and orders FxDAO pay-debt before redeem for the same denomination", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST);
    const payDebtId = id("fxdao-pay-debt", DENOM);
    const redeemId = id("fxdao-redeem", DENOM);
    expect(dependsOn(tree, redeemId, payDebtId)).toBe(true);
    const order = topologicalOrder(tree);
    expect(indexOf(order, payDebtId)).toBeLessThan(indexOf(order, redeemId));
  });

  it("wires and orders Blend emissions claim after its withdraws and before the merge", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST);
    const withdrawId = id("blend-withdraw-collateral", POOL_ID, ASSET_A);
    const claimId = id("blend-claim", POOL_ID);
    expect(dependsOn(tree, claimId, withdrawId)).toBe(true);
    const order = topologicalOrder(tree);
    expect(indexOf(order, withdrawId)).toBeLessThan(indexOf(order, claimId));
    expect(indexOf(order, claimId)).toBeLessThan(indexOf(order, "final-classic-tx"));
  });

  it("wires and orders every soroban node before the final classic merge", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST);
    const order = topologicalOrder(tree);
    const finalIdx = indexOf(order, "final-classic-tx");
    for (const node of tree.allNodes.values()) {
      if (node.kind === "FinalClassicTx" || node.kind === "MediatorForward") continue;
      // FinalClassicTx depends on every non-final/non-mediator node
      expect(dependsOn(tree, "final-classic-tx", node.id)).toBe(true);
      expect(indexOf(order, node.id)).toBeLessThan(finalIdx);
    }
  });

  it("leaves ASSET_B (no supply/collateral entry) out of the plan", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST);
    expect(tree.allNodes.has(id("blend-withdraw-supply", POOL_ID, ASSET_B))).toBe(false);
  });
});

describe("generatePlan — mediator forward", () => {
  it("wires mediator-forward on the final tx and orders it last", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, {
      useMediator: true,
      mediatorPublicKey: MED,
    });
    expect(dependsOn(tree, "mediator-forward", "final-classic-tx")).toBe(true);
    const order = topologicalOrder(tree);
    const finalIdx = indexOf(order, "final-classic-tx");
    const forwardIdx = indexOf(order, "mediator-forward");
    expect(forwardIdx).toBeGreaterThan(finalIdx);
    expect(forwardIdx).toBe(order.length - 1);
  });

  it("throws when useMediator is set without a mediator public key", () => {
    expect(() =>
      generatePlan(makeAudit(), emptyPositions(), [], DEST, { useMediator: true }),
    ).toThrow(/requires opts\.mediatorPublicKey/);
  });
});
