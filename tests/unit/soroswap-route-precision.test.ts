import { describe, it, expect, vi } from "vitest";

// the route imports @/server/server-env, which is `server-only`; stub the guard
vi.mock("server-only", () => ({}));

import { parseUpstreamJson } from "@/app/api/soroswap/route";

// The Soroswap proxy must not let a >2^53 stroop amount round to a lossy Number.
// parseUpstreamJson keeps any integer outside the safe range as its exact digits.

const BIG = "123456789012345678"; // 1.2e17, larger than Number.MAX_SAFE_INTEGER

describe("parseUpstreamJson", () => {
  it("keeps every digit of a big amountOut and otherAmountThreshold", () => {
    const parsed = parseUpstreamJson(
      `{"amountOut":${BIG},"otherAmountThreshold":${BIG}}`,
    ) as Record<string, unknown>;
    expect(parsed.amountOut).toBe(BIG);
    expect(parsed.otherAmountThreshold).toBe(BIG);
  });

  it("demonstrates the bug it prevents: a plain parse would corrupt the value", () => {
    const naive = JSON.parse(`{"amountOut":${BIG}}`) as { amountOut: number };
    expect(String(naive.amountOut)).not.toBe(BIG);
    expect((parseUpstreamJson(`{"amountOut":${BIG}}`) as { amountOut: string }).amountOut).toBe(
      BIG,
    );
  });

  it("covers nested rawTrade and fee fields, not a fixed list of names", () => {
    const parsed = parseUpstreamJson(
      `{"rawTrade":{"amountOutMin":${BIG},"amountInMax":-${BIG}},"platformFee":{"feeAmount":${BIG}}}`,
    ) as { rawTrade: Record<string, unknown>; platformFee: Record<string, unknown> };
    expect(parsed.rawTrade.amountOutMin).toBe(BIG);
    expect(parsed.rawTrade.amountInMax).toBe(`-${BIG}`);
    expect(parsed.platformFee.feeAmount).toBe(BIG);
  });

  it("leaves strings, safe integers and fractions as they are", () => {
    const parsed = parseUpstreamJson(
      `{"amountOut":"${BIG}","priceImpact":1234,"pct":"0.5","ratio":0.25,"s":"say \\"${BIG}\\""}`,
    ) as Record<string, unknown>;
    expect(parsed.amountOut).toBe(BIG);
    expect(parsed.priceImpact).toBe(1234);
    expect(parsed.ratio).toBe(0.25);
    expect(parsed.s).toBe(`say "${BIG}"`);
  });
});
