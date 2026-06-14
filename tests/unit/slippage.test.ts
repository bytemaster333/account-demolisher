import { describe, it, expect } from "vitest";
import {
  applySlippageMin,
  BPS_DENOMINATOR,
  clampSlippage,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  SlippageGuardTripped,
} from "@/lib/safety/slippage";

// central slippage policy: converts an expected output + a bps tolerance into
// a minimum-acceptable output via integer-floor BigInt math, and guards the
// bps value against an allowed range. these tests lock in the exact arithmetic
// (including flooring) and every validation throw.

describe("policy constants", () => {
  it("exposes the expected defaults and range", () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(100); // 1%
    expect(MIN_SLIPPAGE_BPS).toBe(10);
    expect(MAX_SLIPPAGE_BPS).toBe(500);
    expect(BPS_DENOMINATOR).toBe(10_000);
    expect(DEFAULT_SLIPPAGE_BPS).toBeGreaterThanOrEqual(MIN_SLIPPAGE_BPS);
    expect(DEFAULT_SLIPPAGE_BPS).toBeLessThanOrEqual(MAX_SLIPPAGE_BPS);
  });
});

describe("clampSlippage", () => {
  it("returns in-range integer bps unchanged", () => {
    expect(clampSlippage(MIN_SLIPPAGE_BPS)).toBe(MIN_SLIPPAGE_BPS);
    expect(clampSlippage(DEFAULT_SLIPPAGE_BPS)).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(clampSlippage(MAX_SLIPPAGE_BPS)).toBe(MAX_SLIPPAGE_BPS);
  });

  it("accepts the exact boundaries (inclusive range)", () => {
    expect(clampSlippage(10)).toBe(10);
    expect(clampSlippage(500)).toBe(500);
  });

  it("THROWS (does not clamp) just below the minimum", () => {
    // despite the name, this function rejects rather than saturating.
    expect(() => clampSlippage(MIN_SLIPPAGE_BPS - 1)).toThrow(RangeError);
  });

  it("THROWS (does not clamp) just above the maximum", () => {
    expect(() => clampSlippage(MAX_SLIPPAGE_BPS + 1)).toThrow(RangeError);
  });

  it("rejects non-finite values", () => {
    expect(() => clampSlippage(Number.NaN)).toThrow(RangeError);
    expect(() => clampSlippage(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("rejects non-integer values", () => {
    expect(() => clampSlippage(100.5)).toThrow(/integer/);
  });
});

describe("applySlippageMin", () => {
  it("computes floor(expected * (10000 - bps) / 10000) at the default 1%", () => {
    // 1000 * 9900 / 10000 = 990 exactly
    expect(applySlippageMin("1000", DEFAULT_SLIPPAGE_BPS)).toBe("990");
  });

  it("floors (truncates toward zero), never rounds up", () => {
    // 1001 * 9900 / 10000 = 990.99 -> 990
    expect(applySlippageMin("1001", 100)).toBe("990");
    // 12345 * 9950 / 10000 = 12283.275 -> 12283 (50 bps)
    expect(applySlippageMin("12345", 50)).toBe("12283");
  });

  it("returns the full amount at the minimum tolerance boundary", () => {
    // 10 bps of 100000 = 100 haircut
    expect(applySlippageMin("100000", MIN_SLIPPAGE_BPS)).toBe("99900");
  });

  it("applies the largest allowed haircut at the maximum tolerance", () => {
    // 500 bps = 5%: 100000 * 9500 / 10000 = 95000
    expect(applySlippageMin("100000", MAX_SLIPPAGE_BPS)).toBe("95000");
  });

  it("handles zero expected amount", () => {
    expect(applySlippageMin("0", DEFAULT_SLIPPAGE_BPS)).toBe("0");
  });

  it("handles very large amounts without precision loss (BigInt)", () => {
    // 10^30, 1% haircut -> 9.9 * 10^29, exact
    const big = "1" + "0".repeat(30);
    expect(applySlippageMin(big, 100)).toBe("99" + "0".repeat(28));
  });

  it("validates the bps argument via clampSlippage (out-of-range throws)", () => {
    expect(() => applySlippageMin("1000", MAX_SLIPPAGE_BPS + 1)).toThrow(RangeError);
    expect(() => applySlippageMin("1000", 0)).toThrow(RangeError);
  });

  it("rejects a non-integer-string expected amount", () => {
    expect(() => applySlippageMin("100.5", 100)).toThrow(TypeError);
    expect(() => applySlippageMin("-100", 100)).toThrow(TypeError);
    expect(() => applySlippageMin("1e6", 100)).toThrow(TypeError);
    expect(() => applySlippageMin("", 100)).toThrow(TypeError);
    expect(() => applySlippageMin("0x10", 100)).toThrow(TypeError);
  });

  it("checks bps validity before the amount format (bad bps wins)", () => {
    // amount is also invalid, but clampSlippage runs first -> RangeError.
    expect(() => applySlippageMin("not-a-number", 9999)).toThrow(RangeError);
  });
});

describe("SlippageGuardTripped", () => {
  it("is an Error subclass carrying the structured fields", () => {
    const err = new SlippageGuardTripped({
      expected: "1000",
      minimumAccepted: "990",
      actual: "980",
      slippageBps: 100,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SlippageGuardTripped");
    expect(err.expected).toBe("1000");
    expect(err.minimumAccepted).toBe("990");
    expect(err.actual).toBe("980");
    expect(err.slippageBps).toBe(100);
  });

  it("renders a message referencing the actual, minimum, expected and bps", () => {
    const err = new SlippageGuardTripped({
      expected: "1000",
      minimumAccepted: "990",
      actual: "980",
      slippageBps: 100,
    });
    expect(err.message).toContain("980");
    expect(err.message).toContain("990");
    expect(err.message).toContain("1000");
    expect(err.message).toContain("100 bps");
  });
});
