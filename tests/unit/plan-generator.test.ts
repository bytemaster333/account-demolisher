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

// lower-cased id parts joined with ":", mirrors generator.ts makeId
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

describe("generatePlan, memo handling (SEC-03: direct-path memo must survive)", () => {
  const MEMO = { type: "id", value: "9876543210" } as const;

  it("carries the memo into FinalClassicTx metadata for a direct (non-mediator) close", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, { memo: MEMO });
    const final = tree.allNodes.get("final-classic-tx");
    expect(final?.kind).toBe("FinalClassicTx");
    // metadata.memo is what execute-time re-batching re-applies; without it the
    // signed direct merge silently drops the deposit memo (the SEC-03 defect)
    expect((final!.metadata as { memo?: unknown }).memo).toEqual(MEMO);
    expect(tree.allNodes.get("mediator-forward")).toBeUndefined();
  });

  it("also routes the memo through the forward hop for a mediator (CEX) close", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, {
      memo: MEMO,
      useMediator: true,
      mediatorPublicKey: MED,
      flowToken: "nonce.exp.mac",
    });
    const forward = tree.allNodes.get("mediator-forward");
    expect(forward?.kind).toBe("MediatorForward");
    expect((forward!.metadata as { memo?: unknown }).memo).toEqual(MEMO);
  });
});

describe("generatePlan, protocol ordering invariants", () => {
  it("wires and orders Blend repay before that pool's withdraw", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST);
    const repayId = id("blend-repay", POOL_ID, ASSET_A);
    const withdrawId = id("blend-withdraw-collateral", POOL_ID, ASSET_A);
    // edge exists (dropping it would let the withdraw run first on-chain)
    expect(dependsOn(tree, withdrawId, repayId)).toBe(true);
    const order = topologicalOrder(tree);
    expect(indexOf(order, repayId)).toBeLessThan(indexOf(order, withdrawId));
  });

  it("emits a single FxDAO pay-debt node and no separate redeem node", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST);
    // pay_debt (full) closes the vault and reclaims collateral in one call
    expect(tree.allNodes.has(id("fxdao-pay-debt", DENOM))).toBe(true);
    // the old RedeemFxDAO node is gone, redeem() acts on the lowest vault, not
    // the caller's, so it was never a correct close-your-vault step
    expect(tree.allNodes.has(id("fxdao-redeem", DENOM))).toBe(false);
    for (const node of tree.allNodes.values()) {
      expect(node.kind).not.toBe("RedeemFxDAO");
    }
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

describe("generatePlan, mediator forward", () => {
  it("wires mediator-forward on the final tx and orders it last", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, {
      useMediator: true,
      mediatorPublicKey: MED,
      flowToken: "nonce.exp.mac",
    });
    expect(dependsOn(tree, "mediator-forward", "final-classic-tx")).toBe(true);
    const order = topologicalOrder(tree);
    const finalIdx = indexOf(order, "final-classic-tx");
    const forwardIdx = indexOf(order, "mediator-forward");
    expect(forwardIdx).toBeGreaterThan(finalIdx);
    expect(forwardIdx).toBe(order.length - 1);
    const fwd = tree.allNodes.get("mediator-forward");
    expect(fwd?.metadata.kind === "MediatorForward" && fwd.metadata.flowToken).toBe(
      "nonce.exp.mac",
    );
  });

  it("carries the FULL deposit memo (incl. numeric 'id') to the forward, not just text", () => {
    // regression: an 'id' (numeric) CEX memo was dropped because only 'text' was
    // propagated, so the forward reached the exchange with no memo (fund loss).
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, {
      useMediator: true,
      mediatorPublicKey: MED,
      flowToken: "nonce.exp.mac",
      memo: { type: "id", value: "1234567890" },
    });
    const fwd = tree.allNodes.get("mediator-forward");
    expect(fwd?.metadata.kind).toBe("MediatorForward");
    if (fwd?.metadata.kind === "MediatorForward") {
      expect(fwd.metadata.memo).toEqual({ type: "id", value: "1234567890" });
    }
  });

  it("throws when useMediator is set without a mediator public key", () => {
    expect(() =>
      generatePlan(makeAudit(), emptyPositions(), [], DEST, { useMediator: true }),
    ).toThrow(/requires opts\.mediatorPublicKey/);
  });

  it("throws when useMediator is set without a flow token", () => {
    expect(() =>
      generatePlan(makeAudit(), emptyPositions(), [], DEST, {
        useMediator: true,
        mediatorPublicKey: MED,
      }),
    ).toThrow(/requires opts\.flowToken/);
  });
});

describe("generatePlan, held SEP-41 token auto-drain (SEP-41 auto-include)", () => {
  const TOKEN_A = "CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
  const TOKEN_B = "CTOKENBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";

  it("emits a TransferAsIs drain per held token, sent to the destination, before the merge", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, {
      heldTokens: [
        { contractId: TOKEN_A, balance: 500n },
        { contractId: TOKEN_B, balance: 1n },
      ],
    });

    const drainA = tree.allNodes.get(id("drain-token", TOKEN_A));
    const drainB = tree.allNodes.get(id("drain-token", TOKEN_B));
    expect(drainA?.kind).toBe("TransferAsIs");
    expect(drainB?.kind).toBe("TransferAsIs");
    if (drainA?.metadata.kind === "TransferAsIs") {
      expect(drainA.metadata.asset).toEqual({ kind: "contract", contractId: TOKEN_A });
      expect(drainA.metadata.amount).toBe(500n);
      expect(drainA.metadata.destination).toBe(DEST);
    }

    // ordering: each drain is a dependency of the merge, so it runs BEFORE it
    expect(dependsOn(tree, "final-classic-tx", id("drain-token", TOKEN_A))).toBe(true);
    expect(dependsOn(tree, "final-classic-tx", id("drain-token", TOKEN_B))).toBe(true);
    const order = topologicalOrder(tree);
    expect(indexOf(order, id("drain-token", TOKEN_A))).toBeLessThan(
      indexOf(order, "final-classic-tx"),
    );
  });

  it("skips a zero-balance held token (nothing to drain)", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, {
      heldTokens: [{ contractId: TOKEN_A, balance: 0n }],
    });
    expect(tree.allNodes.get(id("drain-token", TOKEN_A))).toBeUndefined();
  });

  it("does NOT auto-drain on a mediator/CEX close (an exchange can't receive a raw token)", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, {
      useMediator: true,
      mediatorPublicKey: MED,
      flowToken: "nonce.exp.mac",
      heldTokens: [{ contractId: TOKEN_A, balance: 500n }],
    });
    expect(tree.allNodes.get(id("drain-token", TOKEN_A))).toBeUndefined();
  });
});
