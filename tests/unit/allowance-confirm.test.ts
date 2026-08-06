import { describe, it, expect, vi, beforeEach } from "vitest";

// control the on-chain allowance() read; keep buildApprove (used by buildRevoke).
const allowanceFn = vi.fn();
vi.mock("@/lib/soroban/sep41", () => ({
  allowance: (...a: unknown[]) => allowanceFn(...a),
  buildApprove: vi.fn(),
}));

import {
  allowanceAmountMismatch,
  confirmAllowancesOnChain,
  type AllowanceRecord,
} from "@/lib/soroban/allowances";
import { TESTNET } from "@/lib/config/networks";
import type { rpc } from "@stellar/stellar-sdk";

function rec(over: Partial<AllowanceRecord> = {}): AllowanceRecord {
  return {
    contractId: "CTOKEN",
    spender: "SSPENDER",
    amount: 100n,
    live_until_ledger: 0,
    lastSeenLedger: 0,
    expired: false,
    ...over,
  };
}

describe("confirmAllowancesOnChain + allowanceAmountMismatch (accuracy check)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("annotates each record with the on-chain amount", async () => {
    allowanceFn.mockResolvedValue({ amount: 100n, live_until_ledger: 0 });
    const [c] = await confirmAllowancesOnChain(
      {} as rpc.Server,
      "GOWNER",
      [rec()],
      TESTNET,
      "GSIMSOURCE",
    );
    expect(c!.onChainAmount).toBe(100n);
    expect(allowanceAmountMismatch(c!)).toBe(false);
  });

  it("flags a mismatch when a fabricated/stale event amount differs from on-chain", async () => {
    allowanceFn.mockResolvedValue({ amount: 0n, live_until_ledger: 0 }); // real allowance is 0
    const [c] = await confirmAllowancesOnChain(
      {} as rpc.Server,
      "GOWNER",
      [rec({ amount: 999n })], // event claimed 999
      TESTNET,
      "GSIMSOURCE",
    );
    expect(c!.onChainAmount).toBe(0n);
    expect(allowanceAmountMismatch(c!)).toBe(true);
  });

  it("marks onChainAmount null (unconfirmed) when the read fails, and that is NOT a mismatch", async () => {
    allowanceFn.mockRejectedValue(new Error("rpc down"));
    const [c] = await confirmAllowancesOnChain(
      {} as rpc.Server,
      "GOWNER",
      [rec()],
      TESTNET,
      "GSIMSOURCE",
    );
    expect(c!.onChainAmount).toBeNull();
    expect(allowanceAmountMismatch(c!)).toBe(false);
  });

  it("passes the owner as `from` and the sim source separately to allowance()", async () => {
    allowanceFn.mockResolvedValue({ amount: 1n, live_until_ledger: 0 });
    await confirmAllowancesOnChain({} as rpc.Server, "GOWNER", [rec()], TESTNET, "GSIMSOURCE");
    expect(allowanceFn).toHaveBeenCalledWith(
      expect.anything(),
      "CTOKEN",
      "GOWNER", // from = the viewed owner address
      "SSPENDER",
      "GSIMSOURCE", // simulation source (any valid G-address)
      TESTNET,
    );
  });
});
