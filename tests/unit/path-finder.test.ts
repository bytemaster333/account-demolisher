import { describe, it, expect, vi, beforeEach } from "vitest";

// mock horizon so resolveCreditPaths/findPathToXLM don't hit the network
const strictSendPaths = vi.fn();
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({ strictSendPaths }),
}));

import { BadRequestError, NetworkError } from "@stellar/stellar-sdk";
import {
  PATH_REQUEST_ATTEMPTS,
  PATH_REQUEST_CONCURRENCY,
  resolveCreditPaths,
} from "@/lib/stellar/path-finder";
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
describe("resolveCreditPaths: value-destroying-sell floor", () => {
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

function okPage(destAmount: string) {
  return { records: [{ destination_amount: destAmount, source_amount: "1", path: [] }] };
}

function manyCredits(n: number): AccountAudit {
  return {
    balances: Array.from({ length: n }, (_, i) => ({
      asset: { kind: "credit", code: `T${i}`, issuer: ISSUER },
      amount: "10",
    })),
  } as unknown as AccountAudit;
}

// horizon strict-send path search ignores whether the source may send the asset,
// so a frozen balance would get a path that fails with op_src_not_authorized
describe("resolveCreditPaths: frozen trustlines", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not price a positive balance on a deauthorized trustline", async () => {
    pathsReturning("5.0000000");
    const audit = {
      balances: [
        {
          asset: { kind: "credit", code: "FRZ", issuer: ISSUER },
          amount: "100",
          isAuthorized: false,
        },
        {
          asset: { kind: "credit", code: "OK", issuer: ISSUER },
          amount: "100",
          isAuthorized: true,
        },
      ],
    } as unknown as AccountAudit;
    const map = await resolveCreditPaths(audit, TESTNET);
    expect([...map.keys()]).toEqual([`OK:${ISSUER}`]);
    expect(strictSendPaths).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCreditPaths: rate limits and concurrency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries a 429 and succeeds", async () => {
    let calls = 0;
    strictSendPaths.mockReturnValue({
      call: async () => {
        calls += 1;
        if (calls === 1) {
          throw new NetworkError("Too Many Requests", {
            status: 429,
            title: "Rate Limit Exceeded",
          });
        }
        return okPage("3.0000000");
      },
    });
    const map = await resolveCreditPaths(auditWithCredit("USDC", "10"), TESTNET);
    expect(map.size).toBe(1);
    expect(calls).toBe(2);
  });

  it("retries a 5xx whose body is not a horizon problem document", async () => {
    let calls = 0;
    strictSendPaths.mockReturnValue({
      call: async () => {
        calls += 1;
        if (calls === 1) throw new NetworkError("Bad Gateway", "<html>502</html>");
        return okPage("3.0000000");
      },
    });
    const map = await resolveCreditPaths(auditWithCredit("USDC", "10"), TESTNET);
    expect(map.size).toBe(1);
    expect(calls).toBe(2);
  });

  it("does not retry a 400", async () => {
    let calls = 0;
    strictSendPaths.mockReturnValue({
      call: async () => {
        calls += 1;
        throw new BadRequestError("Bad Request", { status: 400, title: "Bad Request" });
      },
    });
    await expect(resolveCreditPaths(auditWithCredit("USDC", "10"), TESTNET)).rejects.toThrow(
      "Bad Request",
    );
    expect(calls).toBe(1);
  });

  it("gives up after a bounded number of attempts and surfaces the error", async () => {
    let calls = 0;
    strictSendPaths.mockReturnValue({
      call: async () => {
        calls += 1;
        throw new NetworkError("Too Many Requests", { status: 429 });
      },
    });
    await expect(resolveCreditPaths(auditWithCredit("USDC", "10"), TESTNET)).rejects.toThrow(
      "Too Many Requests",
    );
    expect(calls).toBe(PATH_REQUEST_ATTEMPTS);
  }, 20_000);

  it("never has more than the pool size of path requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    strictSendPaths.mockReturnValue({
      call: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return okPage("2.0000000");
      },
    });
    const map = await resolveCreditPaths(manyCredits(40), TESTNET);
    expect(map.size).toBe(40);
    expect(peak).toBeLessThanOrEqual(PATH_REQUEST_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});
