import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { StrKey } from "@stellar/stellar-sdk";

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

const arbPoolShare = fc.record({
  poolId: arbHex64,
  poolType: fc.constant("constant_product"),
  shareBalance: arbAmount,
  totalShares: arbAmount,
  shareLimit: fc.constant("1000000.0000000"),
  fee: fc.constant(30),
  reserves: fc.tuple(
    fc.record({ asset: arbAsset, amount: arbAmount }),
    fc.record({ asset: arbCredit, amount: arbAmount }),
  ),
});

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

const arbAudit: fc.Arbitrary<AccountAudit> = fc
  .record({
    balances: fc.array(arbBalance, { maxLength: 4 }),
    offers: fc.array(arbOffer, { maxLength: 4 }),
    data: fc.array(arbData, { maxLength: 4 }),
    poolShares: fc.array(arbPoolShare, { maxLength: 2 }),
    claimableBalances: fc.array(arbClaimable, { maxLength: 3 }),
    signers: fc.array(arbSigner, { maxLength: 4 }),
  })
  .map(
    (r) =>
      ({
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
        balances: r.balances,
        signers: r.signers,
        offers: r.offers,
        data: r.data,
        claimableBalances: r.claimableBalances,
        poolShares: r.poolShares,
        sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
        requiresMultisig: false,
        mergeability: { mergeable: true },
      }) as unknown as AccountAudit,
  );

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
