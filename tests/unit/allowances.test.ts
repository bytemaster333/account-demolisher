import { describe, it, expect, vi } from "vitest";
import { Address, Contract, StrKey, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { enumerateAllowances, type AllowanceRecord } from "@/lib/soroban/allowances";

// A valid ed25519 public key — enumerateAllowances runs it through Address(),
// which rejects anything malformed.
const USER = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";
const SPENDER = "GDLJJ5CGPWNOCBJMCPJY5HXDIAPV2UGQJWKUL35EVS7IR6JJZQ27WOPC";

// The Soroban RPC rejects an out-of-window startLedger with a plain
// `{ code, message }` object (not an Error), e.g.
// "startLedger must be within the ledger range: 1000 - 2000".
function rangeError(floor: number, ceil: number): { code: number; message: string } {
  return {
    code: -32600,
    message: `startLedger must be within the ledger range: ${floor} - ${ceil}`,
  };
}

// ── ScVal builders for synthetic approve events ──────────────────────────────
const sym = (s: string): xdr.ScVal => nativeToScVal(s, { type: "symbol" });
const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });
const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
const addr = (g: string): xdr.ScVal => new Address(g).toScVal();

// a valid contract C-address, and a Contract wrapper exposing .contractId()
function contract(seed: number): Contract {
  return new Contract(StrKey.encodeContract(Buffer.alloc(32, seed)));
}

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
}

function approveEvent(
  ledger: number,
  value: xdr.ScVal,
  opts: EventOpts = {},
): rpc.Api.EventResponse {
  const topics: xdr.ScVal[] = [
    sym("approve"),
    addr(opts.from ?? USER),
    addr(opts.spender ?? SPENDER),
  ];
  if (opts.topicCount === 4) topics.push(sym("extra"));
  return {
    contractId: contract(opts.contractSeed ?? 7),
    topic: topics,
    value,
    ledger,
    // BaseEventResponse fields the decoder never reads
    id: `${ledger}`,
    type: "contract",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: "",
  } as unknown as rpc.Api.EventResponse;
}

// build a mocked server that returns a single page of the given events
function serverWithEvents(events: rpc.Api.EventResponse[], latestLedger = 100_000): rpc.Server {
  const getEvents = vi.fn(async () => ({ events, cursor: "", latestLedger }));
  return { getEvents } as unknown as rpc.Server;
}

describe("enumerateAllowances retention clamp", () => {
  it("retries at floor + margin (not the exact floor) when startLedger is below retention", async () => {
    const attempted: number[] = [];
    const getEvents = vi.fn(async (req: { startLedger?: number; cursor?: string }) => {
      if (req.startLedger !== undefined) attempted.push(req.startLedger);
      // first attempt is below the retained window -> reject with the range
      if (attempted.length === 1) throw rangeError(1000, 2000);
      return { events: [], cursor: "", latestLedger: 2000 };
    });
    const server = { getEvents } as unknown as rpc.Server;

    // window (5000) is larger than retention, so startLedger lands below the floor
    const recs = await enumerateAllowances(server, USER, 2000, 5000);

    expect(recs).toEqual([]);
    // first attempt was below the reported floor (1000)…
    expect(attempted[0]).toBeLessThan(1000);
    // …and the retry clamped to floor + margin, NOT the exact floor (which would
    // race a ledger closing during the retry gap)
    expect(attempted[1]).toBe(1060);
  });

  it("does not retry when the first request succeeds", async () => {
    const attempted: number[] = [];
    const getEvents = vi.fn(async (req: { startLedger?: number }) => {
      if (req.startLedger !== undefined) attempted.push(req.startLedger);
      return { events: [], cursor: "", latestLedger: 5000 };
    });
    const server = { getEvents } as unknown as rpc.Server;

    await enumerateAllowances(server, USER, 5000, 1000);

    expect(attempted).toHaveLength(1);
    expect(attempted[0]).toBe(4000);
  });

  // Finding: retention-clamp retry was single-shot — a second range error on the
  // retry propagated uncaught. The bounded loop must re-parse the fresh floor,
  // re-clamp, and succeed on a subsequent attempt instead of throwing.
  it("re-clamps and retries when the retry itself reports a further-advanced floor", async () => {
    const attempted: number[] = [];
    const getEvents = vi.fn(async (req: { startLedger?: number; cursor?: string }) => {
      if (req.startLedger !== undefined) attempted.push(req.startLedger);
      if (attempted.length === 1) throw rangeError(1000, 3000); // initial: floor 1000
      if (attempted.length === 2) throw rangeError(1100, 3000); // retry: floor advanced to 1100
      return { events: [], cursor: "", latestLedger: 3000 };
    });
    const server = { getEvents } as unknown as rpc.Server;

    const recs = await enumerateAllowances(server, USER, 3000, 5000);

    expect(recs).toEqual([]);
    // first retry clamped to 1000 + 60, second retry re-clamped to 1100 + 60
    expect(attempted[1]).toBe(1060);
    expect(attempted[2]).toBe(1160);
  });

  it("gives up (rethrows) after exhausting bounded retries on persistent range errors", async () => {
    // floor keeps advancing past every clamp, so no attempt ever succeeds
    let floor = 1000;
    const getEvents = vi.fn(async (req: { startLedger?: number; cursor?: string }) => {
      if (req.startLedger !== undefined) {
        // advance the floor beyond whatever we just clamped to
        floor = (req.startLedger ?? floor) + 100;
      }
      throw rangeError(floor, 9000);
    });
    const server = { getEvents } as unknown as rpc.Server;

    await expect(enumerateAllowances(server, USER, 9000, 20_000)).rejects.toMatchObject({
      message: expect.stringContaining("ledger range"),
    });
  });
});

describe("enumerateAllowances event decoding", () => {
  it("decodes a 3-topic approve with tuple-as-vec value", async () => {
    const currentLedger = 100_000;
    const server = serverWithEvents([
      approveEvent(5_000, vecValue(500n, currentLedger + 100)),
    ]);

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

    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger);

    expect(recs).toHaveLength(1);
    const rec = recs[0] as AllowanceRecord;
    expect(rec.amount).toBe(0n);
    expect(rec.lastSeenLedger).toBe(6_000);
  });

  it("ignores an out-of-order older event that arrives after the newer one", async () => {
    const currentLedger = 100_000;
    // newer event first, then an older (lower-ledger) event for the same key
    const server = serverWithEvents([
      approveEvent(6_000, vecValue(0n, currentLedger + 100)),
      approveEvent(5_000, vecValue(500n, currentLedger + 100)),
    ]);

    const recs = await enumerateAllowances(server, USER, currentLedger, currentLedger);

    expect(recs).toHaveLength(1);
    expect((recs[0] as AllowanceRecord).amount).toBe(0n);
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
