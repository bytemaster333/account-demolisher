import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const env = vi.fn();
vi.mock("@/server/server-env", () => ({
  getServerEnv: () => env(),
  requireServerEnv: (k: string) => {
    const v = (env() as Record<string, string | undefined>)[k];
    if (v === undefined) throw new Error(`Required server environment variable "${k}" is not set.`);
    return v;
  },
}));

const upstream = vi.fn();
vi.mock("undici", () => ({
  Agent: class {},
  fetch: (...a: unknown[]) => upstream(...a),
}));

import {
  POST,
  UPSTREAM_MAX_BODY_BYTES,
  UPSTREAM_TIMEOUT_MS,
  __resetRateLimiterForTests,
} from "@/app/api/soroswap/route";

const ORIGIN = "https://demolisher.example";

function post(body: unknown, origin: string | null = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/soroswap`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin !== null ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

const quote = { op: "quote", payload: { network: "testnet", assetIn: "A", assetOut: "B" } };

beforeEach(() => {
  __resetRateLimiterForTests();
  env.mockReturnValue({ SOROSWAP_API_URL: "https://api.soroswap.test", SOROSWAP_API_KEY: "k3y" });
  upstream.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("soroswap proxy route", () => {
  it("rejects a localhost origin in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await POST(post(quote, "http://localhost:3000"));
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("still accepts the local dev origins outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    upstream.mockResolvedValue(new Response("{}", { status: 200 }));
    const res = await POST(post(quote, "http://localhost:3000"));
    expect(res.status).toBe(200);
  });

  it("does not echo server configuration errors to the client", async () => {
    env.mockImplementation(() => {
      throw new Error("Invalid server environment configuration: MEDIATOR_SECRET too short");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(post(quote));
    const body = (await res.json()) as { reason: string };
    expect(res.status).toBe(500);
    expect(body.reason).toBe("Soroswap is not configured.");
    expect(JSON.stringify(body)).not.toMatch(/MEDIATOR_SECRET/);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("no longer relays send or getProtocols", async () => {
    for (const op of ["send", "getProtocols"]) {
      const res = await POST(post({ op, payload: { xdr: "AAAA", network: "testnet" } }));
      expect(res.status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("gives up on an upstream that never answers", async () => {
    upstream.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    vi.useFakeTimers();
    const pending = POST(post(quote));
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 10);
    const res = await pending;
    expect(res.status).toBe(504);
  });

  it("refuses an upstream body over the size cap", async () => {
    const big = new Uint8Array(UPSTREAM_MAX_BODY_BYTES + 1).fill(0x20);
    upstream.mockResolvedValue(new Response(big, { status: 200 }));
    const res = await POST(post(quote));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("UPSTREAM_TOO_LARGE");
  });

  it("forwards every large integer in a quote unchanged, including amountOutMin", async () => {
    const raw =
      '{"amountIn":"1000","amountOut":123456789012345678901,"otherAmountThreshold":98765432109876543210,' +
      '"rawTrade":{"amountIn":1000,"amountOutMin":123456789012345678901,"amountInMax":99999999999999999999,' +
      '"distribution":[{"parts":10}]},"platformFee":{"feeAmount":11111111111111111111}}';
    upstream.mockResolvedValue(new Response(raw, { status: 200 }));
    const res = await POST(post(quote));
    const text = await res.text();
    expect(text).toContain('"amountOutMin":"123456789012345678901"');
    expect(text).toContain('"amountInMax":"99999999999999999999"');
    expect(text).toContain('"feeAmount":"11111111111111111111"');
    expect(text).toContain('"amountOut":"123456789012345678901"');
    // safe integers stay numbers
    expect(text).toContain('"parts":10');
  });
});
