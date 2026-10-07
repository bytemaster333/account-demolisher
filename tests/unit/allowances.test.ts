import { afterEach, describe, it, expect, vi } from "vitest";
import { Address, StrKey, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import {
  AllowanceScanIncompleteError,
  CONFIRM_CONCURRENCY,
  confirmAllowancesOnChain,
  enumerateAllowances,
  scanAllowances,
  withoutConfirmedZero,
  type AllowanceRecord,
} from "@/lib/soroban/allowances";
import { TESTNET } from "@/lib/config/networks";
import { fakeEventsRpc, type FakeEvent, type FakeEventsRpcOptions } from "./event-scan-fake-rpc";

// A valid ed25519 public key, enumerateAllowances runs it through Address(),
// which rejects anything malformed.
const USER = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";
const SPENDER = "GDLJJ5CGPWNOCBJMCPJY5HXDIAPV2UGQJWKUL35EVS7IR6JJZQ27WOPC";

// ── ScVal builders for synthetic approve events ──────────────────────────────
const sym = (s: string): xdr.ScVal => nativeToScVal(s, { type: "symbol" });
const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });
const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
const addr = (g: string): xdr.ScVal => new Address(g).toScVal();

// tuple-as-vec (sep-41 reference encoding)
function vecValue(amount: bigint, liveUntil: number): xdr.ScVal {
  return xdr.ScVal.scvVec([i128(amount), u32(liveUntil)]);
}

// struct (scvMap) fallback with the given expiry key name
function mapValue(amount: bigint, liveUntil: number, expiryKey: string): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym("amount"), val: i128(amount) }),
    new xdr.ScMapEntry({ key: sym(expiryKey), val: u32(liveUntil) }),
  ]);
}

interface EventOpts {
  contractSeed?: number;
  from?: string;
  spender?: string;
  topicCount?: 3 | 4;
  // position inside the ledger (tx/op/event order)
  index?: number;
}

function approveEvent(ledger: number, value: xdr.ScVal, opts: EventOpts = {}): FakeEvent {
  const topic: xdr.ScVal[] = [
    sym("approve"),
    addr(opts.from ?? USER),
    addr(opts.spender ?? SPENDER),
  ];
  if (opts.topicCount === 4) topic.push(sym("extra"));
  return {
    ledger,
    index: opts.index ?? 0,
    contractId: StrKey.encodeContract(Buffer.alloc(32, opts.contractSeed ?? 7)),
    topic,
    value,
  };
}

