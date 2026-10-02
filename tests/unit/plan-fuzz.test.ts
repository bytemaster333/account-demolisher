import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { StrKey } from "@stellar/stellar-sdk";

import { batchClassicDemolition, MAX_OPS_PER_TX } from "@/lib/plan/classic-batcher";
import { generatePlan } from "@/lib/plan/generator";
import { buildPlanTree, topologicalOrder, type PlanNode } from "@/lib/plan/tree";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";

// Property-based fuzzing (Tranche-3 deliverable): assert that NO random account
// state yields a "stranding sequence" — a plan where the irreversible merge runs
// before a teardown/position step — and that the plan tree rejects any cycle.

const DEST = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const ACC = "GB6NVEN5HSUBKMYCE5ZOWSK5K23TBWRUQLZY3KNMXUZ3AQ2ESC4MY4AQ";

const emptyPositions = (): ProtocolPositions => ({
  blend: [],
  backstop: [],
  aquarius: [],
  soroswap: [],
  fxdao: [],
  errors: [],
});

const arbG = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((b) => StrKey.encodeEd25519PublicKey(Buffer.from(b)));
const arbHex64 = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((b) => Buffer.from(b).toString("hex"));
const arbAmount = fc.integer({ min: 1, max: 1_000_000 }).map((n) => `${n}.0000000`);
const arbCode = fc.constantFrom("USDC", "EURC", "ABCD", "BTC", "GOLD");
const arbCredit: fc.Arbitrary<AssetIdentifier> = fc
  .record({ code: arbCode, issuer: arbG })
  .map(({ code, issuer }) => ({ kind: "credit", code, issuer }) as const);
const arbAsset: fc.Arbitrary<AssetIdentifier> = fc.oneof(
  fc.constant({ kind: "native" } as const),
  arbCredit,
);

const arbBalance = fc.record({
  asset: arbCredit,
  amount: arbAmount,
  buyingLiabilities: fc.constant("0"),
  sellingLiabilities: fc.constant("0"),
});

const arbOffer = fc.record({
  id: fc.integer({ min: 1, max: 99_999 }).map(String),
  selling: arbAsset,
  buying: arbCredit,
  amount: arbAmount,
  priceR: fc.constant({ n: 1, d: 1 }),
});

const arbData = fc.record({
  name: fc.string({ minLength: 1, maxLength: 10 }),
  value: fc.constant("AA=="),
});

// a holder never owns more than the pool's total shares, so the share balance
// is drawn at or below the total
const arbShares = fc
  .integer({ min: 1, max: 1_000_000 })
  .chain((total) =>
    fc
      .integer({ min: 1, max: total })
      .map((share) => ({ shareBalance: `${share}.0000000`, totalShares: `${total}.0000000` })),
  );

const arbPoolShare = fc
  .record({
    poolId: arbHex64,
    shares: arbShares,
    reserves: fc.tuple(
      fc.record({ asset: arbAsset, amount: arbAmount }),
      fc.record({ asset: arbCredit, amount: arbAmount }),
    ),
  })
  .map(({ poolId, shares, reserves }) => ({
    poolId,
    poolType: "constant_product",
    ...shares,
    shareLimit: "1000000.0000000",
    fee: 30,
    reserves,
  }));

const arbClaimable = fc.record({
  id: arbHex64,
  asset: arbAsset,
  amount: arbAmount,
  sponsor: arbG,
  predicate: fc.constant(null),
  claimants: fc.constant([] as string[]),
  claimableNow: fc.boolean(),
});

const arbSigner = fc.record({
  key: arbG,
  type: fc.constant("ed25519_public_key" as const),
  weight: fc.integer({ min: 0, max: 10 }),
});

// arrays are sized so a run can exceed MAX_OPS_PER_TX (100) and force the
// high-subentry transaction-splitting path, and subentryCount is derived from the
// actual subentries rather than pinned to 0.
const arbAudit: fc.Arbitrary<AccountAudit> = fc
  .record({
    balances: fc.array(arbBalance, { maxLength: 20 }),
    offers: fc.array(arbOffer, { maxLength: 60 }),
    data: fc.array(arbData, { maxLength: 60 }),
    poolShares: fc.array(arbPoolShare, { maxLength: 6 }),
    claimableBalances: fc.array(arbClaimable, { maxLength: 10 }),
    signers: fc.array(arbSigner, { maxLength: 20 }),
  })
  .map((r) => {
    const subentryCount =
      r.balances.length +
      r.offers.length +
      r.data.length +
      r.signers.length +
      r.poolShares.length +
      r.claimableBalances.length;
    return {
      accountId: ACC,
      sequence: "1",
      subentryCount,
      thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
      flags: {
        authImmutable: false,
        authRequired: false,
        authRevocable: false,
        authClawbackEnabled: false,
      },
      balances: r.balances,
      signers: r.signers,
      offers: r.offers,
      data: r.data,
      claimableBalances: r.claimableBalances,
      poolShares: r.poolShares,
      sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
      requiresMultisig: false,
      mergeability: { mergeable: true },
    } as unknown as AccountAudit;
  });

// randomized DeFi positions across all four protocols + the Blend backstop, so
// the stranding invariant is asserted over accounts that also carry Soroban
// positions (not just classic subentries). All contract-id-shaped fields use
// valid StrKey C... ids so plan generation sees well-formed input.
const arbContractId = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((b) => StrKey.encodeContract(Buffer.from(b)));
const arbBig = fc.integer({ min: 1, max: 1_000_000_000 }).map((n) => BigInt(n));
const arbTokenMap = fc
  .array(fc.tuple(arbContractId, arbBig), { maxLength: 3 })
  .map((entries) => new Map(entries));

