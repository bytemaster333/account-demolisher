import { describe, it, expect } from "vitest";
import { Asset, Keypair, StrKey } from "@stellar/stellar-sdk";
import { TESTNET } from "@/lib/config/networks";
import {
  assertExchangeCloseCanRun,
  finalBatchOptions,
  generatePlan,
  preparePlanFor,
} from "@/lib/plan/generator";
import {
  planExitPayoutTokens,
  preparedUnlocksAt,
  topologicalOrder,
  type PlanTree,
} from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";

const ACC = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const MED = Keypair.random().publicKey();

// deterministic node ids: generatePlan's makeId lowercases each part and joins with ":"
const POOL_ID = "pool0000000000000000000000000000000000000000000000000000000000aa";
const ASSET_A = "casset0000000000000000000000000000000000000000000000000000000001";
const ASSET_B = "casset0000000000000000000000000000000000000000000000000000000002";

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
    aquariusConcentrated: [],
    soroswap: [],
    backstopUnclaimedEmissions: [],
    errors: [],
    ...over,
  };
}

// one blend pool with both a liability and a collateral entry, so every ordering
// edge is exercised.
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
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, { network: TESTNET });
    const repayId = id("blend-repay", POOL_ID, ASSET_A);
    const withdrawId = id("blend-withdraw-collateral", POOL_ID, ASSET_A);
    // edge exists (dropping it would let the withdraw run first on-chain)
    expect(dependsOn(tree, withdrawId, repayId)).toBe(true);
    const order = topologicalOrder(tree);
    expect(indexOf(order, repayId)).toBeLessThan(indexOf(order, withdrawId));
  });

  it("wires and orders Blend emissions claim after its withdraws and before the merge", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, { network: TESTNET });
    const withdrawId = id("blend-withdraw-collateral", POOL_ID, ASSET_A);
    const claimId = id("blend-claim", POOL_ID);
    expect(dependsOn(tree, claimId, withdrawId)).toBe(true);
    const order = topologicalOrder(tree);
    expect(indexOf(order, withdrawId)).toBeLessThan(indexOf(order, claimId));
    expect(indexOf(order, claimId)).toBeLessThan(indexOf(order, "final-classic-tx"));
  });

  it("wires and orders every soroban node before the final classic merge", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, { network: TESTNET });
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
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, { network: TESTNET });
    expect(tree.allNodes.has(id("blend-withdraw-supply", POOL_ID, ASSET_B))).toBe(false);
  });
});

