import { describe, it, expect, vi, beforeEach } from "vitest";

// auditAccount reads horizon through getHorizon; the fake below stands in for
// the network only, every derivation runs through the real audit code
const fakeHorizon = {
  account: null as unknown,
  ledger: { sequence: 1000, closed_at: "2020-01-01T00:00:00Z" } as unknown,
  claimable: [] as unknown[],
};
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({
    loadAccount: async () => fakeHorizon.account,
    offers: () => ({
      forAccount: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }),
    }),
    claimableBalances: () => ({
      claimant: () => ({
        limit: () => ({ call: async () => ({ records: fakeHorizon.claimable }) }),
      }),
    }),
    ledgers: () => ({
      order: () => ({
        limit: () => ({ call: async () => ({ records: [fakeHorizon.ledger] }) }),
      }),
    }),
  }),
}));

import {
  assessMergeability,
  auditAccount,
  computeCoverableSponsorships,
  computeMergeability,
  computeRequiresMultisig,
} from "@/lib/stellar/account-audit";
import { TESTNET } from "@/lib/config/networks";
import type {
  AccountAudit,
  AuditBalance,
  AuditFlags,
  AuditThresholds,
  ClaimableBalanceEntry,
  SponsorshipInfo,
} from "@/lib/types/account";

const ACC = "GACCOUNT";
const OTHER = "GOTHER";

function thresholds(masterWeight: number, high: number): AuditThresholds {
  return { low: 0, medium: 0, high, masterWeight };
}

const noFlags: AuditFlags = {
  authImmutable: false,
  authRequired: false,
  authRevocable: false,
  authClawbackEnabled: false,
};

function sponsorship(numSponsoring: number, coverable: number): SponsorshipInfo {
  return { numSponsoring, numSponsored: 0, coverable };
}

describe("computeRequiresMultisig", () => {
  it("is false when the master weight meets the high threshold", () => {
    expect(computeRequiresMultisig(thresholds(1, 0))).toBe(false); // default account
    expect(computeRequiresMultisig(thresholds(1, 1))).toBe(false);
    expect(computeRequiresMultisig(thresholds(3, 2))).toBe(false);
    expect(computeRequiresMultisig(thresholds(2, 2))).toBe(false);
  });

  it("is true when the master weight is below the high threshold", () => {
    expect(computeRequiresMultisig(thresholds(1, 2))).toBe(true);
    expect(computeRequiresMultisig(thresholds(2, 5))).toBe(true);
  });

  it("is true when the master key is disabled (weight 0)", () => {
    expect(computeRequiresMultisig(thresholds(0, 0))).toBe(true);
    expect(computeRequiresMultisig(thresholds(0, 3))).toBe(true);
  });

  // path payments, change_trust and offers are medium-threshold and claims are
  // low; thresholds are independent, so either can sit above high
  it("is true when the medium or low threshold exceeds the master weight", () => {
    expect(computeRequiresMultisig({ low: 0, medium: 5, high: 1, masterWeight: 1 })).toBe(true);
    expect(computeRequiresMultisig({ low: 4, medium: 0, high: 1, masterWeight: 2 })).toBe(true);
    expect(computeRequiresMultisig({ low: 2, medium: 3, high: 1, masterWeight: 3 })).toBe(false);
  });
});

describe("computeMergeability", () => {
  it("blocks auth-immutable accounts", () => {
    const res = computeMergeability({ ...noFlags, authImmutable: true }, sponsorship(0, 0));
    expect(res).toMatchObject({ mergeable: false, reason: "AUTH_IMMUTABLE" });
  });

  it("is mergeable with no sponsorships", () => {
    expect(computeMergeability(noFlags, sponsorship(0, 0))).toEqual({ mergeable: true });
  });

  it("is mergeable when every sponsorship is released by the close (coverable)", () => {
    expect(computeMergeability(noFlags, sponsorship(2, 2))).toEqual({ mergeable: true });
  });

  it("blocks when there are foreign sponsorships beyond the coverable count", () => {
    const res = computeMergeability(noFlags, sponsorship(3, 1));
    expect(res).toMatchObject({ mergeable: false, reason: "IS_SPONSOR" });
    if (!res.mergeable) expect(res.detail).toContain("2 ledger entries");
  });

  it("uses singular wording for a single foreign sponsorship", () => {
    const res = computeMergeability(noFlags, sponsorship(1, 0));
    expect(res).toMatchObject({ mergeable: false, reason: "IS_SPONSOR" });
    if (!res.mergeable) expect(res.detail).toContain("1 ledger entry");
  });
});

