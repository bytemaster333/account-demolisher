import { describe, it, expect } from "vitest";
import {
  computeCoverableSponsorships,
  computeMergeability,
  computeRequiresMultisig,
} from "@/lib/stellar/account-audit";
import type {
  AuditBalance,
  AuditFlags,
  AuditSigner,
  AuditThresholds,
  ClaimableBalanceEntry,
  DataEntry,
  OfferEntry,
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
});

describe("computeMergeability", () => {
  it("blocks auth-immutable accounts", () => {
    const res = computeMergeability({ ...noFlags, authImmutable: true }, sponsorship(0, 0));
    expect(res).toMatchObject({ mergeable: false, reason: "AUTH_IMMUTABLE" });
  });

  it("is mergeable with no sponsorships", () => {
    expect(computeMergeability(noFlags, sponsorship(0, 0))).toEqual({ mergeable: true });
  });

  it("is mergeable when every sponsorship is self-sponsored (coverable)", () => {
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

describe("computeCoverableSponsorships", () => {
  const selfBalance: AuditBalance = {
    asset: { kind: "credit", code: "USDC", issuer: OTHER },
    amount: "1",
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    sponsor: ACC,
  };
  const foreignBalance: AuditBalance = { ...selfBalance, sponsor: OTHER };
  const selfOffer: OfferEntry = {
    id: "1",
    selling: { kind: "native" },
    buying: { kind: "credit", code: "USDC", issuer: OTHER },
    amount: "1",
    priceR: { n: 1, d: 1 },
    sponsor: ACC,
  };
  const selfSigner: AuditSigner = {
    key: OTHER,
    type: "ed25519_public_key",
    weight: 1,
    sponsor: ACC,
  };
  function cb(sponsor: string, claimableNow: boolean): ClaimableBalanceEntry {
    return {
      id: `cb-${sponsor}-${String(claimableNow)}`,
      asset: { kind: "native" },
      amount: "1",
      sponsor,
      predicate: {},
      claimants: [ACC],
      claimableNow,
    };
  }

  const dataEntry: DataEntry = { name: "config", value: "dmFsdWU=" };

  it("counts self-sponsored balances, offers, signers, and claimable CBs", () => {
    const n = computeCoverableSponsorships(ACC, {
      balances: [selfBalance],
      offers: [selfOffer],
      signers: [selfSigner],
      claimableBalances: [cb(ACC, true)],
      data: [],
    });
    expect(n).toBe(4);
  });

  it("ignores foreign-sponsored entries", () => {
    const n = computeCoverableSponsorships(ACC, {
      balances: [foreignBalance],
      offers: [],
      signers: [],
      claimableBalances: [cb(OTHER, true)],
      data: [],
    });
    expect(n).toBe(0);
  });

  it("does not count a self-sponsored CB that is not claimable now", () => {
    const n = computeCoverableSponsorships(ACC, {
      balances: [],
      offers: [],
      signers: [],
      claimableBalances: [cb(ACC, false), cb(ACC, true)],
      data: [],
    });
    expect(n).toBe(1);
  });

  // the demolition deletes every data entry on close, releasing any
  // self-sponsorship they carry, so each data entry must count as coverable ,
  // otherwise a self-sponsored data entry produces a false IS_SPONSOR block on
  // an account the demolition can fully close.
  it("counts the account's own data entries as coverable", () => {
    const n = computeCoverableSponsorships(ACC, {
      balances: [],
      offers: [],
      signers: [],
      claimableBalances: [],
      data: [dataEntry, { name: "other", value: "eA==" }],
    });
    expect(n).toBe(2);
  });

  it("data entries prevent a false IS_SPONSOR block on a self-sponsored data entry", () => {
    // account self-sponsors exactly one data entry: num_sponsoring counts it,
    // so coverable must too, else foreign = 1 > 0 falsely blocks the merge.
    const coverable = computeCoverableSponsorships(ACC, {
      balances: [],
      offers: [],
      signers: [],
      claimableBalances: [],
      data: [dataEntry],
    });
    const clamped = Math.min(coverable, 1);
    const res = computeMergeability(noFlags, sponsorship(1, clamped));
    expect(res).toEqual({ mergeable: true });
  });
});
