import { describe, it, expect, vi } from "vitest";

// the module is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

import { verifyCloseTx, xlmToStroops } from "@/server/close-verify";
import { TESTNET } from "@/lib/config/networks";

const HASH = "a".repeat(64);

// route a mocked Horizon by URL suffix
function mockHorizon(map: {
  tx?: { status: number; body?: unknown };
  ops?: { status: number; body?: unknown };
  effects?: { status: number; body?: unknown };
}) {
  return async (url: string): Promise<Response> => {
    const pick = url.includes("/operations")
      ? map.ops
      : url.includes("/effects")
        ? map.effects
        : map.tx;
    const status = pick?.status ?? 200;
    const body = pick?.body === undefined ? null : JSON.stringify(pick.body);
    return new Response(body, { status });
  };
}

describe("xlmToStroops", () => {
  it("converts decimal XLM to stroops", () => {
    expect(xlmToStroops("1")).toBe(10_000_000n);
    expect(xlmToStroops("12.3456789")).toBe(123_456_789n);
    expect(xlmToStroops("0.0000001")).toBe(1n);
    expect(xlmToStroops("0")).toBe(0n);
    expect(xlmToStroops("nonsense")).toBe(0n);
  });
});

describe("verifyCloseTx", () => {
  it("accepts a successful account_merge and derives reclaimed XLM + op counts", async () => {
    const fetchImpl = mockHorizon({
      tx: { status: 200, body: { successful: true, ledger: 555, created_at: "2026-07-30T12:00:00Z" } },
      ops: {
        status: 200,
        body: {
          _embedded: {
            records: [
              { type: "account_merge", into: "GDEST" },
              { type: "change_trust" },
              { type: "invoke_host_function" },
            ],
          },
        },
      },
      effects: {
        status: 200,
        body: {
          _embedded: {
            records: [
              { type: "account_credited", account: "GDEST", asset_type: "native", amount: "12.3456789" },
              { type: "account_removed", account: "GSRC" },
            ],
          },
        },
      },
    });

    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.close.ledger).toBe(555);
    expect(res.close.closedAt).toBe(Math.floor(Date.parse("2026-07-30T12:00:00Z") / 1000));
    expect(res.close.reclaimedStroops).toBe("123456789");
    expect(res.close.ops).toMatchObject({ total: 3, accountMerge: 1, changeTrust: 1, invokeHostFunction: 1 });
    expect(res.close.network).toBe("testnet");
  });

  it("ignores native credits to accounts other than the merge destination", async () => {
    const fetchImpl = mockHorizon({
      tx: { status: 200, body: { successful: true, ledger: 1, created_at: "2026-07-30T12:00:00Z" } },
      ops: { status: 200, body: { _embedded: { records: [{ type: "account_merge", into: "GDEST" }] } } },
      effects: {
        status: 200,
        body: {
          _embedded: {
            records: [
              { type: "account_credited", account: "GOTHER", asset_type: "native", amount: "9.0" },
              { type: "account_credited", account: "GDEST", asset_type: "native", amount: "2.0" },
            ],
          },
        },
      },
    });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.close.reclaimedStroops).toBe("20000000");
  });

  it("rejects a transaction that did not succeed (not retryable)", async () => {
    const fetchImpl = mockHorizon({ tx: { status: 200, body: { successful: false, ledger: 1 } } });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });

  it("rejects a transaction with no account_merge (not retryable)", async () => {
    const fetchImpl = mockHorizon({
      tx: { status: 200, body: { successful: true, ledger: 1, created_at: "2026-07-30T12:00:00Z" } },
      ops: { status: 200, body: { _embedded: { records: [{ type: "payment" }] } } },
      effects: { status: 200, body: { _embedded: { records: [] } } },
    });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res).toMatchObject({ ok: false, retryable: false });
    if (!res.ok) expect(res.reason).toMatch(/account_merge/);
  });

  it("treats a 404 as a definitive not-found (not retryable)", async () => {
    const fetchImpl = mockHorizon({ tx: { status: 404 } });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });

  it("fails CLOSED and retryable when Horizon 5xxs or the request throws", async () => {
    const five = await verifyCloseTx(TESTNET, HASH, { fetchImpl: mockHorizon({ tx: { status: 503 } }) });
    expect(five).toMatchObject({ ok: false, retryable: true });

    const threw = await verifyCloseTx(TESTNET, HASH, {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(threw).toMatchObject({ ok: false, retryable: true });
  });
});
