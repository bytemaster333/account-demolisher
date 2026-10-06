import { describe, it, expect } from "vitest";
import {
  Account,
  Contract,
  SorobanDataBuilder,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import { MAINNET } from "@/lib/config/networks";
import {
  SOROBAN_RESOURCE_FEE_CAPS,
  SorobanFeeCapError,
  assertSorobanFeeWithinCap,
  formatXlm,
  sorobanFeeBreakdown,
} from "@/lib/soroban/fee-cap";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";

// a tx assembled by the sdk's own assembleTransaction from a simulation that
// reports `resourceFee` and declares `writeBytes` / `rwEntries`
function prepared(resourceFee: bigint, writeBytes = 500, rwEntries = 2) {
  const raw = new TransactionBuilder(new Account(USER, "7"), {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: MAINNET.passphrase,
  })
    .addOperation(new Contract(POOL).call("submit"))
    .setTimeout(300)
    .build();
  const rw = Array.from({ length: rwEntries }, (_, i) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Contract(POOL).address().toScAddress(),
        key: xdr.ScVal.scvU32(i),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  const data = new SorobanDataBuilder()
    .setResourceFee(resourceFee)
    .setResources(1_000_000, 0, writeBytes)
    .setReadWrite(rw);
  return rpc
    .assembleTransaction(raw, {
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      minResourceFee: resourceFee.toString(),
      transactionData: data,
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    })
    .build();
}

describe("soroban fee cap", () => {
  it("counts the simulated resource fee once on top of the inclusion bid", () => {
    const b = sorobanFeeBreakdown(prepared(167_250n));
    expect(b.totalFee).toBe(100_000n + 167_250n);
    expect(b.resourceFee).toBe(167_250n);
  });

  it("passes measured legitimate fees for both classes", () => {
    expect(() =>
      assertSorobanFeeWithinCap(prepared(454_439n, 368), "untrusted-token"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(167_250n, 12_184, 16), "defi-exit"),
    ).not.toThrow();
  });

  it("refuses a fee over the class cap, naming the amount", () => {
    const over = SOROBAN_RESOURCE_FEE_CAPS["defi-exit"] + 1n;
    const err = (() => {
      try {
        assertSorobanFeeWithinCap(prepared(over), "defi-exit");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SorobanFeeCapError);
    expect((err as Error).message).toMatch(/0\.5100001 XLM/);
  });

  it("bounds what an untrusted token may write, not only what it costs", () => {
    expect(() => assertSorobanFeeWithinCap(prepared(20_000n, 9_000), "untrusted-token")).toThrow(
      /9000 bytes/,
    );
    expect(() => assertSorobanFeeWithinCap(prepared(20_000n, 500, 17), "untrusted-token")).toThrow(
      /17 ledger entries/,
    );
    // the same declared size is fine for an allow-listed exit
    expect(() =>
      assertSorobanFeeWithinCap(prepared(20_000n, 9_000, 17), "defi-exit"),
    ).not.toThrow();
  });

  it("refuses a tx that was never prepared", () => {
    const raw = new TransactionBuilder(new Account(USER, "7"), {
      fee: "100",
      networkPassphrase: MAINNET.passphrase,
    })
      .addOperation(new Contract(POOL).call("submit"))
      .setTimeout(300)
      .build();
    expect(() => assertSorobanFeeWithinCap(raw, "defi-exit")).toThrow(/not prepared/);
  });

  it("formats stroops as XLM", () => {
    expect(formatXlm(10_000_000n)).toBe("1");
    expect(formatXlm(115_929n)).toBe("0.0115929");
    expect(formatXlm(5_000_000n)).toBe("0.5");
  });
});
