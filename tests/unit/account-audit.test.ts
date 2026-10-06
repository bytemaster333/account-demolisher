import { describe, it, expect, vi, beforeEach } from "vitest";

// auditAccount reads horizon through getHorizon; the fake below stands in for
// the network only, every derivation runs through the real audit code
const fakeHorizon = {
  account: null as unknown,
  ledger: { sequence: 1000, closed_at: "2020-01-01T00:00:00Z" } as unknown,
  claimable: [] as unknown[],
  // other accounts by id (asset issuers); an Error value is thrown on load
  others: {} as Record<string, unknown>,
  loads: [] as string[],
};
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({
    loadAccount: async (id: string) => {
      fakeHorizon.loads.push(id);
      if (id === (fakeHorizon.account as { account_id: string }).account_id) {
        return fakeHorizon.account;
      }
      const other = fakeHorizon.others[id];
      if (other instanceof Error) throw other;
      if (other === undefined) throw new NotFoundError("Not Found", { status: 404 });
      return other;
    },
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

import { NetworkError, NotFoundError } from "@stellar/stellar-sdk";
import {
  assessMergeability,
  auditAccount,
  collectableClaimableBalanceIds,
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
  it("counts only claimed balances the account sponsors itself", () => {
    expect(computeCoverableSponsorships(ACC, [cb("a", ACC), cb("b", OTHER)], ["a", "b"])).toBe(1);
  });

  it("does not count a self-sponsored CB that is not claimable now", () => {
    const cbs = [cb("a", ACC, false), cb("b", ACC, true)];
    expect(computeCoverableSponsorships(ACC, cbs, ["a", "b"])).toBe(1);
  });

  it("does not count a CB whose claimability was never evaluated", () => {
    expect(computeCoverableSponsorships(ACC, [cb("a", ACC, "unset")], ["a"])).toBe(0);
  });

  it("does not count a self-sponsored CB the plan does not claim", () => {
    const cbs = [cb("a", ACC), cb("b", ACC)];
    expect(computeCoverableSponsorships(ACC, cbs, ["b"])).toBe(1);
    expect(computeCoverableSponsorships(ACC, cbs, [])).toBe(0);
  });
});

function creditCb(
  id: string,
  code: string,
  amount: string,
  extra: Partial<ClaimableBalanceEntry> & { issuerAuthRequired?: boolean } = {},
): ClaimableBalanceEntry {
  return { ...cb(id, ACC), asset: { kind: "credit", code, issuer: OTHER }, amount, ...extra };
}

// what the audit can tell on its own about whether a claim would succeed; the
// stored coverable count must not credit a self-sponsored CB the close cannot
// claim, or the merge fails with op_is_sponsor after mergeability said yes
describe("collectableClaimableBalanceIds", () => {
  const line = (
    code: string,
    amount: string,
    limit: string,
    isAuthorized = true,
  ): AuditBalance => ({
    ...credit(code, amount, isAuthorized),
    limit,
  });

  it("collects native balances and credits on an authorized trustline with room", () => {
    const ids = collectableClaimableBalanceIds(
      [line("USD", "1", "100")],
      [cb("xlm", ACC), creditCb("usd", "USD", "50")],
    );
    expect(ids).toEqual(["xlm", "usd"]);
  });

  it("skips a credit the account does not trust unless the issuer lets anyone hold it", () => {
    const ids = collectableClaimableBalanceIds(
      [],
      [
        creditCb("open", "OPEN", "5", { issuerAuthRequired: false }),
        creditCb("gated", "GATED", "5", { issuerAuthRequired: true }),
        creditCb("unknown", "GONE", "5"),
      ],
    );
    expect(ids).toEqual(["open"]);
  });

  it("skips a deauthorized trustline and a claim that overflows the limit", () => {
    const ids = collectableClaimableBalanceIds(
      [line("FRZ", "0", "100", false), line("CAP", "90", "100")],
      [
        creditCb("frozen", "FRZ", "1"),
        creditCb("fits", "CAP", "6"),
        // the first claim already used 6 of the 10 left
        creditCb("overflow", "CAP", "5"),
      ],
    );
    expect(ids).toEqual(["fits"]);
  });

  it("skips balances that are not claimable now", () => {
    expect(collectableClaimableBalanceIds([], [cb("later", ACC, false)])).toEqual([]);
  });

  // an issuer claiming its own asset needs no trustline (it cannot hold one), so
  // the claim succeeds whatever its own auth flags say
  it("collects a balance of the account's own asset without a trustline", () => {
    const own = {
      ...creditCb("own", "OWN", "5"),
      asset: { kind: "credit" as const, code: "OWN", issuer: ACC },
      issuedByAccount: true as const,
    };
    expect(collectableClaimableBalanceIds([], [own])).toEqual(["own"]);
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
  const opts = { ledger: LEDGER, claimedBalanceIds: [] as string[], transactionsBeforeMerge: 1 };

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

  it("counts a self-sponsored CB as released only when the plan claims it", () => {
    const audit = baseAudit({
      claimableBalances: [cb("self", ACC)],
      sponsorship: { numSponsoring: 1, numSponsored: 0, coverable: 1 },
    });
    expect(assessMergeability(audit, { ...opts, claimedBalanceIds: ["self"] })).toEqual({
      mergeable: true,
    });
    // left behind by the plan (for example no trustline and the issuer requires
    // authorization): the stored coverable count does not override that
    expect(assessMergeability(audit, { ...opts, claimedBalanceIds: [] })).toMatchObject({
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
    fakeHorizon.others = {};
    fakeHorizon.loads = [];
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

  const ISSUER_OPEN = "GISSUEROPEN";
  const ISSUER_GATED = "GISSUERGATED";
  const ISSUER_GONE = "GISSUERGONE";
  const issuerAccount = (id: string, authRequired: boolean) => ({
    account_id: id,
    flags: {
      auth_required: authRequired,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
  });
  const cbRecord = (id: string, asset: string, sponsor = OTHER) => ({
    id,
    asset,
    amount: "5.0000000",
    sponsor,
    claimants: [{ destination: ACC, predicate: { unconditional: true } }],
  });

  // a claimable balance of an asset the account does not trust can only be
  // collected by adding the trustline first, which works only when the issuer
  // does not require authorization
  it("reads the issuer's auth_required flag for credits the account does not trust", async () => {
    fakeHorizon.account = horizonAccount({ num_sponsoring: 0 });
    fakeHorizon.others = {
      [ISSUER_OPEN]: issuerAccount(ISSUER_OPEN, false),
      [ISSUER_GATED]: issuerAccount(ISSUER_GATED, true),
    };
    fakeHorizon.claimable = [
      cbRecord("open-1", `OPEN:${ISSUER_OPEN}`),
      cbRecord("open-2", `OPEN2:${ISSUER_OPEN}`),
      cbRecord("gated", `GATED:${ISSUER_GATED}`),
      cbRecord("gone", `GONE:${ISSUER_GONE}`),
      cbRecord("xlm", "native"),
    ];
    fakeHorizon.loads = [];
    const audit = await auditAccount(ACC, TESTNET);
    const byId = new Map(
      audit.claimableBalances.map((c) => [c.id, c as { issuerAuthRequired?: boolean }]),
    );
    expect(byId.get("open-1")?.issuerAuthRequired).toBe(false);
    expect(byId.get("open-2")?.issuerAuthRequired).toBe(false);
    expect(byId.get("gated")?.issuerAuthRequired).toBe(true);
    // a missing issuer cannot back a new trustline (op_no_issuer), so it stays unknown
    expect(byId.get("gone")).not.toHaveProperty("issuerAuthRequired");
    expect(byId.get("xlm")).not.toHaveProperty("issuerAuthRequired");
    // one lookup per distinct issuer
    expect(fakeHorizon.loads.filter((id) => id === ISSUER_OPEN)).toHaveLength(1);
  });

  it("does not look up issuers of trusted credits or of balances not claimable now", async () => {
    fakeHorizon.account = horizonAccount({
      num_sponsoring: 0,
      balances: [
        ...(horizonAccount() as { balances: unknown[] }).balances,
        {
          asset_type: "credit_alphanum4",
          asset_code: "USD",
          asset_issuer: ISSUER_GATED,
          balance: "0.0000000",
          limit: "1000.0000000",
          buying_liabilities: "0",
          selling_liabilities: "0",
          is_authorized: true,
        },
      ],
    });
    fakeHorizon.others = {};
    fakeHorizon.claimable = [
      cbRecord("trusted", `USD:${ISSUER_GATED}`),
      {
        ...cbRecord("later", `OPEN:${ISSUER_OPEN}`),
        claimants: [{ destination: ACC, predicate: { not: { unconditional: true } } }],
      },
    ];
    fakeHorizon.loads = [];
    const audit = await auditAccount(ACC, TESTNET);
    expect(fakeHorizon.loads).toEqual([ACC]);
    expect(audit.claimableBalances.find((c) => c.id === "trusted")).not.toHaveProperty(
      "issuerAuthRequired",
    );
  });

  it("surfaces an issuer lookup failure other than not-found", async () => {
    fakeHorizon.account = horizonAccount({ num_sponsoring: 0 });
    fakeHorizon.others = { [ISSUER_OPEN]: new NetworkError("Bad Gateway", { status: 502 }) };
    fakeHorizon.claimable = [cbRecord("open", `OPEN:${ISSUER_OPEN}`)];
    await expect(auditAccount(ACC, TESTNET)).rejects.toThrow("Bad Gateway");
  });

  // the account is the asset's issuer: it claims its own asset without a
  // trustline, and change_trust on its own asset is op_malformed, so neither its
  // auth_required flag nor an issuer lookup applies
  it("marks a balance of the account's own asset as issued by it, with no lookup", async () => {
    fakeHorizon.account = horizonAccount({
      num_sponsoring: 0,
      flags: {
        auth_immutable: false,
        auth_required: true,
        auth_revocable: true,
        auth_clawback_enabled: false,
      },
    });
    fakeHorizon.claimable = [cbRecord("own", `OWN:${ACC}`)];
    fakeHorizon.loads = [];
    const audit = await auditAccount(ACC, TESTNET);
    const own = audit.claimableBalances.find((c) => c.id === "own");
    expect(own).toMatchObject({ issuedByAccount: true, claimableNow: true });
    expect(own).not.toHaveProperty("issuerAuthRequired");
    expect(fakeHorizon.loads).toEqual([ACC]);
    expect(collectableClaimableBalanceIds(audit.balances, audit.claimableBalances)).toEqual([
      "own",
    ]);
  });

  it("counts a self-sponsored balance of its own asset as coverable", async () => {
    fakeHorizon.account = horizonAccount({
      num_sponsoring: 1,
      data_attr: {},
      flags: {
        auth_immutable: false,
        auth_required: true,
        auth_revocable: false,
        auth_clawback_enabled: false,
      },
    });
    fakeHorizon.claimable = [cbRecord("own", `OWN:${ACC}`, ACC)];
    const audit = await auditAccount(ACC, TESTNET);
    expect(audit.sponsorship.coverable).toBe(1);
    expect(audit.mergeability).toEqual({ mergeable: true });
  });

  // a self-sponsored CB the close cannot claim keeps num_sponsoring above zero
  it("does not count a self-sponsored CB of an asset it cannot trust as coverable", async () => {
    fakeHorizon.account = horizonAccount({ num_sponsoring: 2 });
    fakeHorizon.others = {
      [ISSUER_OPEN]: issuerAccount(ISSUER_OPEN, false),
      [ISSUER_GATED]: issuerAccount(ISSUER_GATED, true),
    };
    fakeHorizon.claimable = [
      cbRecord("open", `OPEN:${ISSUER_OPEN}`, ACC),
      cbRecord("gated", `GATED:${ISSUER_GATED}`, ACC),
    ];
    const audit = await auditAccount(ACC, TESTNET);
    expect(audit.sponsorship.coverable).toBe(1);
    expect(audit.mergeability).toMatchObject({ mergeable: false, reason: "IS_SPONSOR" });
  });
});
