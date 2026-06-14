import { describe, it, expect } from "vitest";
import {
  applyFeeCap,
  defaultAdvice,
  feeAdviceFromStats,
  type FeeAdvice,
  type FeeStatsLike,
} from "@/lib/safety/fee-surge";

// fee-surge protection derives a recommended + max per-op fee from horizon's
// /fee_stats, and detects surge conditions. all math is BigInt over stroops.
// constants baked into the module (mirrored here for readability):
//   BASE_FEE = 100, MIN_FEE_CAP x100, P99_CAP x2, SURGE x10, RECOMMENDED x5
// cap formula: max = max(minFee*100, p99*2)
// surge:       p99 > minFee*10
// recommended: max(mode ?? ledgerBase*5, ledgerBase)

describe("defaultAdvice", () => {
  it("is the conservative fallback: recommended 500, max 10000, no surge", () => {
    expect(defaultAdvice()).toEqual({ recommended: "500", max: "10000", surge: false });
  });
});

describe("feeAdviceFromStats — missing / empty input", () => {
  it("falls back to defaultAdvice for null and undefined", () => {
    expect(feeAdviceFromStats(null)).toEqual(defaultAdvice());
    expect(feeAdviceFromStats(undefined)).toEqual(defaultAdvice());
  });

  it("uses BASE_FEE-derived defaults when the object is empty", () => {
    // ledgerBase -> 100, minFee -> 100, p99 -> 100, mode absent.
    // max = max(100*100, 100*2) = 10000; recommended = max(100*5, 100) = 500.
    expect(feeAdviceFromStats({})).toEqual({ recommended: "500", max: "10000", surge: false });
  });
});

describe("feeAdviceFromStats — cap formula max(minFee*100, p99*2)", () => {
  it("picks minFee*100 when it dominates (normal network)", () => {
    const stats: FeeStatsLike = {
      last_ledger_base_fee: "100",
      fee_charged: { min: "100", p99: "150" },
    };
    // capFromMin = 10000, capFromP99 = 300 -> 10000
    expect(feeAdviceFromStats(stats).max).toBe("10000");
  });

  it("picks p99*2 when the p99 tail dominates (surge)", () => {
    const stats: FeeStatsLike = {
      last_ledger_base_fee: "100",
      fee_charged: { min: "100", p99: "6000" },
    };
    // capFromMin = 10000, capFromP99 = 12000 -> 12000
    expect(feeAdviceFromStats(stats).max).toBe("12000");
  });

  it("defaults p99 to minFee when p99 is absent", () => {
    const stats: FeeStatsLike = { fee_charged: { min: "200" } };
    // p99 -> 200; capFromMin = 20000, capFromP99 = 400 -> 20000
    expect(feeAdviceFromStats(stats).max).toBe("20000");
  });

  it("defaults minFee to the ledger base when min is absent", () => {
    const stats: FeeStatsLike = { last_ledger_base_fee: "250", fee_charged: { p99: "300" } };
    // minFee -> 250; capFromMin = 25000, capFromP99 = 600 -> 25000
    expect(feeAdviceFromStats(stats).max).toBe("25000");
  });
});

describe("feeAdviceFromStats — surge detection (p99 > minFee*10, strict)", () => {
  it("is not a surge when p99 == minFee*10 (boundary, exclusive)", () => {
    const stats: FeeStatsLike = { fee_charged: { min: "100", p99: "1000" } };
    expect(feeAdviceFromStats(stats).surge).toBe(false);
  });

  it("is a surge one stroop past the boundary", () => {
    const stats: FeeStatsLike = { fee_charged: { min: "100", p99: "1001" } };
    expect(feeAdviceFromStats(stats).surge).toBe(true);
  });

  it("is not a surge on a calm network", () => {
    const stats: FeeStatsLike = { fee_charged: { min: "100", p99: "150" } };
    expect(feeAdviceFromStats(stats).surge).toBe(false);
  });
});

describe("feeAdviceFromStats — recommended fee", () => {
  it("prefers the mode when present", () => {
    const stats: FeeStatsLike = {
      last_ledger_base_fee: "100",
      fee_charged: { min: "100", mode: "350", p99: "400" },
    };
    expect(feeAdviceFromStats(stats).recommended).toBe("350");
  });

  it("uses ledgerBase*5 when the mode is absent", () => {
    const stats: FeeStatsLike = { last_ledger_base_fee: "200", fee_charged: { min: "200" } };
    // recommended = max(200*5, 200) = 1000
    expect(feeAdviceFromStats(stats).recommended).toBe("1000");
  });

  it("floors the recommendation at the ledger base (never undercuts it)", () => {
    // mode below ledgerBase must be lifted up to ledgerBase.
    const stats: FeeStatsLike = {
      last_ledger_base_fee: "1000",
      fee_charged: { min: "1000", mode: "300", p99: "1000" },
    };
    expect(feeAdviceFromStats(stats).recommended).toBe("1000");
  });
});

describe("feeAdviceFromStats — malformed numeric fields", () => {
  it("ignores non-positive / non-numeric strings and falls back per field", () => {
    const stats: FeeStatsLike = {
      last_ledger_base_fee: "0", // -> null -> BASE_FEE 100
      fee_charged: { min: "-5", p99: "abc", mode: "" },
    };
    // ledgerBase -> 100, minFee -> 100, p99 -> 100, mode -> null
    expect(feeAdviceFromStats(stats)).toEqual({
      recommended: "500",
      max: "10000",
      surge: false,
    });
  });

  it("trims surrounding whitespace on numeric strings", () => {
    const stats: FeeStatsLike = { fee_charged: { min: " 100 ", p99: " 6000 " } };
    expect(feeAdviceFromStats(stats).max).toBe("12000");
  });

  it("rejects non-integer numeric strings (only whole stroops allowed)", () => {
    const stats: FeeStatsLike = { last_ledger_base_fee: "100.5", fee_charged: { min: "100.5" } };
    // both parse to null -> ledgerBase 100, minFee 100 -> max 10000
    expect(feeAdviceFromStats(stats).max).toBe("10000");
  });
});

describe("applyFeeCap", () => {
  const advice: FeeAdvice = { recommended: "500", max: "10000", surge: false };

  it("passes through a proposal at or below the max", () => {
    expect(applyFeeCap("500", advice)).toBe("500");
    expect(applyFeeCap("10000", advice)).toBe("10000");
    expect(applyFeeCap("1", advice)).toBe("1");
  });

  it("caps a proposal above the max down to the max", () => {
    expect(applyFeeCap("99999", advice)).toBe("10000");
  });

  it("coerces a malformed proposal to advice.recommended (not passthrough)", () => {
    expect(applyFeeCap("not-a-number", advice)).toBe("500");
    expect(applyFeeCap("0", advice)).toBe("500"); // 0 is not positive
    expect(applyFeeCap("-100", advice)).toBe("500");
    expect(applyFeeCap("", advice)).toBe("500");
  });

  it("falls back to BASE_FEE*100 (10000) as the cap when advice.max is malformed", () => {
    const badAdvice: FeeAdvice = { recommended: "500", max: "garbage", surge: false };
    // proposal 20000 > fallback max 10000 -> capped to 10000
    expect(applyFeeCap("20000", badAdvice)).toBe("10000");
    // proposal 900 <= fallback max -> passthrough
    expect(applyFeeCap("900", badAdvice)).toBe("900");
  });
});
