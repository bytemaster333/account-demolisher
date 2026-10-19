import { describe, it, expect, vi, beforeEach } from "vitest";
import { Contract, StrKey, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";

// the balance probe is a network read; the held-token cases answer it here
const balance = vi.fn();
vi.mock("@/lib/soroban/sep41", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soroban/sep41")>()),
  balance: (...args: unknown[]) => balance(...args),
}));

import { scanAllowances } from "@/lib/soroban/allowances";
import { mergePartnerEvents, type EventScanResult } from "@/lib/soroban/event-scan";
import { discoverHeldTokens } from "@/lib/soroban/held-tokens";
import { TESTNET } from "@/lib/config/networks";
import { addr, eventId, fakeEventsRpc, sym, type FakeEvent } from "./event-scan-fake-rpc";

const USER = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";
const SPENDER = "GDLJJ5CGPWNOCBJMCPJY5HXDIAPV2UGQJWKUL35EVS7IR6JJZQ27WOPC";
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7));
const OLD_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 8));

// the rpc keeps ledgers 90,000 to 100,000; anything older only the partner has
const RPC = { oldestLedger: 90_000, latestLedger: 100_000 } as const;

function approveValue(amount: bigint, liveUntil: number): xdr.ScVal {
  return xdr.ScVal.scvVec([
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(liveUntil, { type: "u32" }),
  ]);
}

function approve(ledger: number, contractId: string, amount: bigint, index = 0): FakeEvent {
  return {
    ledger,
    index,
    contractId,
    topic: [sym("approve"), addr(USER), addr(SPENDER)],
    value: approveValue(amount, 500_000),
  };
}

// the event as the partner index hands it over: decoded into the rpc's shape,
// keyed by the rpc's own event id
function asPartnerEvent(e: FakeEvent): rpc.Api.EventResponse {
  return {
    id: eventId(e.ledger, e.index),
    type: "contract",
    ledger: e.ledger,
    ledgerClosedAt: "",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: "",
    contractId: new Contract(e.contractId),
    topic: [...e.topic],
    value: e.value ?? xdr.ScVal.scvVoid(),
  };
}

function scanResult(ids: number[], incomplete: EventScanResult["incomplete"]): EventScanResult {
  return {
    events: ids.map((l) => asPartnerEvent(approve(l, TOKEN, 1n))),
    incomplete,
  };
}

const STOPPED = {
  reason: "budget" as const,
  coveredFromLedger: 95_000,
  rangeStartLedger: 90_000,
  lastLedger: 100_000,
  detail: "the 20000 ms scan budget ran out",
};

beforeEach(() => {
  balance.mockReset();
});

describe("mergePartnerEvents", () => {
  it("unions both answers in event order, one row per rpc event id", () => {
    const merged = mergePartnerEvents(scanResult([96_000, 99_000], null), {
      events: [70_000, 96_000].map((l) => asPartnerEvent(approve(l, TOKEN, 1n))),
      throughLedger: 99_998,
    });
    expect(merged.events.map((e) => e.ledger)).toEqual([70_000, 96_000, 99_000]);
    expect(merged.incomplete).toBeNull();
  });

  it("closes the gap of a scan that stopped early when the partner reaches its covered part", () => {
    const merged = mergePartnerEvents(scanResult([], STOPPED), {
      events: [],
      throughLedger: 99_998,
    });
    expect(merged.incomplete).toBeNull();
  });

  it("keeps the gap when the partner stops short of the ledgers the scan covered", () => {
    const merged = mergePartnerEvents(scanResult([], STOPPED), {
      events: [],
      throughLedger: 94_000,
    });
    expect(merged.incomplete).toEqual(STOPPED);
  });
});

