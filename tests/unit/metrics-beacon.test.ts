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
    expect(() => trackClose("mainnet", HASH)).not.toThrow();
  });

  it("is a no-op during SSR (no window)", () => {
    vi.stubGlobal("window", undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(() => trackVisit("landing")).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
