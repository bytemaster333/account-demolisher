import { describe, it, expect } from "vitest";

import { EVENT_RETENTION_WINDOW_LEDGERS, parseRetentionFloor } from "@/lib/soroban/event-retention";

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
