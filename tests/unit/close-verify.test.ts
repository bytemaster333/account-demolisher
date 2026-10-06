import { describe, it, expect, vi } from "vitest";

// the module is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

import { verifyCloseTx, xlmToStroops } from "@/server/close-verify";
import { TESTNET } from "@/lib/config/networks";

const HASH = "a".repeat(64);
const SRC = "GCDDMAWHDVSTLGKYYNOX6FFFDILTASIUBGUP4KHJ4EN6WHPEWMREUXY4";
const DEST = "GBSEFCV4ZJE4LFO72RNMDZQEM5JZMGOI5E5KW7OK7X6CPV6EGXGXQUNO";
const MERGE_ID = "21417185134006275";

// record shapes copied from a real testnet close carrying the marker
// (tx dd05e0450f52bac1168f0bb7897a0628cb4a45f687e84947d99f02bbcdadc821)
const markerSet = {
  id: "21417185134006273",
  type: "manage_data",
  source_account: SRC,
  name: "account-demolisher.close",
  value: "MQ==",
};
const markerDelete = {
  id: "21417185134006274",
  type: "manage_data",
  source_account: SRC,
  name: "account-demolisher.close",
  value: "",
};
const merge = {
  id: MERGE_ID,
  type: "account_merge",
  source_account: SRC,
  account: SRC,
  into: DEST,
};
const mergeEffects = [
  { type: "account_debited", account: SRC, asset_type: "native", amount: "9999.9999700" },
  { type: "account_credited", account: DEST, asset_type: "native", amount: "9999.9999700" },
  { type: "account_removed", account: SRC },
];

interface Fixture {
  tx?: { status: number; body?: unknown };
  ops?: unknown[];
  opsStatus?: number;
  effects?: unknown[];
}

// a mocked Horizon routed by URL, recording every URL it was asked for
function horizon(f: Fixture) {
  const urls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(url);
    const page = (records: unknown[]) =>
      JSON.stringify({ _embedded: { records }, _links: { next: { href: `${url}&cursor=x` } } });
    if (url.includes(`/operations/${MERGE_ID}/effects`)) {
      return new Response(page(f.effects ?? mergeEffects), { status: 200 });
    }
    if (url.includes("/effects")) return new Response(null, { status: 500 });
    if (url.includes("/operations")) {
      if (f.opsStatus !== undefined) return new Response(null, { status: f.opsStatus });
      return new Response(page(f.ops ?? [markerSet, markerDelete, merge]), { status: 200 });
    }
    const tx = f.tx ?? {
      status: 200,
      body: {
        successful: true,
        ledger: 555,
        created_at: "2026-10-02T15:54:32Z",
        source_account: SRC,
      },
    };
    return new Response(tx.body === undefined ? null : JSON.stringify(tx.body), {
      status: tx.status,
    });
  };
  return { fetchImpl, urls };
}

describe("xlmToStroops", () => {
  it("converts decimal XLM to stroops", () => {
    expect(xlmToStroops("1")).toBe(10_000_000n);
    expect(xlmToStroops("12.3456789")).toBe(123_456_789n);
    expect(xlmToStroops("0.0000001")).toBe(1n);
    expect(xlmToStroops("0")).toBe(0n);
  });

  it("throws on anything that isn't a plain amount with at most 7 decimals", () => {
    for (const bad of ["nonsense", "", "1.12345678", "-1", "1e7", "1."]) {
      expect(() => xlmToStroops(bad)).toThrow(/amount/);
    }
  });
});

describe("verifyCloseTx amount parsing", () => {
  it("refuses a close whose merge credit Horizon reports unreadably, instead of counting 0", async () => {
    const { fetchImpl } = horizon({
      effects: [{ type: "account_credited", account: DEST, asset_type: "native", amount: "n/a" }],
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("verifyCloseTx", () => {
  it("accepts a close carrying the marker and reads the merge's own credit", async () => {
    const { fetchImpl, urls } = horizon({});
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.close.ledger).toBe(555);
    expect(res.close.closedAt).toBe(Math.floor(Date.parse("2026-10-02T15:54:32Z") / 1000));
    expect(res.close.reclaimedStroops).toBe("99999999700");
    expect(res.close.ops).toMatchObject({ total: 3, accountMerge: 1 });
    expect(res.close.network).toBe("testnet");
    // effects come from the merge operation, never from the whole transaction
    expect(urls.some((u) => u.includes(`/operations/${MERGE_ID}/effects`))).toBe(true);
    expect(urls.some((u) => u.includes(`/transactions/${HASH}/effects`))).toBe(false);
  });

  it("rejects an unrelated merge without the marker", async () => {
    const { fetchImpl } = horizon({ ops: [merge] });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res).toMatchObject({ ok: false, retryable: false });
    if (!res.ok) expect(res.reason).toMatch(/close marker/);
  });

  it("rejects a marker that is set but never deleted, or carries the wrong value", async () => {
    const setOnly = await verifyCloseTx(TESTNET, HASH, {
      fetchImpl: horizon({ ops: [markerSet, merge] }).fetchImpl,
    });
    expect(setOnly).toMatchObject({ ok: false, retryable: false });
    const wrong = await verifyCloseTx(TESTNET, HASH, {
      fetchImpl: horizon({ ops: [{ ...markerSet, value: "Mg==" }, markerDelete, merge] }).fetchImpl,
    });
    expect(wrong).toMatchObject({ ok: false, retryable: false });
  });

  it("rejects a merge whose source is not the transaction source", async () => {
    const other = "GOTHERACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const { fetchImpl } = horizon({
      ops: [markerSet, markerDelete, { ...merge, account: other, source_account: other }],
    });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });

  it("rejects operation types a close never contains", async () => {
    const { fetchImpl } = horizon({
      ops: [
        markerSet,
        markerDelete,
        { id: "1", type: "invoke_host_function", source_account: SRC },
        merge,
      ],
    });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res).toMatchObject({ ok: false, retryable: false });
    if (!res.ok) expect(res.reason).toMatch(/invoke_host_function/);
  });

  it("counts only the merge credit, not other native credits to the destination", async () => {
    const payment = {
      id: "21417185134006272",
      type: "payment",
      source_account: SRC,
      to: DEST,
      asset_type: "native",
      amount: "50",
    };
    const { fetchImpl } = horizon({ ops: [payment, markerSet, markerDelete, merge] });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.close.reclaimedStroops).toBe("99999999700");
  });

  it("rejects a transaction that did not succeed (not retryable)", async () => {
    const { fetchImpl } = horizon({ tx: { status: 200, body: { successful: false, ledger: 1 } } });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });

  it("treats a 404 as a definitive not-found (not retryable)", async () => {
    const { fetchImpl } = horizon({ tx: { status: 404 } });
    const res = await verifyCloseTx(TESTNET, HASH, { fetchImpl });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });

  it("fails closed and retryable when Horizon 5xxs or the request throws", async () => {
    const five = await verifyCloseTx(TESTNET, HASH, {
      fetchImpl: horizon({ tx: { status: 503 } }).fetchImpl,
    });
    expect(five).toMatchObject({ ok: false, retryable: true });

    const opsDown = await verifyCloseTx(TESTNET, HASH, {
      fetchImpl: horizon({ opsStatus: 502 }).fetchImpl,
    });
    expect(opsDown).toMatchObject({ ok: false, retryable: true });

    const threw = await verifyCloseTx(TESTNET, HASH, {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(threw).toMatchObject({ ok: false, retryable: true });
  });
});