describe("generatePlan, mediator forward", () => {
  // an exchange close can only take exits that pay out classic balances
  const xlm = Asset.native().contractId(TESTNET.passphrase);
  const xlmPositions = (): ProtocolPositions =>
    emptyPositions({
      blend: [
        {
          poolId: POOL_ID,
          liabilities: new Map([[xlm, 100n]]),
          collateral: new Map([[xlm, 200n]]),
          supply: new Map(),
          emissionReserveTokenIds: [2, 3],
        },
      ],
    });

  it("wires mediator-forward on the final tx and orders it last", () => {
    const tree = generatePlan(makeAudit(), xlmPositions(), [], DEST, {
      network: TESTNET,
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
    const tree = generatePlan(makeAudit(), xlmPositions(), [], DEST, {
      network: TESTNET,
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

describe("generatePlan, blend backstop (queued withdrawal, prepare-only plan)", () => {
  const NOW = 1_700_000_000_000; // fixed so the estimated unlock date is deterministic
  const SEVENTEEN_DAYS_MS = 17 * 24 * 60 * 60 * 1000;
  const TWENTY_ONE_DAYS_MS = 21 * 24 * 60 * 60 * 1000;

  it("queues the shares and only prepares the close while the queue is locked (PLCL-30)", () => {
    const positions = emptyPositions({
      backstop: [{ poolId: POOL_ID, shares: 1000n, queuedForWithdrawal: 0n }],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, { now: NOW });
    const nodeId = id("backstop-queue", POOL_ID);
    const node = tree.allNodes.get(nodeId);
    if (node?.kind !== "BackstopQueue") throw new Error("expected BackstopQueue node");
    expect(node.metadata.poolId).toBe(POOL_ID);
    expect(node.metadata.shares).toBe(1000n);
    // the shown unlock date is now + 17 days on the v2 backstop
    expect(node.metadata.queueEndsAt.getTime()).toBe(NOW + SEVENTEEN_DAYS_MS);
    // no merge and no forward: the account has to exist to receive the withdrawal
    expect(tree.allNodes.has("final-classic-tx")).toBe(false);
    expect(tree.allNodes.has("mediator-forward")).toBe(false);
    expect(tree.prepareOnly?.unlocksAt.getTime()).toBe(NOW + SEVENTEEN_DAYS_MS);
  });

  it("dates a v1 backstop queue 21 days out (C-07)", () => {
    const positions = emptyPositions({
      backstop: [
        {
          poolId: POOL_ID,
          shares: 10n,
          queuedForWithdrawal: 0n,
          queueDurationSeconds: 21 * 24 * 60 * 60,
        },
      ],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, { now: NOW });
    const node = tree.allNodes.get(id("backstop-queue", POOL_ID));
    if (node?.kind !== "BackstopQueue") throw new Error("expected BackstopQueue node");
    expect(node.metadata.queueEndsAt.getTime()).toBe(NOW + TWENTY_ONE_DAYS_MS);
    expect(node.description).toContain(
      new Date(NOW + TWENTY_ONE_DAYS_MS).toISOString().slice(0, 10),
    );
    expect(tree.prepareOnly?.unlocksAt.getTime()).toBe(NOW + TWENTY_ONE_DAYS_MS);
  });

  it("withdraws an unlocked queue and then closes the account (M-25)", () => {
    const positions = emptyPositions({
      backstop: [
        {
          poolId: POOL_ID,
          shares: 0n,
          queuedForWithdrawal: 500n,
          unlockedQueuedForWithdrawal: 500n,
        },
      ],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, { now: NOW, network: TESTNET });
    const withdrawId = id("backstop-withdraw", POOL_ID);
    const node = tree.allNodes.get(withdrawId);
    if (node?.kind !== "BackstopWithdraw") throw new Error("expected BackstopWithdraw node");
    expect(node.metadata.amount).toBe(500n);
    // the testnet backstop pays out the BLND-USDC comet LP token
    expect(node.metadata.lpToken).toBe("CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM");
    expect(tree.allNodes.has(id("backstop-queue", POOL_ID))).toBe(false);
    expect(tree.prepareOnly).toBeUndefined();
    expect(dependsOn(tree, "final-classic-tx", withdrawId)).toBe(true);
    // the LP tokens it pays out are swept to the destination after it, and the
    // merge guard knows to look for them
    const sweepId = id("drain-token", node.metadata.lpToken);
    expect(dependsOn(tree, sweepId, withdrawId)).toBe(true);
    expect(planExitPayoutTokens(tree)).toContain(node.metadata.lpToken);
  });

  it("stays prepare-only while part of the queue is still locked", () => {
    const positions = emptyPositions({
      backstop: [
        {
          poolId: POOL_ID,
          shares: 0n,
          queuedForWithdrawal: 800n,
          unlockedQueuedForWithdrawal: 300n,
        },
      ],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, { now: NOW, network: TESTNET });
    expect(tree.allNodes.has(id("backstop-withdraw", POOL_ID))).toBe(true);
    expect(tree.allNodes.has("final-classic-tx")).toBe(false);
    expect(tree.prepareOnly).toBeDefined();
  });

  it("refuses to plan a backstop withdraw without the network", () => {
    const positions = emptyPositions({
      backstop: [
        {
          poolId: POOL_ID,
          shares: 0n,
          queuedForWithdrawal: 5n,
          unlockedQueuedForWithdrawal: 5n,
        },
      ],
    });
    expect(() => generatePlan(makeAudit(), positions, [], DEST, { now: NOW })).toThrow(
      /opts\.network is required/,
    );
  });

  it("names the backstop discovery found on every backstop step", () => {
    const positions = emptyPositions({
      backstop: [
        {
          poolId: POOL_ID,
          backstopId: "CBACKSTOP",
          shares: 1000n,
          queuedForWithdrawal: 500n,
          unlockedQueuedForWithdrawal: 500n,
          accruedEmissions: 1n,
        },
      ],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, { now: NOW, network: TESTNET });
    for (const prefix of ["backstop-claim", "backstop-queue", "backstop-withdraw"]) {
      expect(tree.allNodes.get(id(prefix, POOL_ID))?.metadata).toMatchObject({
        backstopId: "CBACKSTOP",
      });
    }
  });

  it("claims accrued backstop emissions before the queue (L-49)", () => {
    const positions = emptyPositions({
      backstop: [
        { poolId: POOL_ID, shares: 1000n, queuedForWithdrawal: 0n, accruedEmissions: 25_000_000n },
      ],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, { now: NOW });
    const claimId = id("backstop-claim", POOL_ID);
    const claim = tree.allNodes.get(claimId);
    if (claim?.kind !== "ClaimBackstopEmissions") throw new Error("expected the claim node");
    expect(claim.metadata.accruedEmissions).toBe(25_000_000n);
    expect(claim.description).toContain("2.5 BLND");
    expect(dependsOn(tree, id("backstop-queue", POOL_ID), claimId)).toBe(true);
    expect(tree.forfeitedBackstopEmissions).toBeUndefined();
  });

  it("queues without the claim once the user forfeits emissions the claim can't collect", () => {
    const positions = emptyPositions({
      backstop: [
        { poolId: POOL_ID, shares: 1000n, queuedForWithdrawal: 0n, accruedEmissions: 25_000_000n },
      ],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, {
      now: NOW,
      forfeitBackstopEmissionsPoolIds: [POOL_ID],
    });
    expect(tree.allNodes.has(id("backstop-claim", POOL_ID))).toBe(false);
    expect(tree.allNodes.get(id("backstop-queue", POOL_ID))?.dependencies).toEqual([]);
    expect(tree.forfeitedBackstopEmissions).toEqual([
      { poolId: POOL_ID, accruedEmissions: 25_000_000n },
    ]);
  });

  it("never claims emissions accrued to a depositor with no shares", () => {
    const positions = emptyPositions({
      backstop: [],
      backstopUnclaimedEmissions: [
        { poolId: POOL_ID, backstopId: "CBACKSTOP", accruedEmissions: 9n },
      ],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST, { now: NOW });
    expect([...tree.allNodes.values()].some((n) => n.kind === "ClaimBackstopEmissions")).toBe(
      false,
    );
    expect(tree.allNodes.has("final-classic-tx")).toBe(true);
  });
});

describe("generatePlan, blend emissions target the user's real reserve ids", () => {
  it("threads the discovered reserve_token_ids into the claim (not a hardcoded [0])", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, { network: TESTNET });
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

  it("marks a held-token conversion the user confirmed past the price-impact cap", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, {
      heldTokens: [{ contractId: HELD, balance: 500n }],
      convertHeldTokensToXLM: true,
      acceptedPriceImpactAssetKeys: [`contract:${HELD}`],
    });
    const node = tree.allNodes.get(id("convert-token", HELD));
    if (node?.kind !== "ConvertSorobanToXLM") throw new Error("expected ConvertSorobanToXLM");
    expect(node.metadata.priceImpactAccepted).toBe(true);
  });

  it("plans no held-token sweep of either kind on a mediator (CEX) close; the preview asks to move them first", () => {
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

const TOKEN_X = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN_Y = StrKey.encodeContract(Buffer.alloc(32, 2));
const TOKEN_Z = StrKey.encodeContract(Buffer.alloc(32, 3));
const SHARED_INDEX = "ab".repeat(32);

describe("H-17: Aquarius pools are keyed by tokens and index", () => {
  it("plans both pools when two positions share a pool_index", () => {
    const positions = emptyPositions({
      aquarius: [
        { poolIndex: SHARED_INDEX, shareBalance: 10n, tokens: [TOKEN_X, TOKEN_Y] },
        { poolIndex: SHARED_INDEX, shareBalance: 20n, tokens: [TOKEN_X, TOKEN_Z] },
      ],
    });
    const tree = generatePlan(makeAudit(), positions, [], DEST);
    const withdraws = [...tree.allNodes.values()].filter((n) => n.kind === "WithdrawAquarius");
    const claims = [...tree.allNodes.values()].filter((n) => n.kind === "ClaimAquariusRewards");
    expect(withdraws).toHaveLength(2);
    expect(claims).toHaveLength(2);
    const claimTokens = claims.map((c) =>
      c.metadata.kind === "ClaimAquariusRewards" ? c.metadata.tokens : [],
    );
    expect(claimTokens).toEqual([
      [TOKEN_X, TOKEN_Y],
      [TOKEN_X, TOKEN_Z],
    ]);
    const withdrawIdOfZ = id("aquarius-withdraw", TOKEN_X, TOKEN_Z, SHARED_INDEX);
    expect(
      dependsOn(tree, id("aquarius-claim", TOKEN_X, TOKEN_Z, SHARED_INDEX), withdrawIdOfZ),
    ).toBe(true);
  });
});

describe("M-23: repays run after the exits that can fund them", () => {
  const OTHER_POOL = "CPOOLB" + "B".repeat(50);
  const positions = emptyPositions({
    blend: [
      {
        poolId: POOL_ID,
        liabilities: new Map([[ASSET_A, 100n]]),
        collateral: new Map([[ASSET_A, 200n]]),
        supply: new Map(),
        emissionReserveTokenIds: [],
      },
      {
        poolId: OTHER_POOL,
        liabilities: new Map(),
        collateral: new Map(),
        supply: new Map([[ASSET_B, 50n]]),
        emissionReserveTokenIds: [],
      },
    ],
    aquarius: [{ poolIndex: SHARED_INDEX, shareBalance: 10n, tokens: [TOKEN_X, TOKEN_Y] }],
    soroswap: [{ pair: { tokenA: TOKEN_X, tokenB: TOKEN_Z }, shareBalance: 5n }],
  });
  const tree = generatePlan(makeAudit(), positions, [], DEST);
  const funding = [
    id("aquarius-withdraw", TOKEN_X, TOKEN_Y, SHARED_INDEX),
    id("soroswap-withdraw", TOKEN_X, TOKEN_Z),
    id("blend-withdraw-supply", OTHER_POOL, ASSET_B),
  ];

  it("makes Blend repays depend on LP and debt-free Blend exits", () => {
    const repay = id("blend-repay", POOL_ID, ASSET_A);
    for (const exit of funding) expect(dependsOn(tree, repay, exit)).toBe(true);
    const order = topologicalOrder(tree);
    for (const exit of funding) {
      expect(indexOf(order, exit)).toBeLessThan(
        indexOf(order, id("blend-repay", POOL_ID, ASSET_A)),
      );
    }
  });

  it("keeps a debt pool's own withdraw behind its repay, with no cycle", () => {
    const withdrawId = id("blend-withdraw-collateral", POOL_ID, ASSET_A);
    expect(dependsOn(tree, withdrawId, id("blend-repay", POOL_ID, ASSET_A))).toBe(true);
    expect(dependsOn(tree, id("blend-repay", POOL_ID, ASSET_A), withdrawId)).toBe(false);
  });
});

describe("M-24: held-token sweeps follow the exits and cover contract-token payouts", () => {
  const positions = emptyPositions({
    soroswap: [
      {
        pair: { tokenA: TOKEN_X, tokenB: Asset.native().contractId(TESTNET.passphrase) },
        shareBalance: 5n,
      },
    ],
  });

  it("orders a held-token sweep after every exit", () => {
    const tree = generatePlan(makeAudit(), positions, [], DEST, {
      heldTokens: [{ contractId: TOKEN_Z, balance: 7n }],
    });
    expect(
      dependsOn(
        tree,
        id("drain-token", TOKEN_Z),
        id("soroswap-withdraw", TOKEN_X, positions.soroswap[0]!.pair.tokenB),
      ),
    ).toBe(true);
  });

  it("sweeps a contract token an exit pays out, but not a classic asset's SAC", () => {
    const usdc = { kind: "credit" as const, code: "USDC", issuer: Keypair.random().publicKey() };
    const usdcSac = new Asset(usdc.code, usdc.issuer).contractId(TESTNET.passphrase);
    const withClassic = emptyPositions({
      soroswap: [{ pair: { tokenA: TOKEN_X, tokenB: usdcSac }, shareBalance: 5n }],
    });
    const audit = makeAudit({
      balances: [{ asset: usdc, amount: "0", buyingLiabilities: "0", sellingLiabilities: "0" }],
    });
    const tree = generatePlan(audit, withClassic, [], DEST, {
      networkPassphrase: TESTNET.passphrase,
    });
    const sweep = tree.allNodes.get(id("drain-token", TOKEN_X));
    if (sweep?.kind !== "TransferAsIs") throw new Error("expected a sweep of the payout token");
    expect(sweep.metadata.amount).toBe(0n);
    expect(sweep.dependencies).toContain(id("soroswap-withdraw", TOKEN_X, usdcSac));
    expect(tree.allNodes.has(id("drain-token", usdcSac))).toBe(false);
  });

  it("plans no payout sweep on an exchange close whose exits pay out classic balances", () => {
    const usdc = { kind: "credit" as const, code: "USDC", issuer: Keypair.random().publicKey() };
    const usdcSac = new Asset(usdc.code, usdc.issuer).contractId(TESTNET.passphrase);
    const nativeSac = Asset.native().contractId(TESTNET.passphrase);
    const classicOnly = emptyPositions({
      soroswap: [{ pair: { tokenA: usdcSac, tokenB: nativeSac }, shareBalance: 5n }],
    });
    const audit = makeAudit({
      balances: [{ asset: usdc, amount: "0", buyingLiabilities: "0", sellingLiabilities: "0" }],
    });
    const tree = generatePlan(audit, classicOnly, [], DEST, {
      networkPassphrase: TESTNET.passphrase,
      useMediator: true,
      mediatorPublicKey: MED,
      flowToken: "nonce.exp.mac",
    });
    expect([...tree.allNodes.values()].some((n) => n.kind === "TransferAsIs")).toBe(false);
    expect(tree.allNodes.has("mediator-forward")).toBe(true);
  });
});

describe("H-11: the plan records the reviewed claimable balances", () => {
  const issuer = Keypair.random().publicKey();
  const audit = makeAudit({
    claimableBalances: [
      {
        id: "cbNative",
        asset: { kind: "native" },
        amount: "1",
        sponsor: issuer,
        predicate: {},
        claimants: [ACC],
        claimableNow: true,
      },
      {
        id: "cbUntrusted",
        asset: { kind: "credit", code: "SPAM", issuer },
        amount: "1",
        sponsor: issuer,
        predicate: {},
        claimants: [ACC],
        claimableNow: true,
      },
      {
        id: "cbLater",
        asset: { kind: "native" },
        amount: "1",
        sponsor: issuer,
        predicate: {},
        claimants: [ACC],
        claimableNow: false,
      },
    ],
  });

  function finalMetadata(tree: PlanTree) {
    const node = tree.allNodes.get("final-classic-tx");
    if (node?.kind !== "FinalClassicTx") throw new Error("expected FinalClassicTx");
    return node.metadata;
  }

  it("freezes the balances it planned to claim when no selection was given", () => {
    const tree = generatePlan(audit, emptyPositions(), [], DEST);
    expect(finalMetadata(tree).claimableBalanceIds).toEqual(["cbNative"]);
  });

  it("keeps an explicit empty selection as claim-none", () => {
    const tree = generatePlan(audit, emptyPositions(), [], DEST, {
      selectedClaimableBalanceIds: [],
    });
    expect(finalMetadata(tree).claimableBalanceIds).toEqual([]);
  });

  it("records the reviewed reference quotes and price-impact confirmations", () => {
    const key = `USDC:${issuer}`;
    const reference = { sourceAmount: "0.1", destinationAmount: "0.4" };
    const tree = generatePlan(audit, emptyPositions(), [], DEST, {
      paths: new Map([
        [key, { sourceAmount: "100", destinationAmount: "400", path: [], reference }],
      ]),
      acceptedPriceImpactAssetKeys: [key],
    });
    const md = finalMetadata(tree);
    expect(md.reviewedReferenceQuotes).toEqual({ [key]: reference });
    expect(md.acceptedPriceImpactAssetKeys).toEqual([key]);
  });
});

describe("H-26: Aquarius concentrated positions get exit steps", () => {
  const POOL = StrKey.encodeContract(Buffer.alloc(32, 9));
  const concentrated = {
    poolAddress: POOL,
    poolIndex: SHARED_INDEX,
    tokens: [TOKEN_X, TOKEN_Y],
    ranges: [
      { tickLower: -15620, tickUpper: -15260, liquidity: 7_509_933_979_669n },
      { tickLower: -100, tickUpper: 100, liquidity: 5n },
    ],
    pendingFees: [11_409_704n, 3_325_632n],
    pendingReward: 2_704_551_200n,
  };

  it("claims the reward and the fees, then withdraws each range, all before the merge", () => {
    const tree = generatePlan(
      makeAudit(),
      emptyPositions({ aquariusConcentrated: [concentrated] }),
      [],
      DEST,
    );
    const claimId = id("aquarius-cl-claim", POOL);
    const feesId = id("aquarius-cl-fees", POOL);
    const rangeA = id("aquarius-cl-withdraw", POOL, "-15620", "-15260");
    const rangeB = id("aquarius-cl-withdraw", POOL, "-100", "100");
    const claim = tree.allNodes.get(claimId);
    if (claim?.kind !== "ClaimAquariusRewards") throw new Error("expected the reward claim");
    expect(claim.metadata).toMatchObject({
      poolIndex: SHARED_INDEX,
      tokens: [TOKEN_X, TOKEN_Y],
      poolAddress: POOL,
    });
    expect(tree.allNodes.get(feesId)?.kind).toBe("ClaimAquariusConcentratedFees");
    const withdraw = tree.allNodes.get(rangeA);
    if (withdraw?.kind !== "WithdrawAquariusConcentrated") throw new Error("expected a range");
    expect(withdraw.metadata).toMatchObject({
      poolAddress: POOL,
      tickLower: -15620,
      tickUpper: -15260,
      liquidity: 7_509_933_979_669n,
    });
    for (const range of [rangeA, rangeB]) {
      expect(dependsOn(tree, range, claimId)).toBe(true);
      expect(dependsOn(tree, range, feesId)).toBe(true);
      expect(dependsOn(tree, "final-classic-tx", range)).toBe(true);
    }
    expect(planExitPayoutTokens(tree)).toEqual(expect.arrayContaining([TOKEN_X, TOKEN_Y]));
  });

  it("plans only the claims for a pool with no live range", () => {
    const tree = generatePlan(
      makeAudit(),
      emptyPositions({
        aquariusConcentrated: [{ ...concentrated, ranges: [], pendingFees: [0n, 0n] }],
      }),
      [],
      DEST,
    );
    const kinds = [...tree.allNodes.values()].map((n) => n.kind);
    expect(kinds).toContain("ClaimAquariusRewards");
    expect(kinds).not.toContain("ClaimAquariusConcentratedFees");
    expect(kinds).not.toContain("WithdrawAquariusConcentrated");
  });
});

describe("M-26: Blend emissions claims open the BLND trustline first", () => {
  it("adds the trustline ahead of every claim when the account has none", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, { network: TESTNET });
    const line = tree.allNodes.get("blnd-trustline");
    if (line?.kind !== "AddBlndTrustline") throw new Error("expected AddBlndTrustline");
    expect(line.metadata.issuer).toBe("GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56");
    expect(line.dependencies).toEqual([]);
    expect(dependsOn(tree, id("blend-claim", POOL_ID), "blnd-trustline")).toBe(true);
  });

  it("opens the trustline before any other step runs", () => {
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST, { network: TESTNET });
    expect(topologicalOrder(tree)[0]?.id).toBe("blnd-trustline");
  });

  it("adds no trustline when the account already holds an authorized one", () => {
    const audit = makeAudit({
      balances: [
        {
          asset: {
            kind: "credit",
            code: "BLND",
            issuer: "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56",
          },
          amount: "0.0000000",
          buyingLiabilities: "0",
          sellingLiabilities: "0",
          isAuthorized: true,
        },
      ],
    });
    const tree = generatePlan(audit, richPositions(), [], DEST, { network: TESTNET });
    expect(tree.allNodes.has("blnd-trustline")).toBe(false);
    expect(tree.allNodes.get(id("blend-claim", POOL_ID))?.dependencies).not.toContain(
      "blnd-trustline",
    );
  });

  it("refuses to plan emissions claims without the network", () => {
    expect(() => generatePlan(makeAudit(), richPositions(), [], DEST)).toThrow(
      /opts\.network is required/,
    );
  });
});

describe("M-23: a repay asset locked in classic offers or pools is unwound first", () => {
  const ISSUER = Keypair.random().publicKey();
  const usdc = new Asset("USDC", ISSUER);
  const usdcSac = usdc.contractId(TESTNET.passphrase);
  const positions = emptyPositions({
    blend: [
      {
        poolId: POOL_ID,
        liabilities: new Map([[usdcSac, 100n]]),
        collateral: new Map(),
        supply: new Map(),
        emissionReserveTokenIds: [],
      },
    ],
  });
  const usdcId = { kind: "credit", code: "USDC", issuer: ISSUER } as const;
  const audit = makeAudit({
    offers: [
      {
        id: "11",
        selling: usdcId,
        buying: { kind: "native" },
        amount: "5",
        priceR: { n: 1, d: 1 },
      },
      {
        id: "12",
        selling: { kind: "native" },
        buying: usdcId,
        amount: "5",
        priceR: { n: 1, d: 1 },
      },
    ],
    poolShares: [
      {
        poolId: "b".repeat(64),
        poolType: "constant_product",
        shareBalance: "10.0000000",
        totalShares: "100.0000000",
        shareLimit: "100.0000000",
        fee: 30,
        reserves: [
          { asset: { kind: "native" }, amount: "50.0000000" },
          { asset: usdcId, amount: "50.0000000" },
        ],
      },
    ],
  });

  it("cancels the offer selling it and withdraws the pool holding it before the repay", () => {
    const tree = generatePlan(audit, positions, [], DEST, { network: TESTNET });
    const unwind = tree.allNodes.get("classic-unwind");
    if (unwind?.kind !== "ClassicUnwind") throw new Error("expected ClassicUnwind");
    expect(unwind.metadata.offerIds).toEqual(["11"]);
    expect(unwind.metadata.poolIds).toEqual(["b".repeat(64)]);
    expect(unwind.metadata.repayAssets).toEqual([usdcSac]);
    expect(unwind.metadata.batches.flatMap((b) => b.operations.map((o) => o.kind))).toEqual([
      "liquidity_pool_withdraw",
      "manage_sell_offer_cancel",
    ]);
    expect(dependsOn(tree, id("blend-repay", POOL_ID, usdcSac), "classic-unwind")).toBe(true);
    expect(dependsOn(tree, "final-classic-tx", "classic-unwind")).toBe(true);
  });

  it("previews the final batches as they look after the unwind", () => {
    const funded = makeAudit({
      ...audit,
      subentryCount: 4,
      balances: [
        {
          asset: { kind: "native" },
          amount: "100",
          buyingLiabilities: "0",
          sellingLiabilities: "5",
        },
        { asset: usdcId, amount: "20", buyingLiabilities: "5", sellingLiabilities: "5" },
      ],
    });
    const tree = generatePlan(funded, positions, [], DEST, {
      network: TESTNET,
      classicFeePerOp: 100,
    });
    const unwind = tree.allNodes.get("classic-unwind");
    if (unwind?.kind !== "ClassicUnwind") throw new Error("expected ClassicUnwind");
    expect(unwind.metadata.destination).toBe(DEST);
    const final = tree.allNodes.get("final-classic-tx");
    if (final?.kind !== "FinalClassicTx") throw new Error("expected FinalClassicTx");
    const ops = final.metadata.batches.flatMap((b) => b.operations);
    // the unwind already cancelled offer 11 and withdrew the pool; only offer 12
    // is left for the final batches
    expect(
      ops.filter((o) => o.kind === "manage_sell_offer_cancel").map((o) => o.metadata.offerId),
    ).toEqual(["12"]);
    expect(ops.some((o) => o.kind === "liquidity_pool_withdraw")).toBe(false);
  });

  it("plans no unwind when nothing classic holds the repay asset", () => {
    const tree = generatePlan(makeAudit({ offers: [audit.offers[1]!] }), positions, [], DEST, {
      network: TESTNET,
    });
    expect(tree.allNodes.has("classic-unwind")).toBe(false);
  });
});

describe("M-52 and M-18: the final transaction's review facts are recorded", () => {
  const ISSUER = Keypair.random().publicKey();
  const KEY = `USDC:${ISSUER}`;
  const audit = makeAudit({
    balances: [
      { asset: { kind: "native" }, amount: "50", buyingLiabilities: "0", sellingLiabilities: "0" },
      {
        asset: { kind: "credit", code: "USDC", issuer: ISSUER },
        amount: "10",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ],
  });
  const paths = new Map([
    [
      KEY,
      {
        sourceAmount: "10",
        destinationAmount: "40",
        path: [],
        reference: { sourceAmount: "0.01", destinationAmount: "0.04" },
      },
    ],
  ]);

  it("records the full-size quote the user reviewed and whether the marker is planned", () => {
    const tree = generatePlan(audit, emptyPositions(), [], DEST, { paths });
    const final = tree.allNodes.get("final-classic-tx");
    if (final?.kind !== "FinalClassicTx") throw new Error("expected FinalClassicTx");
    expect(final.metadata.reviewedConversionQuotes).toEqual({
      [KEY]: { sourceAmount: "10", destinationAmount: "40" },
    });
    expect(final.metadata.closeMarker).toBe(true);
    expect(final.description).not.toContain("not marked");
    // the execute-time re-batch gets the same options back
    const options = finalBatchOptions(final.metadata, { feePerOpStroops: 100 });
    expect(options.reviewedConversionQuotes).toEqual(final.metadata.reviewedConversionQuotes);
    expect(options.reviewedReferenceQuotes).toEqual(final.metadata.reviewedReferenceQuotes);
    expect(options.claimableBalanceIds).toEqual([]);
    expect(options.feePerOpStroops).toBe(100);
  });

  it("says when the close can't carry the marker", () => {
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST);
    const final = tree.allNodes.get("final-classic-tx");
    if (final?.kind !== "FinalClassicTx") throw new Error("expected FinalClassicTx");
    expect(final.metadata.closeMarker).toBe(false);
    expect(final.description).toContain("not marked as an Account Demolisher close");
  });
});

describe("decision 3: per-token answers to a refused conversion", () => {
  const A = StrKey.encodeContract(Buffer.alloc(32, 21));
  const B = StrKey.encodeContract(Buffer.alloc(32, 22));

  it("sends a token as-is or leaves it, as the user chose, while converting the rest", () => {
    const C = StrKey.encodeContract(Buffer.alloc(32, 23));
    const tree = generatePlan(makeAudit(), emptyPositions(), [], DEST, {
      heldTokens: [
        { contractId: A, balance: 5n },
        { contractId: B, balance: 6n },
        { contractId: C, balance: 7n },
      ],
      convertHeldTokensToXLM: true,
      sendHeldTokensAsIs: [A],
      leaveHeldTokens: [B],
    });
    expect(tree.allNodes.get(id("drain-token", A))?.kind).toBe("TransferAsIs");
    expect(tree.allNodes.has(id("convert-token", A))).toBe(false);
    expect(tree.allNodes.has(id("drain-token", B))).toBe(false);
    expect(tree.allNodes.has(id("convert-token", B))).toBe(false);
    expect(tree.allNodes.get(id("convert-token", C))?.kind).toBe("ConvertSorobanToXLM");
  });
});

describe("M-25: an exchange close can't take exit payouts it can't forward", () => {
  const NOW = 1_700_000_000_000;
  const unlocked = (queued: bigint) =>
    emptyPositions({
      backstop: [
        {
          poolId: POOL_ID,
          shares: 0n,
          queuedForWithdrawal: queued,
          unlockedQueuedForWithdrawal: 500n,
        },
      ],
    });
  const exchange = {
    now: NOW,
    network: TESTNET,
    useMediator: true,
    mediatorPublicKey: MED,
    flowToken: "flow",
  } as const;

  it("refuses before any step runs when the backstop withdraw pays out LP tokens", () => {
    expect(() => generatePlan(makeAudit(), unlocked(500n), [], DEST, exchange)).toThrow(
      /exchange close can only forward XLM.*BLND-USDC LP token CA5UTU\.\.\.DWDM/,
    );
  });

  // the preview asks before it mints a mediator flow the refused plan never uses
  it("gives callers the same refusal before a mediator is minted", () => {
    expect(() =>
      assertExchangeCloseCanRun(makeAudit(), unlocked(500n), { network: TESTNET }),
    ).toThrow(/exchange close can only forward XLM.*BLND-USDC LP token/);
    expect(() => assertExchangeCloseCanRun(makeAudit(), emptyPositions())).not.toThrow();
    expect(() => assertExchangeCloseCanRun(makeAudit(), unlocked(500n))).toThrow(
      /opts\.network is required/,
    );
  });

  it("refuses a pool exit that pays out a token the account holds no classic line for", () => {
    const token = StrKey.encodeContract(Buffer.alloc(32, 31));
    const positions = emptyPositions({
      soroswap: [
        {
          pair: { tokenA: token, tokenB: Asset.native().contractId(TESTNET.passphrase) },
          shareBalance: 5n,
        },
      ],
    });
    expect(() => generatePlan(makeAudit(), positions, [], DEST, exchange)).toThrow(
      /exchange close can only forward XLM/,
    );
    // the same exit on a direct close sweeps the token to the destination
    const direct = generatePlan(makeAudit(), positions, [], DEST, { network: TESTNET });
    expect(direct.allNodes.has(id("drain-token", token))).toBe(true);
  });

  it("still prepares an exchange close whose queue stays partly locked: the account stays open", () => {
    const tree = generatePlan(makeAudit(), unlocked(800n), [], DEST, exchange);
    expect(tree.prepareOnly).toBeDefined();
    expect(tree.allNodes.has(id("backstop-withdraw", POOL_ID))).toBe(true);
  });
});

describe("PLCL-30: callers can tell a prepare-only plan before minting a mediator", () => {
  const NOW = 1_700_000_000_000;
  const locked = emptyPositions({
    backstop: [{ poolId: POOL_ID, shares: 5n, queuedForWithdrawal: 0n }],
  });

  it("reports the unlock date for positions that keep a locked queue, and nothing otherwise", () => {
    expect(preparePlanFor(locked, NOW)?.unlocksAt.getTime()).toBe(NOW + 17 * 24 * 60 * 60 * 1000);
    expect(preparePlanFor(emptyPositions(), NOW)).toBeUndefined();
  });

  it("plans an exchange close's prepare run without a mediator or flow token", () => {
    const tree = generatePlan(makeAudit(), locked, [], DEST, { now: NOW, useMediator: true });
    expect(tree.prepareOnly).toBeDefined();
    expect(tree.allNodes.has("mediator-forward")).toBe(false);
    expect(tree.allNodes.has(id("backstop-queue", POOL_ID))).toBe(true);
  });
});

describe("M-25: the prepare-only unlock date is honest", () => {
  const NOW = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  const newQueue = emptyPositions({
    backstop: [{ poolId: POOL_ID, shares: 5n, queuedForWithdrawal: 0n }],
  });

  // the queue lands when the run executes, after the review
  it("does not call a new queue's review-time date the latest it unlocks", () => {
    const prepare = preparePlanFor(newQueue, NOW);
    expect(prepare?.unlocksAt.getTime()).toBe(NOW + 17 * DAY);
    expect(prepare?.queuedUnlocksAt).toBeUndefined();
    expect(prepare?.reason).not.toMatch(/the latest it can unlock/);
    expect(prepare?.reason).toMatch(/from the moment it lands on chain/);
  });

  it("dates an already locked queue from the unlock discovery read", () => {
    const readUnlock = new Date(NOW + 3 * DAY);
    // discovery reads the latest exp of the locked queue entries
    const deposit = {
      poolId: POOL_ID,
      shares: 0n,
      queuedForWithdrawal: 800n,
      unlockedQueuedForWithdrawal: 300n,
      latestQueueUnlocksAt: readUnlock,
    };
    const prepare = preparePlanFor(emptyPositions({ backstop: [deposit] }), NOW);
    expect(prepare?.unlocksAt).toEqual(readUnlock);
    expect(prepare?.queuedUnlocksAt).toEqual(readUnlock);
    expect(prepare?.reason).not.toMatch(/the latest it can unlock/);
  });

  it("dates a locked queue with no read unlock a full queue period out, as the latest", () => {
    const prepare = preparePlanFor(
      emptyPositions({
        backstop: [
          {
            poolId: POOL_ID,
            shares: 0n,
            queuedForWithdrawal: 800n,
            unlockedQueuedForWithdrawal: 300n,
          },
        ],
      }),
      NOW,
    );
    expect(prepare?.unlocksAt.getTime()).toBe(NOW + 17 * DAY);
    expect(prepare?.queuedUnlocksAt?.getTime()).toBe(NOW + 17 * DAY);
    expect(prepare?.reason).toMatch(/the latest it can unlock/);
  });

  it("takes the later of a new queue and an existing one", () => {
    const deposit = {
      poolId: POOL_ID,
      shares: 5n,
      queuedForWithdrawal: 10n,
      unlockedQueuedForWithdrawal: 0n,
      latestQueueUnlocksAt: new Date(NOW + 2 * DAY),
    };
    const prepare = preparePlanFor(emptyPositions({ backstop: [deposit] }), NOW);
    expect(prepare?.unlocksAt.getTime()).toBe(NOW + 17 * DAY);
    expect(prepare?.queuedUnlocksAt?.getTime()).toBe(NOW + 2 * DAY);
  });

  it("re-dates a new queue from the transaction built at execute", () => {
    const tree = generatePlan(makeAudit(), newQueue, [], DEST, { now: NOW });
    expect(preparedUnlocksAt(tree)?.getTime()).toBe(NOW + 17 * DAY);
    const queue = tree.allNodes.get(id("backstop-queue", POOL_ID));
    if (queue?.kind !== "BackstopQueue") throw new Error("expected the queue node");
    // what hydration records when it builds the queue right before signing
    const built = new Date(NOW + 17 * DAY + 40 * 60 * 1000);
    (queue.metadata as { queueEndsAt: Date }).queueEndsAt = built;
    expect(preparedUnlocksAt(tree)).toEqual(built);
  });

  it("keeps an existing queue's later unlock when the new queue unlocks first", () => {
    const later = new Date(NOW + 20 * DAY);
    const deposit = {
      poolId: POOL_ID,
      shares: 5n,
      queuedForWithdrawal: 10n,
      unlockedQueuedForWithdrawal: 0n,
      latestQueueUnlocksAt: later,
    };
    const tree = generatePlan(makeAudit(), emptyPositions({ backstop: [deposit] }), [], DEST, {
      now: NOW,
    });
    expect(preparedUnlocksAt(tree)).toEqual(later);
  });

  it("has no unlock date for a plan that merges", () => {
    expect(preparedUnlocksAt(generatePlan(makeAudit(), emptyPositions(), [], DEST))).toBe(
      undefined,
    );
  });
});

// a pool exit pays a SAC credit asset into the account's trustline, and with no
// line the whole exit traps with Error(Contract, #13) (read-only mainnet
// simulation of soroswap remove_liquidity and an aquarius withdraw)
describe("exit payouts need a trustline: the plan opens it first", () => {
  const ISSUER = Keypair.random().publicKey();
  const sac = (code: string): string => new Asset(code, ISSUER).contractId(TESTNET.passphrase);
  const YBX = sac("YBX");
  const AQUA = sac("AQUA");
  const XLM = Asset.native().contractId(TESTNET.passphrase);
  const OTHER_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 41));
  const missing = (code: string) =>
    ({ contractId: sac(code), code, issuer: ISSUER, reason: "missing" }) as const;
  const lineId = (code: string) => id("exit-trustline", sac(code));
  const soroswapYbx = emptyPositions({
    soroswap: [{ pair: { tokenA: YBX, tokenB: XLM }, shareBalance: 5n }],
  });

  it("adds the line ahead of the exit that pays the asset", () => {
    const tree = generatePlan(makeAudit(), soroswapYbx, [], DEST, {
      network: TESTNET,
      exitTrustlineGaps: [missing("YBX")],
    });
    const line = tree.allNodes.get(lineId("YBX"));
    if (line?.kind !== "AddExitTrustline") throw new Error("expected AddExitTrustline");
    expect(line.metadata).toEqual({
      kind: "AddExitTrustline",
      code: "YBX",
      issuer: ISSUER,
      contractId: YBX,
    });
    expect(line.dependencies).toEqual([]);
    expect(line.description).toBe(
      "Add a YBX trustline so the pool can pay it out (0.5 XLM reserve, released when the " +
        "close removes the line)",
    );
    expect(dependsOn(tree, id("soroswap-withdraw", YBX, XLM), lineId("YBX"))).toBe(true);
    expect(dependsOn(tree, "final-classic-tx", lineId("YBX"))).toBe(true);
    // the payout lands on the new classic line, which the final batch disposes
    // of, so it is not swept as a contract token
    expect(tree.allNodes.has(id("drain-token", YBX))).toBe(false);
  });

  it("lets an exchange close exit a pool whose payout gets a line", () => {
    const opts = {
      network: TESTNET,
      useMediator: true,
      mediatorPublicKey: MED,
      flowToken: "flow",
    } as const;
    expect(() => generatePlan(makeAudit(), soroswapYbx, [], DEST, opts)).toThrow(
      /exchange close can only forward XLM/,
    );
    const tree = generatePlan(makeAudit(), soroswapYbx, [], DEST, {
      ...opts,
      exitTrustlineGaps: [missing("YBX")],
    });
    expect(tree.allNodes.has(lineId("YBX"))).toBe(true);
  });

  it("opens one line per asset however many exits pay it", () => {
    const tree = generatePlan(
      makeAudit(),
      emptyPositions({
        soroswap: [{ pair: { tokenA: YBX, tokenB: XLM }, shareBalance: 5n }],
        aquarius: [{ poolIndex: "ab".repeat(32), shareBalance: 3n, tokens: [XLM, YBX] }],
        aquariusConcentrated: [
          {
            poolAddress: OTHER_TOKEN,
            poolIndex: "cd".repeat(32),
            tokens: [XLM, YBX],
            ranges: [{ tickLower: -10, tickUpper: 10, liquidity: 7n }],
            pendingFees: [1n, 1n],
            pendingReward: 0n,
          },
        ],
      }),
      [],
      DEST,
      { network: TESTNET, exitTrustlineGaps: [missing("YBX"), missing("YBX")] },
    );
    const lines = [...tree.allNodes.values()].filter((n) => n.kind === "AddExitTrustline");
    expect(lines.map((n) => n.id)).toEqual([lineId("YBX")]);
    for (const n of tree.allNodes.values()) {
      if (
        n.kind === "WithdrawSoroswapLp" ||
        n.kind === "WithdrawAquarius" ||
        n.kind === "WithdrawAquariusConcentrated" ||
        n.kind === "ClaimAquariusConcentratedFees"
      ) {
        expect(n.dependencies).toContain(lineId("YBX"));
      }
    }
  });

  // a concentrated position kept only for its reward: its pool tokens are not
  // paid out, the router's reward token is
  const rewardOnly = emptyPositions({
    aquariusConcentrated: [
      {
        poolAddress: OTHER_TOKEN,
        poolIndex: "cd".repeat(32),
        tokens: [XLM, YBX],
        ranges: [],
        pendingFees: [0n, 0n],
        pendingReward: 9n,
      },
    ],
  });

  it("puts the reward token's line ahead of the aquarius reward claims", () => {
    const tree = generatePlan(makeAudit(), rewardOnly, [], DEST, {
      network: TESTNET,
      exitTrustlineGaps: [missing("AQUA")],
      aquariusRewardToken: AQUA,
    });
    const claim = tree.allNodes.get(id("aquarius-cl-claim", OTHER_TOKEN));
    expect(claim?.dependencies).toEqual([lineId("AQUA")]);
    expect(tree.allNodes.get(lineId("AQUA"))?.metadata).toMatchObject({ contractId: AQUA });
  });

  it("does not take a pool token nothing pays out for the reward token", () => {
    const opts = { network: TESTNET, aquariusRewardToken: AQUA } as const;
    const tree = generatePlan(makeAudit(), rewardOnly, [], DEST, {
      ...opts,
      exitTrustlineGaps: [missing("YBX")],
    });
    expect(tree.allNodes.has(lineId("YBX"))).toBe(false);
    expect(tree.allNodes.get(id("aquarius-cl-claim", OTHER_TOKEN))?.dependencies).toEqual([]);
    // and an unauthorized line on it blocks nothing
    expect(() =>
      generatePlan(makeAudit(), rewardOnly, [], DEST, {
        ...opts,
        exitTrustlineGaps: [{ ...missing("YBX"), reason: "unauthorized" }],
      }),
    ).not.toThrow();
  });

  it("puts one line ahead of both a withdraw and the reward claim when both pay it", () => {
    const pool = { poolIndex: "ab".repeat(32), shareBalance: 3n, tokens: [XLM, AQUA] };
    const tree = generatePlan(makeAudit(), emptyPositions({ aquarius: [pool] }), [], DEST, {
      network: TESTNET,
      exitTrustlineGaps: [missing("AQUA")],
      aquariusRewardToken: AQUA,
    });
    const withdraw = id("aquarius-withdraw", XLM, AQUA, pool.poolIndex);
    expect(tree.allNodes.get(withdraw)?.dependencies).toEqual([lineId("AQUA")]);
    expect(
      tree.allNodes.get(id("aquarius-claim", XLM, AQUA, pool.poolIndex))?.dependencies,
    ).toEqual([withdraw, lineId("AQUA")]);
    expect(() =>
      generatePlan(makeAudit(), emptyPositions({ aquarius: [pool] }), [], DEST, {
        network: TESTNET,
        exitTrustlineGaps: [{ ...missing("AQUA"), reason: "unauthorized" }],
        aquariusRewardToken: AQUA,
      }),
    ).toThrow(/Aquarius pool .* and the Aquarius reward claims\./);
  });

  it("opens no reward line when no reward claim is planned", () => {
    const tree = generatePlan(makeAudit(), soroswapYbx, [], DEST, {
      network: TESTNET,
      exitTrustlineGaps: [missing("YBX"), missing("AQUA")],
      aquariusRewardToken: AQUA,
    });
    expect(tree.allNodes.has(lineId("AQUA"))).toBe(false);
  });

  it("refuses a reward claim into a line the issuer has not authorized", () => {
    expect(() =>
      generatePlan(makeAudit(), rewardOnly, [], DEST, {
        network: TESTNET,
        exitTrustlineGaps: [{ ...missing("AQUA"), reason: "unauthorized" }],
        aquariusRewardToken: AQUA,
      }),
    ).toThrow(/AQUA:G\w+ .*not authorized.*Aquarius reward claims/);
  });

  it("opens no line nothing in the plan pays out", () => {
    const tree = generatePlan(makeAudit(), soroswapYbx, [], DEST, {
      network: TESTNET,
      exitTrustlineGaps: [missing("YBX"), missing("AQUA")],
    });
    expect(tree.allNodes.has(lineId("AQUA"))).toBe(false);
  });

  it("refuses a close whose exit pays an asset into a line the issuer has not authorized", () => {
    expect(() =>
      generatePlan(makeAudit(), soroswapYbx, [], DEST, {
        network: TESTNET,
        exitTrustlineGaps: [{ ...missing("YBX"), reason: "unauthorized" }],
      }),
    ).toThrow(/YBX:G\w+ .*not authorized.*Soroswap pool/);
  });

  it("ignores an unauthorized line nothing in the plan pays into", () => {
    expect(() =>
      generatePlan(makeAudit(), soroswapYbx, [], DEST, {
        network: TESTNET,
        exitTrustlineGaps: [{ ...missing("AQUA"), reason: "unauthorized" }],
      }),
    ).not.toThrow();
  });

  it("refuses a gap whose asset does not derive to its token", () => {
    expect(() =>
      generatePlan(makeAudit(), soroswapYbx, [], DEST, {
        network: TESTNET,
        exitTrustlineGaps: [{ ...missing("YBX"), code: "XBY" }],
      }),
    ).toThrow(/XBY.*is not the asset of token/);
  });

  it("needs the network to plan a payout trustline", () => {
    expect(() =>
      generatePlan(makeAudit(), soroswapYbx, [], DEST, { exitTrustlineGaps: [missing("YBX")] }),
    ).toThrow(/opts\.network is required/);
  });
});