const arbBlendPos = fc.record({
  poolId: arbContractId,
  liabilities: arbTokenMap,
  collateral: arbTokenMap,
  supply: arbTokenMap,
  emissionReserveTokenIds: fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: 3 }),
});
const arbBackstopPos = fc.record({
  poolId: arbContractId,
  shares: arbBig,
  queuedForWithdrawal: fc.oneof(fc.constant(0n), arbBig),
});
const arbAquariusPos = fc.record({
  poolIndex: arbHex64,
  shareBalance: arbBig,
  tokens: fc.array(arbContractId, { minLength: 2, maxLength: 2 }),
});
const arbSoroswapPos = fc.record({
  pair: fc.record({ tokenA: arbContractId, tokenB: arbContractId }),
  shareBalance: arbBig,
});
const arbFxdaoPos = fc.record({
  denomination: fc.constantFrom("USDx", "EURx", "GBPx", "FXG"),
  debt: fc.oneof(fc.constant(0n), arbBig),
  collateral: arbBig,
});

const arbPositions: fc.Arbitrary<ProtocolPositions> = fc.record({
  blend: fc.array(arbBlendPos, { maxLength: 2 }),
  backstop: fc.array(arbBackstopPos, { maxLength: 1 }),
  aquarius: fc.array(arbAquariusPos, { maxLength: 2 }),
  soroswap: fc.array(arbSoroswapPos, { maxLength: 2 }),
  // one vault per denomination, as on-chain discovery returns it (the pay-debt
  // node id is keyed by denomination, so duplicates can't occur in practice)
  fxdao: fc.uniqueArray(arbFxdaoPos, { maxLength: 4, selector: (p) => p.denomination }),
  errors: fc.constant([] as { protocol: string; message: string }[]),
}) as fc.Arbitrary<ProtocolPositions>;

// the merge, IF a plan schedules one, must be ordered last except for the
// mediator forward. holds whether or not a merge is emitted (a backstop can defer
// it), and topologicalOrder throwing on a cycle/unresolved dep also fails here.
function assertStrandingFree(order: readonly PlanNode[]): void {
  const finalIdx = order.findIndex((n) => n.id === "final-classic-tx");
  if (finalIdx < 0) return;
  for (let i = finalIdx + 1; i < order.length; i++) {
    expect(order[i]!.kind).toBe("MediatorForward");
  }
}

describe("plan generation — property-based fuzzing", () => {
  it("produces a valid, stranding-free DAG for any classic account state", () => {
    fc.assert(
      fc.property(arbAudit, (audit) => {
        const tree = generatePlan(audit, emptyPositions(), [], DEST);
        // topologicalOrder throws on a cycle or an unresolved dependency
        const order = topologicalOrder(tree);
        const finalIdx = order.findIndex((n) => n.id === "final-classic-tx");
        expect(finalIdx).toBeGreaterThanOrEqual(0);
        // NOTHING except the mediator forward may be ordered AFTER the merge; any
        // teardown/position node scheduled after account_merge would be stranded
        for (let i = finalIdx + 1; i < order.length; i++) {
          expect(order[i]!.kind).toBe("MediatorForward");
        }
      }),
      { numRuns: 250 },
    );
  });

  it("packs every classic batch within one transaction with the merge group whole and last", () => {
    const mediator = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7));
    fc.assert(
      fc.property(arbAudit, fc.boolean(), (audit, useMediator) => {
        const batches = batchClassicDemolition(
          audit,
          useMediator
            ? { destination: DEST, useMediator: true, mediatorPublicKey: mediator }
            : { destination: DEST, useMediator: false },
        );
        for (const b of batches) {
          expect(b.operations.length).toBeGreaterThan(0);
          expect(b.operations.length).toBeLessThanOrEqual(MAX_OPS_PER_TX);
        }
        const last = batches[batches.length - 1]!.operations.map((o) => o.kind);
        expect(last[last.length - 1]).toBe("account_merge");
        if (useMediator) expect(last[last.length - 2]).toBe("create_account_mediator");
        for (const b of batches.slice(0, -1)) {
          for (const op of b.operations) {
            expect([
              "set_options_clear_signers",
              "account_merge",
              "create_account_mediator",
            ]).not.toContain(op.kind);
          }
        }
      }),
      { numRuns: 250 },
    );
  });

  it("produces a stranding-free DAG for any account carrying DeFi positions", () => {
    fc.assert(
      fc.property(arbAudit, arbPositions, (audit, positions) => {
        const tree = generatePlan(audit, positions, [], DEST);
        assertStrandingFree(topologicalOrder(tree));
      }),
      { numRuns: 200 },
    );
  });

  it("rejects any dependency cycle in the plan tree", () => {
    const planNode = (id: string, deps: string[]): PlanNode =>
      ({
        id,
        kind: "RevokeAllowance",
        dependencies: deps,
        status: "pending",
        description: id,
        metadata: { kind: "RevokeAllowance" },
      }) as unknown as PlanNode;

    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (n) => {
        // a chain n0 → n1 → … → n(n-1), then close it into a cycle with a back edge
        const nodes: PlanNode[] = [];
        for (let i = 0; i < n; i++) {
          nodes.push(planNode(`n${i}`, i > 0 ? [`n${i - 1}`] : [`n${n - 1}`]));
        }
        expect(() => buildPlanTree(nodes)).toThrow(/cycle/i);
      }),
      { numRuns: 50 },
    );
  });
});
