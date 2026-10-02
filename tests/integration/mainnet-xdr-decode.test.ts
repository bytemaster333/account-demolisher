import { describe, it, expect } from "vitest";
import { Horizon, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { getRpc } from "@/lib/soroban/rpc-client";
import { MAINNET } from "@/lib/config/networks";

// mainnet can run a newer protocol than the one the pinned stellar sdk's release
// notes name, so check the sdk against what mainnet produces right now. every
// value is decoded and re-encoded: a decoder that misread a new union arm or field
// would fail to parse or would not round-trip to the same bytes.

function roundTrips<T extends { toXdr(format: "base64"): string }>(
  type: { fromXdr(input: string, format: "base64"): T },
  b64: string,
): boolean {
  return type.fromXdr(b64, "base64").toXdr("base64") === b64;
}

describe("integration: the stellar sdk decodes current mainnet xdr", () => {
  it("round-trips recent rpc envelopes, results and result metas", async () => {
    const server = getRpc(MAINNET);
    const latest = await server.getLatestLedger();
    const raw = await server._getTransactions({
      startLedger: latest.sequence - 5,
      pagination: { limit: 100 },
    });
    const txs = raw.transactions ?? [];
    expect(txs.length).toBeGreaterThan(0);

    let metas = 0;
    for (const tx of txs) {
      expect(roundTrips(xdr.TransactionEnvelope, tx.envelopeXdr!)).toBe(true);
      expect(roundTrips(xdr.TransactionResult, tx.resultXdr!)).toBe(true);
      if (tx.resultMetaXdr) {
        expect(roundTrips(xdr.TransactionMeta, tx.resultMetaXdr)).toBe(true);
        metas += 1;
      }
    }
    expect(metas).toBeGreaterThan(0);

    // the sdk's own parsed path (what pollTransaction and getTransaction use) must
    // accept the same window without throwing
    const parsed = await server.getTransactions({
      startLedger: latest.sequence - 5,
      pagination: { limit: 100 },
    });
    expect(parsed.transactions.length).toBe(txs.length);
  });

  it("parses recent horizon envelopes and results into sdk transactions", async () => {
    const horizon = new Horizon.Server(MAINNET.horizon, { allowHttp: false });
    const page = await horizon.transactions().order("desc").limit(100).call();
    expect(page.records.length).toBeGreaterThan(0);

    for (const record of page.records) {
      const tx = TransactionBuilder.fromXdr(record.envelope_xdr, MAINNET.passphrase);
      expect(tx.toEnvelope().toXdr("base64")).toBe(record.envelope_xdr);
      expect(roundTrips(xdr.TransactionResult, record.result_xdr)).toBe(true);
    }
  });
});