describe("scanAllowances with the partner history index", () => {
  it("finds an approve older than the rpc keeps", async () => {
    const old = approve(10_000, OLD_TOKEN, 700n);
    const { server } = fakeEventsRpc({ ...RPC, events: [old] });
    const scan = await scanAllowances(server, USER, 100_000, 120_960, {
      partner: async () => ({ events: [asPartnerEvent(old)], throughLedger: 99_998 }),
    });
    expect(scan.records.map((r) => [r.contractId, r.amount, r.lastSeenLedger])).toEqual([
      [OLD_TOKEN, 700n, 10_000],
    ]);
    expect(scan.partnerThroughLedger).toBe(99_998);
    expect(scan.partnerError).toBeNull();
  });

  it("keeps the latest approve when the two sources overlap", async () => {
    const first = approve(50_000, TOKEN, 100n);
    const revoke = approve(95_000, TOKEN, 0n);
    const { server } = fakeEventsRpc({ ...RPC, events: [first, revoke] });
    const scan = await scanAllowances(server, USER, 100_000, 120_960, {
      // the partner lags the tip: it has the old approve and the revoke both
      partner: async () => ({
        events: [asPartnerEvent(first), asPartnerEvent(revoke)],
        throughLedger: 99_000,
      }),
    });
    // revoked in the newest event, so nothing is left to show
    expect(scan.records).toEqual([]);
  });

  it("closes the gap of an rpc scan that ran out of time", async () => {
    vi.useFakeTimers();
    try {
      // windows at or below ledger 95,000 never answer, so the scan stops there
      const { server } = fakeEventsRpc({ ...RPC, events: [], hangAtOrBelow: 95_000 });
      const scanning = scanAllowances(server, USER, 100_000, 120_960, {
        budgetMs: 1_000,
        partner: async () => ({ events: [], throughLedger: 100_000 }),
      });
      await vi.advanceTimersByTimeAsync(1_500);
      const scan = await scanning;
      expect(scan.incomplete).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reports the ledgers neither source covered", async () => {
    vi.useFakeTimers();
    try {
      // the one rpc window never answers, and the partner lags the tip by two
      const { server } = fakeEventsRpc({ ...RPC, events: [], hangAtOrBelow: 95_000 });
      const scanning = scanAllowances(server, USER, 100_000, 120_960, {
        budgetMs: 1_000,
        partner: async () => ({ events: [], throughLedger: 99_998 }),
      });
      await vi.advanceTimersByTimeAsync(1_500);
      const scan = await scanning;
      expect(scan.incomplete).toMatchObject({ reason: "budget" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a partner failure and keeps the rpc result as it was", async () => {
    const recent = approve(99_000, TOKEN, 5n);
    const { server } = fakeEventsRpc({ ...RPC, events: [recent] });
    const scan = await scanAllowances(server, USER, 100_000, 120_960, {
      partner: async () => {
        throw new Error("partner index answered HTTP 503");
      },
    });
    expect(scan.records.map((r) => r.amount)).toEqual([5n]);
    expect(scan.partnerThroughLedger).toBeNull();
    expect(scan.partnerError).toBe("partner index answered HTTP 503");
  });
});

describe("discoverHeldTokens with the partner history index", () => {
  it("probes the tokens the partner says the account holds, beside the scanned ones", async () => {
    const credit: FakeEvent = {
      ledger: 99_500,
      index: 0,
      contractId: TOKEN,
      topic: [sym("transfer"), addr(SPENDER), addr(USER)],
    };
    const { server } = fakeEventsRpc({ ...RPC, events: [credit] });
    balance.mockImplementation(async (_s: unknown, contractId: string) =>
      contractId === OLD_TOKEN ? 42n : 9n,
    );
    const scan = await discoverHeldTokens(server, USER, 100_000, TESTNET, {
      partner: async () => ({ contractIds: [OLD_TOKEN, TOKEN], asOfLedger: 99_990 }),
    });
    expect(new Map(scan.held.map((h) => [h.contractId, h.balance]))).toEqual(
      new Map([
        [TOKEN, 9n],
        [OLD_TOKEN, 42n],
      ]),
    );
    // each candidate read once, even when both sources name it
    expect(balance).toHaveBeenCalledTimes(2);
    expect(scan.partnerAsOfLedger).toBe(99_990);
  });

  it("reports a partner failure and keeps what the scan found", async () => {
    const { server } = fakeEventsRpc({ ...RPC, events: [] });
    const scan = await discoverHeldTokens(server, USER, 100_000, TESTNET, {
      partner: async () => {
        throw new Error("partner index unreachable: timeout");
      },
    });
    expect(scan.held).toEqual([]);
    expect(scan.partnerAsOfLedger).toBeNull();
    expect(scan.partnerError).toBe("partner index unreachable: timeout");
  });
});