// an rpc that serves these events the way stellar-rpc does (windows, filters)
function serverWithEvents(
  events: FakeEvent[],
  extra: Partial<FakeEventsRpcOptions> = {},
): rpc.Server {
  return fakeEventsRpc({ oldestLedger: 1, latestLedger: 100_000, events, ...extra }).server;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("allowance scan range", () => {
  it("starts at the rpc's reported retention floor instead of a request bound to fail", async () => {
    const { server, requests } = fakeEventsRpc({
      oldestLedger: 40_000,
      latestLedger: 100_000,
      events: [],
    });
    await enumerateAllowances(server, USER, 100_000);
    expect(requests.length).toBeGreaterThan(0);
    expect(Math.min(...requests.map((r) => r.startLedger!))).toBeGreaterThanOrEqual(40_000);
  });

  it("runs the slices concurrently", async () => {
    const { server } = fakeEventsRpc({ oldestLedger: 1, latestLedger: 100_000, events: [] });
    let inFlight = 0;
    let peak = 0;
    const real = server.getEvents.bind(server);
    server.getEvents = (async (req: Parameters<typeof real>[0]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return real(req);
    }) as typeof server.getEvents;
    await enumerateAllowances(server, USER, 100_000);
    expect(peak).toBeGreaterThan(1);
  });

  it("re-clamps a slice when the floor moved past it after the health read", async () => {
    const fake = fakeEventsRpc({
      oldestLedger: 1,
      latestLedger: 50_000,
      events: [approveEvent(30_000, vecValue(5n, 60_000))],
    });
    const health = await fake.server.getHealth();
    // the host now retains less than it reported a moment ago
    const moved = fakeEventsRpc({
      oldestLedger: 5_000,
      latestLedger: 50_000,
      events: [approveEvent(30_000, vecValue(5n, 60_000))],
    });
    const server = {
      getHealth: async () => health,
      getEvents: moved.server.getEvents,
    } as rpc.Server;
    const recs = await enumerateAllowances(server, USER, 50_000, 50_000);
    expect(recs.map((r) => r.amount)).toEqual([5n]);
    expect(moved.requests.some((r) => r.startLedger === 5_060)).toBe(true);
  });

  it("reports a partial scan instead of returning it as complete", async () => {
    vi.useFakeTimers();
    const server = serverWithEvents(
      [
        approveEvent(99_000, vecValue(5n, 200_000)),
        approveEvent(2_000, vecValue(9n, 200_000), { contractSeed: 8 }),
      ],
      { latencyMs: 1_000 },
    );
    const scanning = scanAllowances(server, USER, 100_000, 100_000, { budgetMs: 1_500 });
    await vi.advanceTimersByTimeAsync(2_000);
    const scan = await scanning;
    expect(scan.records.map((r) => r.amount)).toEqual([5n]);
    expect(scan.incomplete).toMatchObject({ reason: "budget", lastLedger: 100_000 });

    const enumerating = enumerateAllowances(server, USER, 100_000, 100_000, { budgetMs: 1_500 });
    const caught = enumerating.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await caught;
    expect(err).toBeInstanceOf(AllowanceScanIncompleteError);
    expect((err as AllowanceScanIncompleteError).partial.map((r) => r.amount)).toEqual([5n]);
  });
});

describe("enumerateAllowances event decoding", () => {
  it("decodes a 3-topic approve with tuple-as-vec value", async () => {
    const currentLedger = 100_000;
    const server = serverWithEvents([approveEvent(5_000, vecValue(500n, currentLedger + 100))]);

    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger);

    expect(recs).toHaveLength(1);
    const rec = recs[0] as AllowanceRecord;
    expect(rec.spender).toBe(SPENDER);
    expect(rec.amount).toBe(500n);
    expect(rec.live_until_ledger).toBe(currentLedger + 100);
    expect(rec.expired).toBe(false);
    expect(rec.lastSeenLedger).toBe(5_000);
  });

  it("tolerates the 4-topic approve variant", async () => {
    const currentLedger = 100_000;
    const server = serverWithEvents([
      approveEvent(5_000, vecValue(250n, currentLedger + 50), { topicCount: 4 }),
    ]);

    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger);

    expect(recs).toHaveLength(1);
    expect((recs[0] as AllowanceRecord).amount).toBe(250n);
  });

  it("keeps the latest ledger's amount for the same contract+spender (revoke wins)", async () => {
    const currentLedger = 100_000;
    // older event grants 500; newer event (higher ledger) revokes to 0
    const server = serverWithEvents([
      approveEvent(5_000, vecValue(500n, currentLedger + 100)),
      approveEvent(6_000, vecValue(0n, currentLedger + 100)),
    ]);

    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger, {
      includeZero: true,
    });

    expect(recs).toHaveLength(1);
    const rec = recs[0] as AllowanceRecord;
    expect(rec.amount).toBe(0n);
    expect(rec.lastSeenLedger).toBe(6_000);
  });

  it("takes the later of two approves in the same ledger, in either order", async () => {
    const currentLedger = 100_000;
    // revoke then re-approve within one ledger: the re-approve is live
    const reapproved = serverWithEvents([
      approveEvent(5_000, vecValue(0n, currentLedger + 100), { index: 1 }),
      approveEvent(5_000, vecValue(5_000n, currentLedger + 100), { index: 2 }),
    ]);
    const live = await enumerateAllowances(reapproved, USER, currentLedger, currentLedger);
    expect(live.map((r) => r.amount)).toEqual([5_000n]);

    // approve then revoke within one ledger: nothing is live
    const revoked = serverWithEvents([
      approveEvent(5_000, vecValue(5_000n, currentLedger + 100), { index: 1 }),
      approveEvent(5_000, vecValue(0n, currentLedger + 100), { index: 2 }),
    ]);
    const after = await enumerateAllowances(revoked, USER, currentLedger, currentLedger, {
      includeZero: true,
    });
    expect(after.map((r) => r.amount)).toEqual([0n]);
  });

  it("leaves out an allowance whose latest approve set it to zero, unless asked", async () => {
    const currentLedger = 100_000;
    const server = serverWithEvents([
      approveEvent(5_000, vecValue(0n, currentLedger + 100)),
      approveEvent(5_100, vecValue(3n, currentLedger + 100), { contractSeed: 9 }),
    ]);
    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger);
    expect(recs.map((r) => r.amount)).toEqual([3n]);
  });

  it("decodes the scvMap fallback with the expiration_ledger alias", async () => {
    const currentLedger = 100_000;
    const server = serverWithEvents([
      approveEvent(5_000, mapValue(999n, currentLedger + 10, "expiration_ledger")),
    ]);

    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger);

    expect(recs).toHaveLength(1);
    const rec = recs[0] as AllowanceRecord;
    expect(rec.amount).toBe(999n);
    expect(rec.live_until_ledger).toBe(currentLedger + 10);
  });

  it("decodes the scvMap fallback with the live_until_ledger key", async () => {
    const currentLedger = 100_000;
    const server = serverWithEvents([
      approveEvent(5_000, mapValue(777n, currentLedger + 20, "live_until_ledger")),
    ]);

    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger);

    expect(recs).toHaveLength(1);
    expect((recs[0] as AllowanceRecord).amount).toBe(777n);
  });

  it("skips events whose `from` topic is not the queried user", async () => {
    const currentLedger = 100_000;
    const server = serverWithEvents([
      approveEvent(5_000, vecValue(500n, currentLedger + 100), { from: SPENDER }),
    ]);

    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger);

    expect(recs).toEqual([]);
  });
});

