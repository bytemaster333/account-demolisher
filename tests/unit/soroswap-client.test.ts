import { describe, it, expect, vi } from "vitest";
import { SoroswapHttpClient, SoroswapProxyError } from "@/lib/adapters/soroswap/client";
import type { ClientQuoteRequest } from "@/lib/adapters/soroswap/client";

// The proxy JSON path casts the response to the SDK's QuoteResponse, whose amountOut /
// otherAmountThreshold are typed as `bigint` but on the wire arrive as string|number.
// The downstream slippage guard (aggregator.ts) does quote.amountOut.toString() and
// BigInt(quote.otherAmountThreshold.toString()) — so a silently-rounded JSON Number would
// feed wrong digits into the guard. quote() must reject values that aren't faithful
// non-negative integers rather than trusting corrupted digits.

const BASE_QUOTE_REQUEST: ClientQuoteRequest = {
  assetIn: "AIN",
  assetOut: "AOUT",
  amount: 1000n,
  tradeType: "EXACT_IN",
  protocols: ["soroswap"],
};

// build a fetch stub that returns `bodyObj` serialized as the given raw text (so we can
// inject values JSON.parse would have already rounded, e.g. bare numbers past 2^53)
function fetchReturning(rawText: string): typeof fetch {
  return vi.fn(async () =>
    new Response(rawText, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function clientWith(rawText: string): SoroswapHttpClient {
  return new SoroswapHttpClient({ fetchImpl: fetchReturning(rawText) });
}

describe("SoroswapHttpClient.quote precision validation", () => {
  it("passes a well-formed integer-string quote through unchanged", async () => {
    const raw = JSON.stringify({
      amountOut: "12345",
      otherAmountThreshold: "12000",
      tradeType: "EXACT_IN",
    });
    const client = clientWith(raw);
    const quote = await client.quote(BASE_QUOTE_REQUEST);
    // fields preserved verbatim (string form is faithful)
    expect((quote as unknown as Record<string, unknown>)["amountOut"]).toBe("12345");
    expect((quote as unknown as Record<string, unknown>)["otherAmountThreshold"]).toBe("12000");
  });

  it("accepts safe-integer JSON numbers", async () => {
    const raw = JSON.stringify({
      amountOut: 12345,
      otherAmountThreshold: 12000,
      tradeType: "EXACT_IN",
    });
    const client = clientWith(raw);
    await expect(client.quote(BASE_QUOTE_REQUEST)).resolves.toBeDefined();
  });

  it("rejects an amountOut JSON number that has lost integer precision (> 2^53)", async () => {
    // 9007199254740993 (2^53 + 1) is not representable; JSON.parse rounds it to 2^53.
    // Without the guard this silently-corrupted value would flow into the slippage check.
    const raw = '{"amountOut":9007199254740993,"otherAmountThreshold":"12000","tradeType":"EXACT_IN"}';
    const client = clientWith(raw);
    await expect(client.quote(BASE_QUOTE_REQUEST)).rejects.toBeInstanceOf(SoroswapProxyError);
    await expect(client.quote(BASE_QUOTE_REQUEST)).rejects.toThrow(/amountOut/);
  });

  it("rejects an otherAmountThreshold in exponential form", async () => {
    const raw = '{"amountOut":"12345","otherAmountThreshold":1.5e+21,"tradeType":"EXACT_IN"}';
    const client = clientWith(raw);
    await expect(client.quote(BASE_QUOTE_REQUEST)).rejects.toBeInstanceOf(SoroswapProxyError);
    await expect(client.quote(BASE_QUOTE_REQUEST)).rejects.toThrow(/otherAmountThreshold/);
  });

  it("rejects a fractional / non-integer string amount", async () => {
    const raw = JSON.stringify({
      amountOut: "123.45",
      otherAmountThreshold: "12000",
      tradeType: "EXACT_IN",
    });
    const client = clientWith(raw);
    await expect(client.quote(BASE_QUOTE_REQUEST)).rejects.toThrow(/amountOut/);
  });

  it("rejects a negative amount", async () => {
    const raw = JSON.stringify({
      amountOut: "12345",
      otherAmountThreshold: -1,
      tradeType: "EXACT_IN",
    });
    const client = clientWith(raw);
    await expect(client.quote(BASE_QUOTE_REQUEST)).rejects.toThrow(/otherAmountThreshold/);
  });

  it("rejects a missing amountOut field", async () => {
    const raw = JSON.stringify({ otherAmountThreshold: "12000", tradeType: "EXACT_IN" });
    const client = clientWith(raw);
    await expect(client.quote(BASE_QUOTE_REQUEST)).rejects.toThrow(/amountOut/);
  });
});
