import { describe, it, expect } from "vitest";

import {
  HIGH_VALUE_THRESHOLD_XLM,
  assessCloseValue,
  isHighValueTotalXlm,
  requiredAcknowledgements,
  allAcknowledged,
} from "@/lib/safety/high-value";
import type { AccountAudit, AuditBalance, ClaimableBalanceEntry } from "@/lib/types/account";

// The high-value safety gate: an account over the threshold must add a required
// acknowledgement, and the acknowledge step can't continue until it's ticked.
// These lock in that the gate FIRES at the threshold and that it gates proceeding.
describe("high-value gate — trigger", () => {
  it("fires strictly above the threshold, not at or below it", () => {
    expect(isHighValueTotalXlm(String(HIGH_VALUE_THRESHOLD_XLM + 1))).toBe(true);
    expect(isHighValueTotalXlm("50000.5")).toBe(true);
    expect(isHighValueTotalXlm(String(HIGH_VALUE_THRESHOLD_XLM))).toBe(false);
    expect(isHighValueTotalXlm("10")).toBe(false);
    expect(isHighValueTotalXlm("0")).toBe(false);
    expect(isHighValueTotalXlm("not-a-number")).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(isHighValueTotalXlm("150", 100)).toBe(true);
    expect(isHighValueTotalXlm("150", 200)).toBe(false);
  });
});

describe("high-value gate — required acknowledgement blocks proceeding", () => {
  const noFlags = {
    hasScam: false,
    hasDiscovery: false,
    hasAutoHandled: false,
    hasHighValue: false,
  };

  it("adds a 'highValue' acknowledgement when the account is high-value", () => {
    const required = requiredAcknowledgements({ ...noFlags, hasHighValue: true });
    expect(required).toContain("highValue");
  });

  it("cannot proceed until the high-value box is ticked", () => {
    const required = requiredAcknowledgements({ ...noFlags, hasHighValue: true });
    expect(allAcknowledged(required, {})).toBe(false); // gate fired, unticked
    expect(allAcknowledged(required, { highValue: false })).toBe(false);
    expect(allAcknowledged(required, { highValue: true })).toBe(true); // acknowledged
  });

  it("requires EVERY present acknowledgement, not just high-value", () => {
    const required = requiredAcknowledgements({
      hasScam: true,
      hasDiscovery: false,
      hasAutoHandled: false,
      hasHighValue: true,
    });
    expect(new Set(required)).toEqual(new Set(["scam", "highValue"]));
    expect(allAcknowledged(required, { highValue: true })).toBe(false); // scam still unticked
    expect(allAcknowledged(required, { highValue: true, scam: true })).toBe(true);
  });

  it("does not gate when nothing advisory is present", () => {
    const required = requiredAcknowledgements(noFlags);
    expect(required).toEqual([]);
    expect(allAcknowledged(required, {})).toBe(true);
  });
});

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ACC = "GACCOUNT";

function line(asset: AuditBalance["asset"], amount: string): AuditBalance {
  return { asset, amount, buyingLiabilities: "0", sellingLiabilities: "0" };
}

function auditWith(
  balances: readonly AuditBalance[],
  claimableBalances: readonly ClaimableBalanceEntry[] = [],
): AccountAudit {
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
    balances,
    signers: [],
    offers: [],
    data: [],
    claimableBalances,
    poolShares: [],
    sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
    requiresMultisig: false,
    mergeability: { mergeable: true },
  };
}

const usdc = { kind: "credit" as const, code: "USDC", issuer: ISSUER };

// the gate used to read only the native balance, so 20 XLM next to 50,000 USDC
// and a Blend supply closed with no extra acknowledgement
describe("assessCloseValue", () => {
  it("counts path-quoted credit balances toward the total", () => {
    const audit = auditWith([line({ kind: "native" }, "20"), line(usdc, "50000")]);
    const quotes = new Map([[`USDC:${ISSUER}`, { destinationAmount: "180000.0000000" }]]);
    const value = assessCloseValue({ audit, creditQuotes: quotes, unpricedPositions: 0 });
    expect(value.estimatedXlm).toBe("180020.0000000");
    expect(value.unpricedHoldings).toBe(0);
    expect(value.highValue).toBe(true);
  });

  it("stays below the gate for a small, fully priced account", () => {
    const audit = auditWith([line({ kind: "native" }, "20"), line(usdc, "1")]);
    const quotes = new Map([[`USDC:${ISSUER}`, { destinationAmount: "3.5" }]]);
    const value = assessCloseValue({ audit, creditQuotes: quotes, unpricedPositions: 0 });
    expect(value).toEqual({ estimatedXlm: "23.5000000", unpricedHoldings: 0, highValue: false });
  });

  it("triggers on a DeFi position whose value is not estimated", () => {
    const audit = auditWith([line({ kind: "native" }, "20")]);
    const value = assessCloseValue({ audit, creditQuotes: new Map(), unpricedPositions: 1 });
    expect(value.unpricedHoldings).toBe(1);
    expect(value.highValue).toBe(true);
  });

  it("triggers on a credit balance with no quote and on pool shares", () => {
    const audit = auditWith([
      line({ kind: "native" }, "20"),
      line(usdc, "5"),
      line({ kind: "liquidity_pool_shares", poolId: "ab".repeat(32) }, "10"),
    ]);
    const value = assessCloseValue({ audit, creditQuotes: new Map(), unpricedPositions: 0 });
    expect(value.unpricedHoldings).toBe(2);
    expect(value.highValue).toBe(true);
  });

  it("adds selected claimable XLM and treats selected non-native claims as unpriced", () => {
    const cb = (id: string, asset: ClaimableBalanceEntry["asset"], amount: string) =>
      ({
        id,
        asset,
        amount,
        sponsor: "GSPONSOR",
        predicate: {},
        claimants: [ACC],
        claimableNow: true,
      }) satisfies ClaimableBalanceEntry;
    const audit = auditWith(
      [line({ kind: "native" }, "20")],
      [cb("xlm", { kind: "native" }, "2000"), cb("usd", usdc, "5")],
    );
    const all = assessCloseValue({ audit, creditQuotes: new Map(), unpricedPositions: 0 });
    expect(all.estimatedXlm).toBe("2020.0000000");
    expect(all.unpricedHoldings).toBe(1);
    const none = assessCloseValue({
      audit,
      creditQuotes: new Map(),
      unpricedPositions: 0,
      claimableBalanceIds: [],
    });
    expect(none).toEqual({ estimatedXlm: "20.0000000", unpricedHoldings: 0, highValue: false });
  });

  it("ignores zero balances", () => {
    const audit = auditWith([line({ kind: "native" }, "20"), line(usdc, "0.0000000")]);
    const value = assessCloseValue({ audit, creditQuotes: new Map(), unpricedPositions: 0 });
    expect(value.unpricedHoldings).toBe(0);
  });
});
