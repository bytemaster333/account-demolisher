import { describe, it, expect, vi, beforeEach } from "vitest";

// mock the SEP-41 balance probe so the discovery logic is tested without a network
const balance = vi.fn();
vi.mock("@/lib/soroban/sep41", () => ({
  balance: (...args: unknown[]) => balance(...args),
}));

import { discoverHeldTokens, scanTokensCreditedTo } from "@/lib/soroban/held-tokens";
import { TESTNET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

// an rpc getEvents event whose contractId resolves to the given strkey
function ev(contractId: string) {
  return { contractId: { contractId: () => contractId } };
}

function serverWithEvents(pages: Array<{ events: unknown[]; cursor: string | undefined }>) {
  let call = 0;
  return {
    getEvents: vi.fn(async () => {
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return { events: page.events, cursor: page.cursor };
    }),
  } as never;
}

beforeEach(() => {
  balance.mockReset();
});

describe("held-token discovery (SEP-41 standalone-token drain)", () => {
  it("scanTokensCreditedTo returns the DISTINCT emitting token contracts", async () => {
    const server = serverWithEvents([
      { events: [ev("CA"), ev("CB"), ev("CA")], cursor: undefined },
    ]);
    const ids = await scanTokensCreditedTo(server, USER, 1000);
    expect(new Set(ids)).toEqual(new Set(["CA", "CB"]));
  });

  it("follows the cursor across pages", async () => {
    const server = serverWithEvents([
      { events: [ev("CA")], cursor: "page2" },
      { events: [ev("CB")], cursor: undefined },
    ]);
    const ids = await scanTokensCreditedTo(server, USER, 1000);
    expect(new Set(ids)).toEqual(new Set(["CA", "CB"]));
  });

  it("discoverHeldTokens keeps positive balances, drops zero, reports reverting tokens as unreadable", async () => {
    const server = serverWithEvents([
      { events: [ev("CA"), ev("CB"), ev("CC")], cursor: undefined },
    ]);
    balance.mockImplementation(async (_s: unknown, contractId: string) => {
      if (contractId === "CA") return 500n;
      if (contractId === "CB") return 0n;
      throw new Error("CC.balance() reverted (hostile/broken token)");
    });
    const scan = await discoverHeldTokens(server, USER, 1000, TESTNET);
    // CA has a positive balance; CB is zero (nothing to hold); CC reverts and is
    // surfaced as unreadable rather than silently dropped.
    expect(scan.held).toEqual([{ contractId: "CA", balance: 500n }]);
    expect(scan.unreadable).toEqual(["CC"]);
  });

  it("rejects a non-positive currentLedger", async () => {
    await expect(scanTokensCreditedTo(serverWithEvents([]), USER, 0)).rejects.toThrow(RangeError);
  });

  it("time-boxes each probe: a token whose balance() hangs is unreadable, not a stall", async () => {
    vi.useFakeTimers();
    try {
      const server = serverWithEvents([{ events: [ev("CA"), ev("CB")], cursor: undefined }]);
      balance.mockImplementation(async (_s: unknown, contractId: string) => {
        if (contractId === "CA") return 500n;
        return new Promise<bigint>(() => {}); // CB hangs forever
      });
      const promise = discoverHeldTokens(server, USER, 1000, TESTNET);
      // advance past the per-probe timeout so the hanging probe rejects
      await vi.advanceTimersByTimeAsync(9_000);
      const scan = await promise;
      // the healthy token is kept; the hanging one is surfaced as unreadable and
      // never blocks completion (the whole scan would otherwise stall on it)
      expect(scan.held).toEqual([{ contractId: "CA", balance: 500n }]);
      expect(scan.unreadable).toEqual(["CB"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
