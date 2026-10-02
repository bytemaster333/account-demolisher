import { describe, it, expect, afterEach } from "vitest";
import {
  applySlippageMin,
  BPS_DENOMINATOR,
  clampSlippage,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  isMarketSellAcceptable,
  parseMinMarketOutEnv,
  parseSlippageBpsEnv,
  resolveConfiguredSlippageBps,
  resolveMinMarketOutStroops,
  SlippageConfigError,
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

describe("resolveConfiguredSlippageBps — single configurable policy", () => {
  const KEY = "NEXT_PUBLIC_SLIPPAGE_BPS";
  const orig = process.env[KEY];
  afterEach(() => {
    if (orig === undefined) delete process.env[KEY];
    else process.env[KEY] = orig;
  });

  it("defaults to DEFAULT_SLIPPAGE_BPS when unset or blank", () => {
    delete process.env[KEY];
    expect(resolveConfiguredSlippageBps()).toBe(DEFAULT_SLIPPAGE_BPS);
    process.env[KEY] = "   ";
    expect(resolveConfiguredSlippageBps()).toBe(DEFAULT_SLIPPAGE_BPS);
  });

  it("honors a valid in-range integer override", () => {
    process.env[KEY] = "250";
    expect(resolveConfiguredSlippageBps()).toBe(250);
  });

  // a set but unusable value is an operator mistake on a money path; silently
  // using the default would hide it
  it("throws a config error on out-of-range / non-integer / garbage values", () => {
    for (const bad of ["1000", "9999", "5", "1.5", "abc", "-100", "1e2"]) {
      process.env[KEY] = bad;
      expect(() => resolveConfiguredSlippageBps()).toThrow(SlippageConfigError);
      expect(() => resolveConfiguredSlippageBps()).toThrow(KEY);
    }
  });
});

describe("env parsers for the build-time schema", () => {
  it("parses NEXT_PUBLIC_SLIPPAGE_BPS", () => {
    expect(parseSlippageBpsEnv(undefined)).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(parseSlippageBpsEnv("")).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(parseSlippageBpsEnv(" 250 ")).toBe(250);
    expect(() => parseSlippageBpsEnv("501")).toThrow(SlippageConfigError);
  });

  it("parses NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS", () => {
    expect(parseMinMarketOutEnv(undefined)).toBe(0n);
    expect(parseMinMarketOutEnv("20000000")).toBe(20_000_000n);
    expect(() => parseMinMarketOutEnv("2.5")).toThrow(SlippageConfigError);
  });
});

describe("value-destroying-sell floor (isMarketSellAcceptable / resolveMinMarketOutStroops)", () => {
  const KEY = "NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS";
  const orig = process.env[KEY];
  afterEach(() => {
    if (orig === undefined) delete process.env[KEY];
    else process.env[KEY] = orig;
  });

  it("defaults the absolute floor to 0 (only a net-nothing sell is refused)", () => {
    delete process.env[KEY];
    expect(resolveMinMarketOutStroops()).toBe(0n);
    process.env[KEY] = "5000";
    expect(resolveMinMarketOutStroops()).toBe(5000n);
  });

  it("throws a config error on a malformed floor instead of using 0", () => {
    for (const bad of ["-1", "garbage", "1.5"]) {
      process.env[KEY] = bad;
      expect(() => resolveMinMarketOutStroops()).toThrow(SlippageConfigError);
    }
  });

  it("refuses a sell that nets nothing after the haircut (dust)", () => {
    // 1 stroop out -> applySlippageMin(1, 100) == 0 -> value-destroying
    expect(isMarketSellAcceptable(1n, DEFAULT_SLIPPAGE_BPS, 0n)).toBe(false);
    expect(isMarketSellAcceptable(0n, DEFAULT_SLIPPAGE_BPS, 0n)).toBe(false);
  });

  it("accepts a sell whose slippage-adjusted output clears the floor", () => {
    // 100000 out @1% -> minAccepted 99000 > 0
    expect(isMarketSellAcceptable(100_000n, DEFAULT_SLIPPAGE_BPS, 0n)).toBe(true);
  });

  it("refuses below a configured absolute floor and accepts above it", () => {
    // minAccepted(100000 @1%) = 99000
    expect(isMarketSellAcceptable(100_000n, DEFAULT_SLIPPAGE_BPS, 100_000n)).toBe(false);
    expect(isMarketSellAcceptable(100_000n, DEFAULT_SLIPPAGE_BPS, 50_000n)).toBe(true);
  });
});
