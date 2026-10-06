import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

// mock the SEP-41 balance probe so the discovery logic is tested without a network
const balance = vi.fn();
vi.mock("@/lib/soroban/sep41", () => ({
  balance: (...args: unknown[]) => balance(...args),
}));

import {
  discoverHeldTokens,
  heldTokenScanWarning,
  scanTokensCreditedTo,
} from "@/lib/soroban/held-tokens";
import { TESTNET } from "@/lib/config/networks";
import { addr, fakeEventsRpc, sym, type FakeEvent } from "./event-scan-fake-rpc";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const OTHER = "GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN";
const CA = StrKey.encodeContract(Buffer.alloc(32, 1));
const CB = StrKey.encodeContract(Buffer.alloc(32, 2));
const CC = StrKey.encodeContract(Buffer.alloc(32, 3));
const SAC = StrKey.encodeContract(Buffer.alloc(32, 4));

let n = 0;
const transferTo = (contractId: string, ledger: number, to = USER): FakeEvent => ({
  ledger,
  index: n++,
  contractId,
  topic: [sym("transfer"), addr(OTHER), addr(to)],
});
const mintTo = (contractId: string, ledger: number): FakeEvent => ({
  ledger,
  index: n++,
  contractId,
  topic: [sym("mint"), addr(USER)],
});
const legacyMintTo = (contractId: string, ledger: number): FakeEvent => ({
  ledger,
  index: n++,
  contractId,
  topic: [sym("mint"), addr(OTHER), addr(USER)],
});

function rpcWith(events: FakeEvent[], extra: Partial<Parameters<typeof fakeEventsRpc>[0]> = {}) {
  return fakeEventsRpc({ oldestLedger: 1, latestLedger: 10_000, events, ...extra });
}

beforeEach(() => {
  balance.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("held-token discovery (SEP-41 standalone-token drain)", () => {
  it("returns the DISTINCT token contracts that credited the account", async () => {
    const { server } = rpcWith([transferTo(CA, 100), transferTo(CB, 5_000), transferTo(CA, 9_000)]);
    const { contractIds, incomplete } = await scanTokensCreditedTo(server, USER, 10_000);
    expect(new Set(contractIds)).toEqual(new Set([CA, CB]));
    expect(incomplete).toBeNull();
  });

  it("finds tokens credited by mint, in the current and the older topic layout", async () => {
    const { server } = rpcWith([mintTo(CA, 200), legacyMintTo(CB, 300)]);
    const { contractIds } = await scanTokensCreditedTo(server, USER, 10_000);
    expect(new Set(contractIds)).toEqual(new Set([CA, CB]));
  });

  it("leaves out stellar asset contract transfers (four topics) and credits to others", async () => {
    const sacTransfer: FakeEvent = {
      ledger: 400,
      index: n++,
      contractId: SAC,
      topic: [sym("transfer"), addr(OTHER), addr(USER), sym("USDC")],
    };
    const { server } = rpcWith([sacTransfer, transferTo(CC, 500, OTHER)]);
    const { contractIds } = await scanTokensCreditedTo(server, USER, 10_000);
    expect(contractIds).toEqual([]);
  });

  it("scans in bounded windows the host accepts when a wide request hits its processing limit", async () => {
    const { server, requests } = rpcWith([transferTo(CA, 150), transferTo(CB, 9_990)], {
      maxCheapWindow: 300,
    });
    const { contractIds, incomplete } = await scanTokensCreditedTo(server, USER, 10_000);
    expect(new Set(contractIds)).toEqual(new Set([CA, CB]));
    expect(incomplete).toBeNull();
    expect(requests.every((r) => r.endLedger !== undefined)).toBe(true);
  });

  it("returns the tokens found so far with an incomplete flag when the budget runs out", async () => {
    vi.useFakeTimers();
    const { server } = rpcWith([transferTo(CA, 9_500), transferTo(CB, 20)], { latencyMs: 1_000 });
    balance.mockResolvedValue(7n);
    const scan = discoverHeldTokens(server, USER, 10_000, TESTNET, { budgetMs: 2_500 });
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await scan;
    expect(res.held).toEqual([{ contractId: CA, balance: 7n }]);
    expect(res.incomplete).toMatchObject({ reason: "budget", lastLedger: 10_000 });
    expect(heldTokenScanWarning(res.incomplete!)).toMatch(
      /only the most recent about \d+ hours of history because it ran out of time/,
    );
  });

  it("keeps positive balances, drops zero, reports reverting tokens as unreadable", async () => {
    const { server } = rpcWith([transferTo(CA, 110), transferTo(CB, 120), transferTo(CC, 130)]);
    balance.mockImplementation(async (_s: unknown, contractId: string) => {
      if (contractId === CA) return 500n;
      if (contractId === CB) return 0n;
      throw new Error("CC.balance() reverted (hostile/broken token)");
    });
    const scan = await discoverHeldTokens(server, USER, 10_000, TESTNET);
    expect(scan.held).toEqual([{ contractId: CA, balance: 500n }]);
    expect(scan.unreadable).toEqual([CC]);
    expect(scan.incomplete).toBeNull();
  });

  it("rejects a non-positive currentLedger", async () => {
    await expect(scanTokensCreditedTo(rpcWith([]).server, USER, 0)).rejects.toThrow(RangeError);
  });

  it("time-boxes each probe: a token whose balance() hangs is unreadable, not a stall", async () => {
    vi.useFakeTimers();
    const { server } = rpcWith([transferTo(CA, 110), transferTo(CB, 120)]);
    balance.mockImplementation(async (_s: unknown, contractId: string) => {
      if (contractId === CA) return 500n;
      return new Promise<bigint>(() => {}); // CB hangs forever
    });
    const promise = discoverHeldTokens(server, USER, 10_000, TESTNET);
    // advance past the per-probe timeout so the hanging probe rejects
    await vi.advanceTimersByTimeAsync(9_000);
    const scan = await promise;
    expect(scan.held).toEqual([{ contractId: CA, balance: 500n }]);
    expect(scan.unreadable).toEqual([CB]);
  });
});
