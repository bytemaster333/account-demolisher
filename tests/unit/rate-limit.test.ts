import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ClientIpUnavailableError,
  assertTrustedProxyConfig,
  canonicalClientKey,
  createLimiter,
  getRemoteIp,
  rateLimitByIp,
} from "@/server/rate-limit";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function req(headers: Record<string, string> = {}, url = "http://localhost:3000/api/x"): Request {
  return new Request(url, { headers });
}

describe("createLimiter", () => {
  it("allows up to capacity, then blocks within the window", () => {
    const limiter = createLimiter(3, 60_000);
    const now = 1_000_000;
    expect(limiter.take("ip", now)).toBe(true);
    expect(limiter.take("ip", now)).toBe(true);
    expect(limiter.take("ip", now)).toBe(true);
    expect(limiter.take("ip", now)).toBe(false);
  });

  it("refills over time", () => {
    const limiter = createLimiter(2, 60_000);
    const t0 = 1_000_000;
    expect(limiter.take("ip", t0)).toBe(true);
    expect(limiter.take("ip", t0)).toBe(true);
    expect(limiter.take("ip", t0)).toBe(false);
    // a full window later, the bucket is back to capacity
    expect(limiter.take("ip", t0 + 60_000)).toBe(true);
  });

  it("tracks buckets per key", () => {
    const limiter = createLimiter(1, 60_000);
    const now = 1_000_000;
    expect(limiter.take("a", now)).toBe(true);
    expect(limiter.take("a", now)).toBe(false);
    expect(limiter.take("b", now)).toBe(true);
  });

  it("admits a new key when 20,000 active keys fill the map, evicting the oldest", () => {
    const limiter = createLimiter(5, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 20_000; i++) expect(limiter.take(`k${i}`, t0)).toBe(true);
    // every key is still inside its window, so nothing has refilled
    expect(limiter.take("newcomer", t0 + 30_000)).toBe(true);
    expect(limiter.size()).toBe(20_000);
  });

  it("evicts the least recently used key, not a recently active one", () => {
    const limiter = createLimiter(2, 60_000, 3);
    const t0 = 1_000_000;
    limiter.take("a", t0);
    limiter.take("b", t0);
    limiter.take("c", t0);
    // touching a makes b the least recently used
    expect(limiter.take("a", t0 + 1)).toBe(true);
    expect(limiter.take("d", t0 + 2)).toBe(true);
    // a is exhausted and kept, so it stays limited
    expect(limiter.take("a", t0 + 3)).toBe(false);
    // b was evicted, so it starts over with a full bucket
    expect(limiter.take("b", t0 + 3)).toBe(true);
    expect(limiter.take("b", t0 + 3)).toBe(true);
  });

  it("reports how long until the next token", () => {
    const limiter = createLimiter(5, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.take("ip", t0);
    expect(limiter.take("ip", t0)).toBe(false);
    expect(limiter.retryAfterMs("ip", t0)).toBe(12_000);
    expect(limiter.retryAfterMs("unknown", t0)).toBe(0);
  });
});

describe("canonicalClientKey", () => {
  it("keeps a full IPv4 address", () => {
    expect(canonicalClientKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("keys IPv6 on the /64 prefix, so one subnet shares a bucket", () => {
    const a = canonicalClientKey("2001:db8::1");
    expect(a).toBe("2001:db8:0:0::/64");
    expect(canonicalClientKey("2001:0db8:0:0::1")).toBe(a);
    expect(canonicalClientKey("2001:db8:0:0:ffff:1:2:3")).toBe(a);
    expect(canonicalClientKey("[2001:db8::99]:443")).toBe(a);
    expect(canonicalClientKey("2001:DB8::abcd%eth0")).toBe(a);
    expect(canonicalClientKey("2001:db8:0:1::1")).not.toBe(a);
  });

  it("maps IPv4-mapped IPv6 back to IPv4", () => {
    expect(canonicalClientKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
  });

  it("rejects anything that is not an IP address", () => {
    expect(canonicalClientKey("localhost:3000")).toBeNull();
    expect(canonicalClientKey("unknown")).toBeNull();
    expect(canonicalClientKey("")).toBeNull();
  });
});

describe("getRemoteIp", () => {
  it("uses the entry the trusted proxy appended and ignores client-prepended values", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(getRemoteIp(req({ "x-forwarded-for": "9.9.9.1, 2.2.2.2, 3.3.3.3" }))).toBe("3.3.3.3");
  });

  it("counts hops from the right", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(getRemoteIp(req({ "x-forwarded-for": "9.9.9.1, 2.2.2.2, 3.3.3.3" }))).toBe("2.2.2.2");
  });

  it("defaults to one trusted hop when unset", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", undefined);
    expect(getRemoteIp(req({ "x-forwarded-for": "4.4.4.4" }))).toBe("4.4.4.4");
  });

  it("never falls back to the URL host: hops=0 is a configuration error", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(() => getRemoteIp(req({ "x-forwarded-for": "4.4.4.4" }))).toThrow(
      ClientIpUnavailableError,
    );
    expect(() => assertTrustedProxyConfig()).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it("rejects a malformed hop count instead of guessing", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "two");
    expect(() => getRemoteIp(req({ "x-forwarded-for": "4.4.4.4" }))).toThrow(
      ClientIpUnavailableError,
    );
    vi.stubEnv("TRUSTED_PROXY_HOPS", "-1");
    expect(() => assertTrustedProxyConfig()).toThrow(/TRUSTED_PROXY_HOPS/);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(() => assertTrustedProxyConfig()).not.toThrow();
  });

  it("ignores x-real-ip", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(() => getRemoteIp(req({ "x-real-ip": "9.9.9.9" }))).toThrow(ClientIpUnavailableError);
  });

  it("refuses an X-Forwarded-For shorter than the trusted hops", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(() => getRemoteIp(req({ "x-forwarded-for": "6.6.6.6" }))).toThrow(
      ClientIpUnavailableError,
    );
  });

  it("refuses a trusted entry that is not an IP address", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(() => getRemoteIp(req({ "x-forwarded-for": "evil, not-an-ip" }))).toThrow(
      ClientIpUnavailableError,
    );
  });

  it("returns the canonical IPv6 /64 key", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(getRemoteIp(req({ "x-forwarded-for": "2001:db8::5" }))).toBe("2001:db8:0:0::/64");
  });
});

describe("rateLimitByIp", () => {
  it("passes, then answers 429 with Retry-After once the bucket is empty", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const limiter = createLimiter(1, 60_000);
    expect(rateLimitByIp(limiter, req({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
    const res = rateLimitByIp(limiter, req({ "x-forwarded-for": "1.2.3.4" }));
    expect(res?.status).toBe(429);
    expect(res?.headers.get("retry-after")).toBe("60");
    expect(await res?.json()).toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });

  it("answers 500 and logs when the client IP can't be resolved", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = createLimiter(1, 60_000);
    const res = rateLimitByIp(limiter, req({ "x-forwarded-for": "1.2.3.4" }));
    expect(res?.status).toBe(500);
    expect(await res?.json()).toMatchObject({ ok: false, code: "PROXY_MISCONFIGURED" });
    expect(log).toHaveBeenCalled();
  });
});
