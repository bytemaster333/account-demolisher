import { describe, it, expect } from "vitest";

import {
  HIGH_VALUE_THRESHOLD_XLM,
  isHighValueTotalXlm,
  requiredAcknowledgements,
  allAcknowledged,
} from "@/lib/safety/high-value";

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
