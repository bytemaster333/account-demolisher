import { describe, it, expect } from "vitest";

import {
  EVENT_RETENTION_WINDOW_LEDGERS,
  RETENTION_RETRY_MARGIN_LEDGERS,
  parseRetentionFloor,
  scanStartFromHealth,
} from "@/lib/soroban/event-retention";

// the rejection testnet rpc gave on 2026-10-12 for getEvents({ startLedger: 2 }):
// a plain json-rpc error object, not an Error instance
const RPC_RANGE_ERROR = {
  code: -32600,
  message: "startLedger must be within the ledger range: 5033132 - 5154091",
};

describe("parseRetentionFloor", () => {
  it("reads the oldest retained ledger from the rpc's range error", () => {
    expect(parseRetentionFloor(RPC_RANGE_ERROR)).toBe(5_033_132);
  });

  it("reads it from an Error wrapping the rpc error as its cause", () => {
    const wrapped = new Error("getEvents failed", { cause: RPC_RANGE_ERROR });
    expect(parseRetentionFloor(wrapped)).toBe(5_033_132);
  });

  it("reads it from an Error whose own message carries the range", () => {
    expect(parseRetentionFloor(new Error("ledger range: 77 - 99"))).toBe(77);
  });

  it("returns null for any other failure, so the scan does not retry it", () => {
    expect(parseRetentionFloor(new Error("socket hang up"))).toBeNull();
    expect(parseRetentionFloor({ code: -32603, message: "internal error" })).toBeNull();
    expect(parseRetentionFloor("ledger range: 1 - 2")).toBeNull();
    expect(parseRetentionFloor(undefined)).toBeNull();
    expect(parseRetentionFloor(null)).toBeNull();
  });
});

describe("EVENT_RETENTION_WINDOW_LEDGERS", () => {
  it("covers the stock 7-day rpc window at 5 seconds a ledger", () => {
    expect(EVENT_RETENTION_WINDOW_LEDGERS).toBe((7 * 24 * 60 * 60) / 5);
  });
});

describe("scanStartFromHealth", () => {
  const M = RETENTION_RETRY_MARGIN_LEDGERS;

  it("starts a margin above the floor of a host that holds its whole window", () => {
    expect(
      scanStartFromHealth({
        latestLedger: 200_000,
        oldestLedger: 79_041,
        ledgerRetentionWindow: 120_960,
      }),
    ).toBe(79_041 + M);
  });

  it("ignores the floor of a host holding far less than its window", () => {
    // the restarted testnet host of 2026-10-16: 9,792 of 120,960 ledgers
    expect(
      scanStartFromHealth({
        latestLedger: 5_224_703,
        oldestLedger: 5_214_911,
        ledgerRetentionWindow: 120_960,
      }),
    ).toBe(5_224_703 - 120_960 + 1 + M);
  });

  it("never asks below ledger 1 on a network younger than the window", () => {
    expect(
      scanStartFromHealth({ latestLedger: 5_000, oldestLedger: 2, ledgerRetentionWindow: 120_960 }),
    ).toBe(1 + M);
  });

  it("uses the floor when the host reports no window", () => {
    expect(scanStartFromHealth({ latestLedger: 10_000, oldestLedger: 4_000 })).toBe(4_000 + M);
  });
});
