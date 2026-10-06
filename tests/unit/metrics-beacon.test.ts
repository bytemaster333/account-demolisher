import { describe, it, expect, afterEach, vi } from "vitest";
import { trackClose, trackFunnel, trackVisit } from "@/lib/metrics/beacon";

const HASH = "a".repeat(64);

// The beacon reads window/navigator/fetch at call time. Node exposes some of
// these as getter-only globals, so install fakes via stubGlobal (not assignment).
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("beacon", () => {
  it("sends via navigator.sendBeacon with the correct endpoint and payload", async () => {
    let captured: Blob | null = null;
    const sendBeacon = vi.fn((_url: string, data: Blob) => {
      captured = data;
      return true;
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { sendBeacon });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    trackVisit("demolish", "mainnet");

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0]![0]).toBe("/api/metrics");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(await captured!.text())).toEqual({
      type: "visit",
      page: "demolish",
      network: "mainnet",
    });
  });

  it("omits network for a visit when not supplied", async () => {
    let captured: Blob | null = null;
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      sendBeacon: (_url: string, data: Blob) => {
        captured = data;
        return true;
      },
    });
    trackVisit("landing");
    expect(JSON.parse(await captured!.text())).toEqual({ type: "visit", page: "landing" });
  });

  it("falls back to a keepalive fetch when sendBeacon returns false", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { sendBeacon: () => false });
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);

    trackFunnel("testnet", "close_started");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/metrics");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({
      type: "funnel",
      network: "testnet",
      step: "close_started",
    });
  });

  it("never throws, even if sendBeacon throws", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      sendBeacon: () => {
        throw new Error("boom");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => trackVisit("landing")).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("retries a close while verification is unavailable (503), then stops", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", {});
      const statuses = [503, 503, 201];
      const fetchSpy = vi.fn(() =>
        Promise.resolve(new Response(null, { status: statuses.shift() ?? 201 })),
      );
      vi.stubGlobal("fetch", fetchSpy);

      trackClose("mainnet", HASH);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/metrics");
      expect(JSON.parse(init.body as string)).toEqual({
        type: "close",
        network: "mainnet",
        txHash: HASH,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a close after a bounded number of retries and logs it", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", {});
      const fetchSpy = vi.fn(() => Promise.reject(new Error("offline")));
      vi.stubGlobal("fetch", fetchSpy);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      trackClose("testnet", HASH);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchSpy).toHaveBeenCalledTimes(5);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a close the server refused (422)", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", {});
      const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 422 })));
      vi.stubGlobal("fetch", fetchSpy);
      trackClose("testnet", HASH);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op during SSR (no window)", () => {
    vi.stubGlobal("window", undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(() => trackVisit("landing")).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
