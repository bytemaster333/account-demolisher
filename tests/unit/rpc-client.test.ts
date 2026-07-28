import { describe, it, expect, vi } from "vitest";

import type { rpc } from "@stellar/stellar-sdk";
import { buildFailoverServer, isFailoverError } from "@/lib/soroban/rpc-client";

// A fake rpc.Server exposing just the methods under test. Cast through unknown
// so the failover proxy (which only forwards method calls) can drive it.
function fakeServer(methods: Record<string, unknown>): rpc.Server {
  return methods as unknown as rpc.Server;
}

function httpError(status: number, message = "http error"): Error {
  return Object.assign(new Error(message), { status });
}

describe("isFailoverError", () => {
  it("treats 429 and 5xx as failover-worthy, 4xx as not", () => {
    expect(isFailoverError(httpError(429))).toBe(true);
    expect(isFailoverError(httpError(503))).toBe(true);
    expect(isFailoverError(httpError(500))).toBe(true);
    expect(isFailoverError(httpError(400))).toBe(false);
    expect(isFailoverError(httpError(404))).toBe(false);
  });

  it("treats transport/network errors (no status) as failover-worthy", () => {
    expect(isFailoverError(new Error("Failed to fetch"))).toBe(true);
    expect(isFailoverError(new Error("request timed out"))).toBe(true);
    expect(isFailoverError(new Error("socket hang up"))).toBe(true);
    expect(isFailoverError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("does not misclassify an ordinary error as failover-worthy", () => {
    expect(isFailoverError(new Error("simulation failed: contract trapped"))).toBe(false);
  });
});

describe("buildFailoverServer", () => {
  it("returns the sole server unchanged when only one is given", () => {
    const only = fakeServer({ getLatestLedger: vi.fn() });
    expect(buildFailoverServer([only])).toBe(only);
  });

  it("throws when given no servers", () => {
    expect(() => buildFailoverServer([])).toThrow(/at least one/i);
  });

  it("fails over to the next host on a 429 and returns its result", async () => {
    const a = fakeServer({ getEvents: vi.fn().mockRejectedValue(httpError(429)) });
    const b = fakeServer({ getEvents: vi.fn().mockResolvedValue({ events: ["ok"] }) });

    const server = buildFailoverServer([a, b]);
    const result = await (server as unknown as { getEvents: () => Promise<unknown> }).getEvents();

    expect(result).toEqual({ events: ["ok"] });
    expect((a as unknown as { getEvents: ReturnType<typeof vi.fn> }).getEvents).toHaveBeenCalledTimes(
      1,
    );
    expect((b as unknown as { getEvents: ReturnType<typeof vi.fn> }).getEvents).toHaveBeenCalledTimes(
      1,
    );
  });

  it("does NOT fail over on a deterministic 4xx and propagates it", async () => {
    const aFn = vi.fn().mockRejectedValue(httpError(400, "bad request"));
    const bFn = vi.fn().mockResolvedValue({ events: [] });
    const server = buildFailoverServer([fakeServer({ getEvents: aFn }), fakeServer({ getEvents: bFn })]);

    await expect(
      (server as unknown as { getEvents: () => Promise<unknown> }).getEvents(),
    ).rejects.toThrow(/bad request/);
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).not.toHaveBeenCalled(); // never tried the second host
  });

  it("sticks to the recovered host for subsequent calls", async () => {
    const aFn = vi.fn().mockRejectedValue(httpError(429));
    const bFn = vi.fn().mockResolvedValue("from-b");
    const server = buildFailoverServer([fakeServer({ getEvents: aFn }), fakeServer({ getEvents: bFn })]);
    const call = () => (server as unknown as { getEvents: () => Promise<unknown> }).getEvents();

    await call(); // a throws 429 -> fail over to b, stick to b
    await call(); // should start at b, not touch a again

    expect(aFn).toHaveBeenCalledTimes(1); // only the initial attempt
    expect(bFn).toHaveBeenCalledTimes(2);
  });

  it("propagates the last error when every host faults", async () => {
    const aFn = vi.fn().mockRejectedValue(httpError(429, "a down"));
    const bFn = vi.fn().mockRejectedValue(httpError(503, "b down"));
    const server = buildFailoverServer([fakeServer({ getEvents: aFn }), fakeServer({ getEvents: bFn })]);

    await expect(
      (server as unknown as { getEvents: () => Promise<unknown> }).getEvents(),
    ).rejects.toThrow(/b down/);
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);
  });
});
