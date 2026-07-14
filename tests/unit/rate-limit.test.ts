import { describe, expect, it } from "vitest";

import { createLimiter, getRemoteIp } from "@/server/rate-limit";

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
});

describe("getRemoteIp", () => {
  it("trusts the rightmost X-Forwarded-For hop (the trusted proxy's peer)", () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" },
    });
    expect(getRemoteIp(req)).toBe("3.3.3.3");
  });

  it("falls back to x-real-ip, then host", () => {
    expect(getRemoteIp(new Request("http://x/", { headers: { "x-real-ip": "9.9.9.9" } }))).toBe(
      "9.9.9.9",
    );
    expect(getRemoteIp(new Request("http://host.example/path"))).toBe("host.example");
  });
});