describe("enumerateAllowances expiry classification", () => {
  it("does NOT mark an allowance expired when live_until_ledger === currentLedger (still live)", async () => {
    // off-by-one guard: an allowance valid *at* the current ledger is still live
    const currentLedger = 100_000;
    const server = serverWithEvents([approveEvent(5_000, vecValue(500n, currentLedger))]);

    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger);

    expect(recs).toHaveLength(1);
    expect((recs[0] as AllowanceRecord).expired).toBe(false);
    expect((recs[0] as AllowanceRecord).live_until_ledger).toBe(currentLedger);
  });

  it("marks an allowance expired only once currentLedger has passed live_until_ledger", async () => {
    const currentLedger = 100_000;
    // live_until_ledger is strictly below currentLedger -> genuinely expired
    const server = serverWithEvents([approveEvent(5_000, vecValue(500n, currentLedger - 1))]);

    // default options drop expired records
    const dropped = await enumerateAllowances(server, USER, currentLedger, currentLedger);
    expect(dropped).toEqual([]);

    // includeExpired surfaces them, stamped expired: true
    const included = await enumerateAllowances(server, USER, currentLedger, currentLedger, {
      includeExpired: true,
    });
    expect(included).toHaveLength(1);
    expect((included[0] as AllowanceRecord).expired).toBe(true);
  });
});

describe("confirming allowances on chain", () => {
  const record = (seed: number): AllowanceRecord => ({
    contractId: StrKey.encodeContract(Buffer.alloc(32, seed % 250)),
    spender: SPENDER,
    amount: 1n,
    live_until_ledger: 10,
    lastSeenLedger: 1,
    expired: false,
  });

  it("keeps a bounded number of reads in flight however many records there are", async () => {
    let inFlight = 0;
    let peak = 0;
    // the allowance() read is a simulateTransaction against the token
    const server = {
      simulateTransaction: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return { error: "not modelled", events: [], latestLedger: 1, id: "1", _parsed: true };
      },
    } as unknown as rpc.Server;
    const records = Array.from({ length: 300 }, (_, i) => record(i));
    const out = await confirmAllowancesOnChain(server, USER, records, TESTNET, USER);
    expect(out).toHaveLength(300);
    expect(peak).toBeLessThanOrEqual(CONFIRM_CONCURRENCY);
    expect(out.every((r) => r.onChainAmount === null)).toBe(true);
  });

  it("drops records the chain reports as already zero", () => {
    const rows = [
      { ...record(1), onChainAmount: 0n },
      { ...record(2), onChainAmount: 4n },
      { ...record(3), onChainAmount: null },
    ];
    expect(withoutConfirmedZero(rows).map((r) => r.onChainAmount)).toEqual([4n, null]);
  });
});
