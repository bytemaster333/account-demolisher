// subscribePlan falls back to polling when the event stream is refused, retries
// the stream later, and stops for good only when the relay says the plan is gone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PlanNotFoundError,
  fetchPlan,
  parseRelayPlan,
  subscribePlan,
  type LiveStatus,
  type RelayPlan,
} from "@/lib/multisig/plan-client";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  // what the browser does when the server answers 503: close, then fire error
  refuse(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const PLAN: RelayPlan = {
  network: "testnet",
  xdr: "AAAA",
  account: "GACCOUNT",
  signers: [{ key: "GSIGNER", weight: 1 }],
  thresholds: { low: 1, med: 1, high: 2 },
  expiresAt: 1_900_000_000_000,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("subscribePlan", () => {
  it("polls the plan after a 503 and retries the stream later", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(PLAN), { status: 200 }));
    const updates: RelayPlan[] = [];
    const statuses: LiveStatus[] = [];
    const stop = subscribePlan(
      "abc",
      (p) => updates.push(p),
      (s) => statuses.push(s),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0]!.refuse();
    expect(statuses.at(-1)).toEqual({ mode: "polling", terminal: false });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledWith("/api/plan/abc", { cache: "no-store" });
    expect(updates).toEqual([PLAN]);

    // keep polling until a minute has passed since the stream was tried
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
    const retried = FakeEventSource.instances.at(-1)!;
    retried.readyState = FakeEventSource.OPEN;
    retried.onopen?.();
    expect(statuses.at(-1)).toEqual({ mode: "live", terminal: false });
    const callsWhileLive = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.length).toBe(callsWhileLive);
    stop();
  });

  it("reports gone and stops when the plan no longer exists", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ ok: false, reason: "This signing request no longer exists." }),
          {
            status: 404,
          },
        ),
    );
    const statuses: LiveStatus[] = [];
    subscribePlan(
      "gone",
      () => {},
      (s) => statuses.push(s),
    );
    FakeEventSource.instances[0]!.refuse();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statuses.at(-1)).toMatchObject({ mode: "gone", terminal: true });
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("falls back after repeated reconnect errors on an unreachable server", () => {
    const statuses: LiveStatus[] = [];
    subscribePlan(
      "x",
      () => {},
      (s) => statuses.push(s),
    );
    const es = FakeEventSource.instances[0]!;
    es.onerror?.();
    es.onerror?.();
    expect(statuses).toHaveLength(0);
    es.onerror?.();
    expect(statuses.at(-1)).toEqual({ mode: "polling", terminal: false });
  });
});

describe("fetchPlan", () => {
  it("throws PlanNotFoundError on 404", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    await expect(fetchPlan("nope")).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it("rejects a payload without the signer set", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ network: "testnet", xdr: "AAAA" }), { status: 200 }),
    );
    await expect(fetchPlan("x")).rejects.toThrow(/unexpected response/);
  });
});

describe("parseRelayPlan", () => {
  it("accepts a full plan and rejects malformed signers", () => {
    expect(parseRelayPlan(PLAN)).toEqual(PLAN);
    expect(parseRelayPlan({ ...PLAN, signers: [{ key: 1, weight: 1 }] })).toBeNull();
  });
});
