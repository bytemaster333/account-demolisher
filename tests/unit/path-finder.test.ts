import { describe, it, expect, vi, beforeEach } from "vitest";

// mock horizon so resolveCreditPaths/findPathToXLM don't hit the network
const strictSendPaths = vi.fn();
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({ strictSendPaths }),
}));

import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { TESTNET } from "@/lib/config/networks";
import type { AccountAudit } from "@/lib/types/account";

const ISSUER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function auditWithCredit(code: string, amount: string): AccountAudit {
  return {
    balances: [{ asset: { kind: "credit", code, issuer: ISSUER }, amount }],
  } as unknown as AccountAudit;
}

// mock strictSendPaths(...).call() to yield a single best path with the given
// XLM destination amount, or no path when destAmount is null.
function pathsReturning(destAmount: string | null): void {
  strictSendPaths.mockReturnValue({
    call: async () => ({
      records:
        destAmount === null
          ? []
          : [{ destination_amount: destAmount, source_amount: "1000", path: [] }],
    }),
  });
}

// resolveCreditPaths now drops a value-destroying path so the asset falls through
// to the issuer/destination disposal instead of being sold for ~nothing.
describe("resolveCreditPaths — value-destroying-sell floor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS;
  });

  it("keeps a healthy market path", async () => {
    pathsReturning("12.3456789"); // ~12 XLM out
    const map = await resolveCreditPaths(auditWithCredit("USDC", "100"), TESTNET);
    expect(map.size).toBe(1);
  });

  it("DROPS a dust path that nets nothing after the haircut (value-destroying)", async () => {
    // 1 stroop out -> applySlippageMin(1, 100) == 0 -> refused; the whole balance
    // would otherwise be sold for ~nothing.
    pathsReturning("0.0000001");
    const map = await resolveCreditPaths(auditWithCredit("SCAMCOIN", "1000"), TESTNET);
    expect(map.size).toBe(0);
  });

  it("DROPS below a configured absolute floor", async () => {
    process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS = "20000000"; // 2 XLM
    pathsReturning("1.0000000"); // 1 XLM out < 2 XLM floor
    const map = await resolveCreditPaths(auditWithCredit("THINPAIR", "500"), TESTNET);
    expect(map.size).toBe(0);
  });

  it("drops when there is no market path at all", async () => {
    pathsReturning(null);
    const map = await resolveCreditPaths(auditWithCredit("NOPATH", "1"), TESTNET);
    expect(map.size).toBe(0);
  });
});
