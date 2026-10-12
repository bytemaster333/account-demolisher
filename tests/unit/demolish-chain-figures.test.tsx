// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { TESTNET } from "@/lib/config/networks";

// the latest-ledger read and the delivered-amount read are the network leaves
const net = vi.hoisted(() => ({
  ledgers: null as null | (() => Promise<{ records: Record<string, unknown>[] }>),
  delivered: null as null | (() => Promise<string>),
}));
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({
    ledgers: () => ({ order: () => ({ limit: () => ({ call: () => net.ledgers!() }) }) }),
  }),
}));
vi.mock("@/app/demolish/_lib/receipt", () => ({
  fetchDeliveredXlm: () => net.delivered!(),
}));

import { useBaseReserve, useDeliveredAmount } from "@/app/demolish/_hooks/use-chain-figures";

const DEST = "GDEST";
const HASH = "a".repeat(64);

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the base reserve keeps why it could not be read", () => {
  it("reads the latest ledger's reserve", async () => {
    net.ledgers = async () => ({ records: [{ base_reserve_in_stroops: 5_000_000 }] });
    const { result } = renderHook(() => useBaseReserve(TESTNET, true));
    await waitFor(() => expect(result.current).toEqual({ stroops: 5_000_000, error: null }));
  });

  it("is neither a figure nor an error while it loads", () => {
    net.ledgers = () => new Promise(() => {});
    const { result } = renderHook(() => useBaseReserve(TESTNET, true));
    expect(result.current).toEqual({ stroops: null, error: null });
  });

  it("hands back the failure's message instead of logging it", async () => {
    net.ledgers = async () => {
      throw Object.assign(new Error("Service Unavailable"), { response: { status: 503 } });
    };
    const { result } = renderHook(() => useBaseReserve(TESTNET, true));
    await waitFor(() =>
      expect(result.current).toEqual({ stroops: null, error: "Service Unavailable" }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("says so when the latest ledger carries no reserve", async () => {
    net.ledgers = async () => ({ records: [] });
    const { result } = renderHook(() => useBaseReserve(TESTNET, true));
    await waitFor(() =>
      expect(result.current).toEqual({
        stroops: null,
        error: "Horizon's latest ledger reported no base reserve",
      }),
    );
  });
});

describe("the delivered amount keeps why it could not be read", () => {
  it("hands back the failure's message instead of logging it", async () => {
    net.delivered = async () => {
      throw new Error(`transaction ${HASH} has more effects than expected for a close`);
    };
    const { result } = renderHook(() => useDeliveredAmount(TESTNET, HASH, DEST));
    await waitFor(() =>
      expect(result.current).toEqual({
        status: "unavailable",
        reason: `transaction ${HASH} has more effects than expected for a close`,
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads the amount from the delivering transaction", async () => {
    net.delivered = async () => "120.5";
    const { result } = renderHook(() => useDeliveredAmount(TESTNET, HASH, DEST));
    await waitFor(() => expect(result.current).toEqual({ status: "ok", xlm: "120.5" }));
  });
});
