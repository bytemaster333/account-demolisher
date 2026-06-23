import { describe, it, expect, vi } from "vitest";
import type { rpc } from "@stellar/stellar-sdk";
import { enumerateAllowances } from "@/lib/soroban/allowances";

// A valid ed25519 public key — enumerateAllowances runs it through Address(),
// which rejects anything malformed.
const USER = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";

// The Soroban RPC rejects an out-of-window startLedger with a plain
// `{ code, message }` object (not an Error), e.g.
// "startLedger must be within the ledger range: 1000 - 2000".
function rangeError(floor: number, ceil: number): { code: number; message: string } {
  return {
    code: -32600,
    message: `startLedger must be within the ledger range: ${floor} - ${ceil}`,
  };
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
});
