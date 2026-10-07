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
    // the full-size and reference quotes for OK only
    expect(strictSendPaths).toHaveBeenCalledTimes(2);
    expect(strictSendPaths.mock.calls.every((c) => (c[0] as { code: string }).code === "OK")).toBe(
      true,
    );
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
    // the failed attempt, its retry, then the reference quote
    expect(calls).toBe(3);
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
    expect(calls).toBe(3);
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

// the batcher measures price impact against a small reference trade through the
// same market; without it every conversion is unpriced and blocked
describe("resolveCreditPaths: reference quote", () => {
  beforeEach(() => vi.clearAllMocks());

  // full-size and reference quotes answered per requested source amount
  function quotesBy(byAmount: Record<string, string | null>): void {
    strictSendPaths.mockImplementation((_asset: unknown, amount: string) => ({
      call: async () => {
        const dest = byAmount[amount];
        if (dest === undefined) throw new Error(`unexpected quote amount ${amount}`);
        return {
          records:
            dest === null ? [] : [{ destination_amount: dest, source_amount: amount, path: [] }],
        };
      },
    }));
  }

  it("quotes a 1/1000 slice of the balance and attaches it as the reference", async () => {
    quotesBy({ "1000": "3694.0000000", "1.0000000": "4.4160000" });
    const map = await resolveCreditPaths(auditWithCredit("USDC", "1000"), TESTNET);
    const ref = map.get(`USDC:${ISSUER}`);
    expect(ref?.sourceAmount).toBe("1000");
    expect(ref?.destinationAmount).toBe("3694.0000000");
    expect(ref?.reference).toEqual({ sourceAmount: "1.0000000", destinationAmount: "4.4160000" });
    expect(strictSendPaths.mock.calls.map((c) => c[1])).toEqual(["1000", "1.0000000"]);
  });

  it("uses one stroop as the slice of a balance under 1000 stroops", async () => {
    quotesBy({ "0.0000500": "0.0000400", "0.0000001": "0.0000001" });
    const map = await resolveCreditPaths(auditWithCredit("TINY", "0.0000500"), TESTNET);
    expect(map.get(`TINY:${ISSUER}`)?.reference?.sourceAmount).toBe("0.0000001");
  });

  it("leaves the reference unset when the slice has no path", async () => {
    quotesBy({ "500": "40.0000000", "0.5000000": null });
    const map = await resolveCreditPaths(auditWithCredit("THIN", "500"), TESTNET);
    const ref = map.get(`THIN:${ISSUER}`);
    expect(ref).toBeDefined();
    expect(ref?.reference).toBeUndefined();
  });

  it("does not quote a reference for an asset with no full-size path", async () => {
    quotesBy({ "7": null });
    const map = await resolveCreditPaths(auditWithCredit("NOPATH", "7"), TESTNET);
    expect(map.size).toBe(0);
    expect(strictSendPaths).toHaveBeenCalledTimes(1);
  });

  it("throws on a malformed horizon amount instead of reading it as zero", async () => {
    quotesBy({ "10": "12.34567891" });
    await expect(resolveCreditPaths(auditWithCredit("BAD", "10"), TESTNET)).rejects.toThrow(
      /malformed amount/,
    );
  });
});

// a claimed credit is sold together with the balance it lands on, and an asset
// collected into a trustline the close opens has no balance line in the audit
// yet, so each asset is quoted at what the close will actually hold
describe("resolveCreditPaths: claims the close makes", () => {
  beforeEach(() => vi.clearAllMocks());

  const ACCOUNT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

  function quoteAny(): void {
    strictSendPaths.mockImplementation((_asset: unknown, amount: string) => ({
      call: async () => ({
        records: [{ destination_amount: "5.0000000", source_amount: amount, path: [] }],
      }),
    }));
  }

  function cb(id: string, asset: unknown, amount: string) {
    return { id, asset, amount, sponsor: "", predicate: [], claimants: [ACCOUNT] };
  }

  function auditWithClaims(): AccountAudit {
    return {
      accountId: ACCOUNT,
      balances: [
        { asset: { kind: "native" }, amount: "50" },
        { asset: { kind: "credit", code: "USDC", issuer: ISSUER }, amount: "100.0000000" },
        {
          asset: { kind: "credit", code: "FRZ", issuer: ISSUER },
          amount: "0",
          isAuthorized: false,
        },
      ],
      claimableBalances: [
        cb("usdc-1", { kind: "credit", code: "USDC", issuer: ISSUER }, "30"),
        cb("usdc-2", { kind: "credit", code: "USDC", issuer: ISSUER }, "20.5"),
        cb("new-1", { kind: "credit", code: "NEW", issuer: ISSUER }, "7"),
        cb("unclaimed", { kind: "credit", code: "SKIP", issuer: ISSUER }, "9"),
        cb("xlm", { kind: "native" }, "11"),
        cb("own", { kind: "credit", code: "OWN", issuer: ACCOUNT }, "3"),
        cb("frozen", { kind: "credit", code: "FRZ", issuer: ISSUER }, "4"),
      ],
    } as unknown as AccountAudit;
  }

  const quotedCodes = () => strictSendPaths.mock.calls.map((c) => (c[0] as { code: string }).code);

  it("prices a balance plus the claims landing on it", async () => {
    quoteAny();
    const map = await resolveCreditPaths(auditWithClaims(), TESTNET, {
      claimedBalanceIds: ["usdc-1", "usdc-2"],
    });
    expect(map.get(`USDC:${ISSUER}`)?.sourceAmount).toBe("150.5000000");
    expect(map.get(`USDC:${ISSUER}`)?.reference?.sourceAmount).toBe("0.1505000");
  });

  it("prices an asset collected into a trustline the close opens", async () => {
    quoteAny();
    const map = await resolveCreditPaths(auditWithClaims(), TESTNET, {
      claimedBalanceIds: ["new-1"],
    });
    expect(map.get(`NEW:${ISSUER}`)?.sourceAmount).toBe("7.0000000");
    // the balance with no claim keeps its own amount
    expect(map.get(`USDC:${ISSUER}`)?.sourceAmount).toBe("100.0000000");
  });

  it("ignores unclaimed, native, own-asset and frozen-line claims", async () => {
    quoteAny();
    const map = await resolveCreditPaths(auditWithClaims(), TESTNET, {
      claimedBalanceIds: ["xlm", "own", "frozen"],
    });
    expect([...map.keys()]).toEqual([`USDC:${ISSUER}`]);
    expect(map.get(`USDC:${ISSUER}`)?.sourceAmount).toBe("100.0000000");
    expect(new Set(quotedCodes())).toEqual(new Set(["USDC"]));
  });

  it("refuses a claimed id the audit does not hold", async () => {
    quoteAny();
    await expect(
      resolveCreditPaths(auditWithClaims(), TESTNET, { claimedBalanceIds: ["gone"] }),
    ).rejects.toThrow(/gone/);
  });
});
