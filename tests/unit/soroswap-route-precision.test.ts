import { describe, it, expect, vi } from "vitest";

// the route imports @/server/server-env, which is `server-only`; stub the guard
vi.mock("server-only", () => ({}));

import { preserveAmountPrecision } from "@/app/api/soroswap/route";

// The Soroswap proxy must not let a >2^53 stroop amount round to a lossy Number.
// preserveAmountPrecision quotes the amount fields in the raw upstream text
// BEFORE JSON.parse so they survive as exact integer strings.

const BIG = "123456789012345678"; // 1.2e17 — larger than Number.MAX_SAFE_INTEGER

describe("preserveAmountPrecision", () => {
  it("quotes an unquoted big amountOut so JSON.parse keeps every digit", () => {
    const raw = `{"amountOut":${BIG},"otherAmountThreshold":${BIG}}`;
    const parsed = JSON.parse(preserveAmountPrecision(raw)) as Record<string, unknown>;
    expect(parsed.amountOut).toBe(BIG);
    expect(parsed.otherAmountThreshold).toBe(BIG);
  });

  it("demonstrates the bug it prevents: a plain parse would corrupt the value", () => {
    const naive = JSON.parse(`{"amountOut":${BIG}}`) as { amountOut: number };
    // the naive parse loses precision; the preserved string does not
    expect(String(naive.amountOut)).not.toBe(BIG);
    const fixed = JSON.parse(preserveAmountPrecision(`{"amountOut":${BIG}}`)) as {
      amountOut: string;
    };
    expect(fixed.amountOut).toBe(BIG);
  });

  it("leaves already-quoted string amounts untouched", () => {
    const raw = `{"amountOut":"${BIG}"}`;
    expect(preserveAmountPrecision(raw)).toBe(raw);
  });

  it("only touches known amount fields, not unrelated numbers", () => {
    const raw = `{"amountOut":${BIG},"priceImpact":1234,"gasEstimate":9999}`;
    const out = preserveAmountPrecision(raw);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.amountOut).toBe(BIG);
    expect(parsed.priceImpact).toBe(1234);
    expect(parsed.gasEstimate).toBe(9999);
  });

  it("handles whitespace and trailing-brace/comma boundaries", () => {
    const raw = `{ "amountIn" : ${BIG} , "amountOut": ${BIG} }`;
    const parsed = JSON.parse(preserveAmountPrecision(raw)) as Record<string, unknown>;
    expect(parsed.amountIn).toBe(BIG);
    expect(parsed.amountOut).toBe(BIG);
  });
});
