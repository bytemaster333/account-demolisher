import { describe, it, expect } from "vitest";
import { Asset, Keypair, StrKey } from "@stellar/stellar-sdk";
import { TESTNET } from "@/lib/config/networks";
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
    const tree = generatePlan(makeAudit(), richPositions(), [], DEST);
    const repayId = id("blend-repay", POOL_ID, ASSET_A);
    const withdrawId = id("blend-withdraw-collateral", POOL_ID, ASSET_A);
    // edge exists (dropping it would let the withdraw run first on-chain)
    expect(dependsOn(tree, withdrawId, repayId)).toBe(true);
    const order = topologicalOrder(tree);
    expect(indexOf(order, repayId)).toBeLessThan(indexOf(order, withdrawId));
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

  it("never converts on a mediator (CEX) close: an exchange can't receive a raw token", () => {
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

  it("plans no payout sweep on an exchange close", () => {
    const tree = generatePlan(makeAudit(), positions, [], DEST, {
      networkPassphrase: TESTNET.passphrase,
      useMediator: true,
      mediatorPublicKey: MED,
      flowToken: "nonce.exp.mac",
    });
    expect(tree.allNodes.has(id("drain-token", TOKEN_X))).toBe(false);
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