const LEDGER = { sequence: 1000, closedAt: 1_577_836_800 };

function cb(
  id: string,
  sponsor: string,
  claimableNow: boolean | "unset" = true,
): ClaimableBalanceEntry {
  return {
    id,
    asset: { kind: "native" },
    amount: "1",
    sponsor,
    predicate: {},
    claimants: [ACC],
    ...(claimableNow === "unset" ? {} : { claimableNow }),
  };
}

describe("computeCoverableSponsorships", () => {
  it("counts only claimable balances the account sponsors itself", () => {
    expect(computeCoverableSponsorships(ACC, [cb("a", ACC), cb("b", OTHER)])).toBe(1);
  });

  it("does not count a self-sponsored CB that is not claimable now", () => {
    expect(computeCoverableSponsorships(ACC, [cb("a", ACC, false), cb("b", ACC, true)])).toBe(1);
  });

  it("does not count a CB whose claimability was never evaluated", () => {
    expect(computeCoverableSponsorships(ACC, [cb("a", ACC, "unset")])).toBe(0);
  });

  it("does not count a self-sponsored CB the user left out of the claim selection", () => {
    const cbs = [cb("a", ACC), cb("b", ACC)];
    expect(computeCoverableSponsorships(ACC, cbs, ["b"])).toBe(1);
    expect(computeCoverableSponsorships(ACC, cbs, [])).toBe(0);
    expect(computeCoverableSponsorships(ACC, cbs)).toBe(2);
  });
});

function baseAudit(overrides: Partial<AccountAudit> = {}): AccountAudit {
  return {
    accountId: ACC,
    sequence: String(500n << 32n),
    subentryCount: 0,
    thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
    flags: noFlags,
    balances: [
      { asset: { kind: "native" }, amount: "10", buyingLiabilities: "0", sellingLiabilities: "0" },
    ],
    signers: [],
    offers: [],
    data: [],
    claimableBalances: [],
    poolShares: [],
    sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
    requiresMultisig: false,
    mergeability: { mergeable: true },
    ...overrides,
  };
}

function credit(code: string, amount: string, isAuthorized: boolean): AuditBalance {
  return {
    asset: { kind: "credit", code, issuer: OTHER },
    amount,
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    isAuthorized,
    isAuthorizedToMaintainLiabilities: false,
  };
}

describe("assessMergeability", () => {
  const opts = { ledger: LEDGER, transactionsBeforeMerge: 1 };

  it("is mergeable for a plain account", () => {
    expect(assessMergeability(baseAudit(), opts)).toEqual({ mergeable: true });
  });

  it("blocks auth-immutable accounts", () => {
    const res = assessMergeability(baseAudit({ flags: { ...noFlags, authImmutable: true } }), opts);
    expect(res).toMatchObject({ mergeable: false, reason: "AUTH_IMMUTABLE" });
  });

  // a sponsoring account with data entries used to look closeable because data
  // entries were counted against num_sponsoring; the merge then failed with
  // op_is_sponsor. an account cannot sponsor its own entries.
  it("blocks a foreign sponsorship even when the account has data entries", () => {
    const audit = baseAudit({
      data: [
        { name: "k1", value: "djE=" },
        { name: "k2", value: "djI=" },
      ],
      sponsorship: { numSponsoring: 1, numSponsored: 0, coverable: 0 },
    });
    expect(assessMergeability(audit, opts)).toMatchObject({
      mergeable: false,
      reason: "IS_SPONSOR",
    });
  });

  it("counts a self-sponsored CB as released only when it is in the claim selection", () => {
    const audit = baseAudit({
      claimableBalances: [cb("self", ACC)],
      sponsorship: { numSponsoring: 1, numSponsored: 0, coverable: 1 },
    });
    expect(assessMergeability(audit, opts)).toEqual({ mergeable: true });
    expect(assessMergeability(audit, { ...opts, claimableBalanceIds: ["self"] })).toEqual({
      mergeable: true,
    });
    expect(assessMergeability(audit, { ...opts, claimableBalanceIds: [] })).toMatchObject({
      mergeable: false,
      reason: "IS_SPONSOR",
    });
  });

  it("blocks a positive balance on a deauthorized trustline", () => {
    const audit = baseAudit({
      balances: [...baseAudit().balances, credit("FRZ", "100", false)],
    });
    const res = assessMergeability(audit, opts);
    expect(res).toMatchObject({ mergeable: false, reason: "FROZEN_TRUSTLINE" });
    if (!res.mergeable) expect(res.detail).toContain("FRZ");
  });

  it("does not block a zero balance on a deauthorized trustline", () => {
    const audit = baseAudit({
      balances: [...baseAudit().balances, credit("FRZ", "0.0000000", false)],
    });
    expect(assessMergeability(audit, opts)).toEqual({ mergeable: true });
  });

  it("does not block an authorized trustline", () => {
    const audit = baseAudit({
      balances: [...baseAudit().balances, credit("USD", "5", true)],
    });
    expect(assessMergeability(audit, opts)).toEqual({ mergeable: true });
  });

  // core refuses a merge once the source sequence reaches (ledger << 32)
  it("blocks when the sequence would reach the merge ceiling", () => {
    const ceiling = BigInt(LEDGER.sequence + 1) << 32n;
    const tooFar = baseAudit({ sequence: String(ceiling - 1n) });
    const res = assessMergeability(tooFar, opts);
    expect(res).toMatchObject({ mergeable: false, reason: "SEQNUM_TOO_FAR" });
    if (!res.mergeable) expect(res.detail).toContain(String(LEDGER.sequence + 2));
  });

  it("counts every transaction submitted before and including the merge", () => {
    const ceiling = BigInt(LEDGER.sequence + 1) << 32n;
    const audit = baseAudit({ sequence: String(ceiling - 3n) });
    expect(assessMergeability(audit, { ...opts, transactionsBeforeMerge: 2 })).toEqual({
      mergeable: true,
    });
    expect(assessMergeability(audit, { ...opts, transactionsBeforeMerge: 3 })).toMatchObject({
      mergeable: false,
      reason: "SEQNUM_TOO_FAR",
    });
  });

  it("rejects a transaction count below one", () => {
    expect(() =>
      assessMergeability(baseAudit(), { ...opts, transactionsBeforeMerge: 0 }),
    ).toThrow();
  });
});

