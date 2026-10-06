import { afterEach, describe, expect, it, vi } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

import { describeIncompleteScan, scanEventWindows } from "@/lib/soroban/event-scan";
import { addr, fakeEventsRpc, sym } from "./event-scan-fake-rpc";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 1));
const FILTERS = [{ type: "contract" as const, topics: [[sym("ping").toXdr("base64"), "*"]] }];
const ping = (ledger: number, index = 0) => ({
  ledger,
  index,
  contractId: TOKEN,
  topic: [sym("ping"), addr(USER)],
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scanEventWindows", () => {
  it("covers the retained range in explicit windows and starts at the reported floor", async () => {
    const { server, requests } = fakeEventsRpc({
      oldestLedger: 5_000,
      latestLedger: 20_000,
      events: [ping(5_100), ping(12_000), ping(19_999)],
    });
    const res = await scanEventWindows(server, FILTERS, {
      lastLedger: 20_000,
      windowLedgers: 4_000,
      minWindowLedgers: 100,
      concurrency: 2,
      budgetMs: 5_000,
    });
    expect(res.incomplete).toBeNull();
    expect(res.events.map((e) => e.ledger)).toEqual([5_100, 12_000, 19_999]);
    // no request below the floor (+ margin), every request bounded by endLedger
    for (const r of requests) {
      expect(r.startLedger).toBeGreaterThanOrEqual(5_000);
      expect(r.endLedger).toBeDefined();
    }
  });

  it("halves a window the host refuses as too costly instead of failing the scan", async () => {
    const { server, requests } = fakeEventsRpc({
      oldestLedger: 1,
      latestLedger: 10_000,
      maxCheapWindow: 600,
      events: [ping(9_000), ping(2_000)],
    });
    const res = await scanEventWindows(server, FILTERS, {
      lastLedger: 10_000,
      windowLedgers: 2_000,
      minWindowLedgers: 100,
      concurrency: 2,
      budgetMs: 5_000,
    });
    expect(res.incomplete).toBeNull();
    expect(res.events.map((e) => e.ledger)).toEqual([2_000, 9_000]);
    expect(requests.some((r) => r.endLedger! - r.startLedger! <= 600)).toBe(true);
  });

  it("reports the processing limit when even the smallest window is refused", async () => {
    const { server } = fakeEventsRpc({
      oldestLedger: 1,
      latestLedger: 10_000,
      maxCheapWindow: 50,
      events: [],
    });
    const res = await scanEventWindows(server, FILTERS, {
      lastLedger: 10_000,
      windowLedgers: 1_000,
      minWindowLedgers: 250,
      concurrency: 1,
      budgetMs: 5_000,
    });
    expect(res.incomplete?.reason).toBe("processing-limit");
    expect(describeIncompleteScan(res.incomplete!, "tokens")).toMatch(/processing limit/);
  });

  it("keeps what it found and says how far back it got when the budget runs out", async () => {
    vi.useFakeTimers();
    const { server } = fakeEventsRpc({
      oldestLedger: 1,
      latestLedger: 100_000,
      latencyMs: 1_000,
      events: [ping(99_500), ping(10)],
    });
    const scan = scanEventWindows(server, FILTERS, {
      lastLedger: 100_000,
      windowLedgers: 1_000,
      minWindowLedgers: 100,
      concurrency: 2,
      budgetMs: 3_500,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const res = await scan;
    expect(res.events.map((e) => e.ledger)).toEqual([99_500]);
    expect(res.incomplete?.reason).toBe("budget");
    // three rounds of two windows finished: the newest 6,000 ledgers
    expect(res.incomplete?.coveredFromLedger).toBe(94_001);
    expect(res.incomplete?.lastLedger).toBe(100_000);
    expect(describeIncompleteScan(res.incomplete!, "tokens")).toMatch(/about 8 hours/);
  });

  it("does not wait on a window that never answers past the budget", async () => {
    vi.useFakeTimers();
    const { server } = fakeEventsRpc({
      oldestLedger: 1,
      latestLedger: 10_000,
      hangAtOrBelow: 5_000,
      events: [ping(9_000)],
    });
    const scan = scanEventWindows(server, FILTERS, {
      lastLedger: 10_000,
      windowLedgers: 2_500,
      minWindowLedgers: 100,
      concurrency: 2,
      budgetMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await scan;
    expect(res.events.map((e) => e.ledger)).toEqual([9_000]);
    expect(res.incomplete).toMatchObject({ reason: "budget", coveredFromLedger: 5_001 });
  });

  it("splits a window whose page fills, since a cursor cannot keep the end ledger", async () => {
    const events = Array.from({ length: 30 }, (_, i) => ping(1_000 + i * 10));
    const { server } = fakeEventsRpc({ oldestLedger: 1, latestLedger: 2_000, events });
    const res = await scanEventWindows(server, FILTERS, {
      lastLedger: 2_000,
      windowLedgers: 2_000,
      minWindowLedgers: 10,
      concurrency: 1,
      budgetMs: 5_000,
      pageLimit: 8,
    });
    expect(res.incomplete).toBeNull();
    expect(res.events).toHaveLength(30);
  });

  it("orders events by id across windows that finish out of order", async () => {
    const { server } = fakeEventsRpc({
      oldestLedger: 1,
      latestLedger: 4_000,
      events: [ping(3_500, 1), ping(3_500, 0), ping(100)],
    });
    const res = await scanEventWindows(server, FILTERS, {
      lastLedger: 4_000,
      windowLedgers: 1_000,
      minWindowLedgers: 10,
      concurrency: 4,
      budgetMs: 5_000,
    });
    expect(res.events.map((e) => e.id)).toEqual([
      "0000000000000000100-0000000000",
      "0000000000000003500-0000000000",
      "0000000000000003500-0000000001",
    ]);
  });

  it("refuses a window wider than the rpc scans in one request", async () => {
    // stellar-rpc caps one getEvents request at LedgerScanLimit = 10,000 ledgers
    // and quietly ends the scan there, so a wider window would read as covered
    // while its older part was never looked at
    const { server, requests } = fakeEventsRpc({
      oldestLedger: 1,
      latestLedger: 50_000,
      events: [],
    });
    await expect(
      scanEventWindows(server, FILTERS, {
        lastLedger: 50_000,
        windowLedgers: 10_001,
        minWindowLedgers: 100,
        concurrency: 1,
        budgetMs: 5_000,
      }),
    ).rejects.toThrow(/10000|10,000/);
    expect(requests).toHaveLength(0);
  });

  it("keeps every worker busy after a window splits late", async () => {
    const { server } = fakeEventsRpc({
      oldestLedger: 1,
      latestLedger: 8_000,
      maxCheapWindow: 1_000,
      latencyMs: 5,
      events: [ping(7_999), ping(100)],
    });
    let inFlight = 0;
    let peak = 0;
    const real = server.getEvents.bind(server);
    server.getEvents = (async (req: Parameters<typeof real>[0]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await real(req);
      } finally {
        inFlight -= 1;
      }
    }) as typeof server.getEvents;
    // one 8,000-ledger window to start with: the other three workers find the
    // queue empty until it splits
    const res = await scanEventWindows(server, FILTERS, {
      lastLedger: 8_000,
      windowLedgers: 8_000,
      minWindowLedgers: 100,
      concurrency: 4,
      budgetMs: 5_000,
    });
    expect(res.incomplete).toBeNull();
    expect(res.events.map((e) => e.ledger)).toEqual([100, 7_999]);
    expect(peak).toBe(4);
  });

  it("stops and reports an rpc error, keeping earlier results", async () => {
    const { server } = fakeEventsRpc({
      oldestLedger: 1,
      latestLedger: 3_000,
      events: [ping(2_500)],
    });
    let calls = 0;
    const real = server.getEvents.bind(server);
    server.getEvents = (async (req: Parameters<typeof real>[0]) => {
      calls += 1;
      if (calls > 1) throw { code: -32602, message: "invalid filter" };
      return real(req);
    }) as typeof server.getEvents;
    const res = await scanEventWindows(server, FILTERS, {
      lastLedger: 3_000,
      windowLedgers: 1_000,
      minWindowLedgers: 10,
      concurrency: 1,
      budgetMs: 5_000,
    });
    expect(res.events.map((e) => e.ledger)).toEqual([2_500]);
    expect(res.incomplete).toMatchObject({ reason: "rpc-error", detail: "invalid filter" });
  });
});
