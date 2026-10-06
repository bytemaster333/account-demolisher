import { describe, expect, it } from "vitest";

import { decimalToStroops, stroopsToDecimal } from "@/lib/stellar/amount";

describe("decimalToStroops", () => {
  it.each([
    ["0", 0n],
    ["1", 10_000_000n],
    ["0.0000001", 1n],
    ["12.3456789", 123_456_789n],
    ["100.5", 1_005_000_000n],
    ["922337203685.4775807", 9_223_372_036_854_775_807n],
    ["-2.5", -25_000_000n],
  ])("parses %s", (input, expected) => {
    expect(decimalToStroops(input)).toBe(expected);
  });

  it.each(["", " 1", "1 ", "1.", ".5", "1.23456789", "1e7", "abc", "+1", "1,5", "--1", "0x10"])(
    "throws on %j instead of truncating or reading zero",
    (input) => {
      expect(() => decimalToStroops(input)).toThrow(/malformed amount/);
    },
  );
});

describe("stroopsToDecimal", () => {
  it.each([
    [0n, "0.0000000"],
    [1n, "0.0000001"],
    [123_456_789n, "12.3456789"],
    [10_000_000n, "1.0000000"],
    [-25_000_000n, "-2.5000000"],
  ])("formats %s", (input, expected) => {
    expect(stroopsToDecimal(input)).toBe(expected);
  });

  it("round-trips through decimalToStroops", () => {
    for (const v of [0n, 1n, 9_999_999n, 10_000_001n, -7n, 9_223_372_036_854_775_807n]) {
      expect(decimalToStroops(stroopsToDecimal(v))).toBe(v);
    }
  });
});