describe("auditAccount", () => {
  beforeEach(() => {
    fakeHorizon.ledger = { sequence: 1000, closed_at: "2020-01-01T00:00:00Z" };
    fakeHorizon.claimable = [];
  });

  function horizonAccount(extra: Record<string, unknown> = {}): unknown {
    return {
      account_id: ACC,
      sequence: "4294967296",
      subentry_count: 2,
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: {
        auth_immutable: false,
        auth_required: false,
        auth_revocable: false,
        auth_clawback_enabled: false,
      },
      balances: [
        {
          asset_type: "native",
          balance: "10.0000000",
          buying_liabilities: "0",
          selling_liabilities: "0",
        },
      ],
      signers: [{ key: ACC, type: "ed25519_public_key", weight: 1 }],
      data_attr: { k1: "djE=", k2: "djI=" },
      num_sponsoring: 1,
      num_sponsored: 0,
      ...extra,
    };
  }

  it("does not count data entries against a foreign sponsorship", async () => {
    fakeHorizon.account = horizonAccount();
    const audit = await auditAccount(ACC, TESTNET);
    expect(audit.sponsorship.coverable).toBe(0);
    expect(audit.mergeability).toMatchObject({ mergeable: false, reason: "IS_SPONSOR" });
  });

  it("returns the ledger it evaluated against", async () => {
    fakeHorizon.account = horizonAccount({ num_sponsoring: 0 });
    const audit = await auditAccount(ACC, TESTNET);
    expect(audit.ledger).toEqual({ sequence: 1000, closedAt: 1_577_836_800 });
  });

  it("evaluates claimability against the ledger close time and the signing window", async () => {
    fakeHorizon.account = horizonAccount({ num_sponsoring: 0 });
    const ledgerSeconds = 1_577_836_800;
    const record = (id: string, absBefore: number) => ({
      id,
      asset: "native",
      amount: "1",
      sponsor: OTHER,
      claimants: [{ destination: ACC, predicate: { abs_before_epoch: String(absBefore) } }],
    });
    fakeHorizon.claimable = [
      record("soon", ledgerSeconds + 60),
      record("later", ledgerSeconds + 3600),
    ];
    const audit = await auditAccount(ACC, TESTNET);
    const byId = new Map(audit.claimableBalances.map((c) => [c.id, c.claimableNow]));
    // expires inside the default 300 s window: claiming it could fail on chain
    expect(byId.get("soon")).toBe(false);
    expect(byId.get("later")).toBe(true);

    const wide = await auditAccount(ACC, TESTNET, { claimWindowSeconds: 7200 });
    expect(wide.claimableBalances.find((c) => c.id === "later")?.claimableNow).toBe(false);
  });
});
