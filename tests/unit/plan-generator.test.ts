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
    backstop: [],
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
        emissionReserveTokenIds: [2, 3],
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

describe("generatePlan, blend backstop (queued 17-day withdrawal)", () => {
  const NOW = 1_700_000_000_000; // fixed so the estimated unlock date is deterministic
  const SEVENTEEN_DAYS_MS = 17 * 24 * 60 * 60 * 1000;

  it("emits a BackstopQueue node carrying the estimated unlock date, gating the merge", () => {
    const positions = emptyPositions({
      backstop: [{ poolId: POOL_ID, shares: 1000n, queuedForWithdrawal: 0n }],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, { now: NOW });
    const nodeId = id("backstop-queue", POOL_ID);
    const node = tree.allNodes.get(nodeId);
    expect(node?.kind).toBe("BackstopQueue");
    if (node?.kind !== "BackstopQueue") throw new Error("expected BackstopQueue node");
    expect(node.metadata.poolId).toBe(POOL_ID);
    expect(node.metadata.shares).toBe(1000n);
    // the shown unlock date is now + 17 days
    expect(node.metadata.queueEndsAt.getTime()).toBe(NOW + SEVENTEEN_DAYS_MS);
    // the merge depends on the queue (it must run before the close attempt)
    expect(dependsOn(tree, "final-classic-tx", nodeId)).toBe(true);
  });

  it("does not emit a BackstopQueue node when there are no active shares to queue", () => {
    // already fully queued: nothing new to submit (but the executor's reprobe
    // still blocks the merge until the Q4W is withdrawn)
    const positions = emptyPositions({
      backstop: [{ poolId: POOL_ID, shares: 0n, queuedForWithdrawal: 500n }],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, { now: NOW });
    expect(tree.allNodes.has(id("backstop-queue", POOL_ID))).toBe(false);
  });
});

describe("generatePlan, blend emissions target the user's real reserve ids", () => {
  it("threads the discovered reserve_token_ids into the claim (not a hardcoded [0])", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST);
    const claim = tree.allNodes.get(id("blend-claim", POOL_ID));
    expect(claim?.kind).toBe("ClaimBlendEmissions");
    if (claim?.kind !== "ClaimBlendEmissions") throw new Error("expected ClaimBlendEmissions");
    expect(claim.metadata.reserveTokenIds).toEqual([2, 3]);
  });

  it("emits NO claim node when the pool has no accrued emissions", () => {
    const positions = emptyPositions({
      blend: [
        {
          poolId: POOL_ID,
          liabilities: new Map([[ASSET_A, 100n]]),
          collateral: new Map(),
          supply: new Map(),
          emissionReserveTokenIds: [],
        },
      ],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST);
    expect(tree.allNodes.has(id("blend-claim", POOL_ID))).toBe(false);
  });
});

describe("generatePlan, held-token disposition (transfer-as-is vs convert-to-XLM)", () => {
  const HELD = "CHELDTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";

  it("transfers held tokens AS-IS by default (preserves illiquid tokens)", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, {
      heldTokens: [{ contractId: HELD, balance: 500n }],
    });
    expect(tree.allNodes.has(id("drain-token", HELD))).toBe(true);
    expect(tree.allNodes.has(id("convert-token", HELD))).toBe(false);
  });

  it("emits a ConvertSorobanToXLM node (gating the merge) when conversion is opted in", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, {
      heldTokens: [{ contractId: HELD, balance: 500n }],
      convertHeldTokensToXLM: true,
    });
    const nodeId = id("convert-token", HELD);
    const node = tree.allNodes.get(nodeId);
    expect(node?.kind).toBe("ConvertSorobanToXLM");
    if (node?.kind !== "ConvertSorobanToXLM") throw new Error("expected ConvertSorobanToXLM");
    expect(node.metadata.amount).toBe(500n);
    expect(node.metadata.asset).toEqual({ kind: "contract", contractId: HELD });
    // runs before the merge; no transfer-as-is node for the same token
    expect(dependsOn(tree, "final-classic-tx", nodeId)).toBe(true);
    expect(tree.allNodes.has(id("drain-token", HELD))).toBe(false);
  });

  it("never converts on a mediator (CEX) close — an exchange can't receive a raw token", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, {
      useMediator: true,
      mediatorPublicKey: MED,
      flowToken: "nonce.exp.mac",
      heldTokens: [{ contractId: HELD, balance: 500n }],
      convertHeldTokensToXLM: true,
    });
    expect(tree.allNodes.has(id("convert-token", HELD))).toBe(false);
    expect(tree.allNodes.has(id("drain-token", HELD))).toBe(false);
  });
});
