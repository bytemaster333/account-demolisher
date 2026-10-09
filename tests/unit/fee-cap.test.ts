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

  it("passes measured legitimate fees for every class", () => {
    expect(() =>
      assertSorobanFeeWithinCap(prepared(454_439n, 368), "untrusted-token"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(167_250n, 12_184, 16), "defi-exit"),
    ).not.toThrow();
    // the largest cases in the fee-cap.ts header, each with the resources its
    // simulation declared. a revoke that restores the token's archived instance
    // (mainnet CLPX):
    expect(() =>
      assertSorobanFeeWithinCap(prepared(936_287n, 476, 1), "untrusted-token"),
    ).not.toThrow();
    // a one-hop convert through archived testnet pairs, restoring 8 entries:
    expect(() =>
      assertSorobanFeeWithinCap(prepared(5_308_082n, 3_128, 10), "untrusted-convert"),
    ).not.toThrow();
    // a soroswap lp exit, which the executor classes as untrusted-convert because
    // a pair can hold any token, through archived and idle mainnet pairs:
    expect(() =>
      assertSorobanFeeWithinCap(prepared(2_956_310n, 1_792, 8), "untrusted-convert"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(2_432_473n, 2_212, 9), "untrusted-convert"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(6_923_446n, 1_904, 9), "untrusted-convert"),
    ).not.toThrow();
    // allow-listed exits for idle mainnet accounts whose entries were archived:
    // an aquarius stable-pool withdraw and claim that restore reward pages, and a
    // blend withdraw
    expect(() =>
      assertSorobanFeeWithinCap(prepared(15_993_759n, 10_564, 12), "defi-exit"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(16_305_049n, 9_812, 9), "defi-exit"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(11_763_314n, 2_556, 9), "defi-exit"),
    ).not.toThrow();
    // the largest archived YieldBloxV2 withdraw_collateral (mainnet 2026-10-07)
    expect(() =>
      assertSorobanFeeWithinCap(prepared(1_060_719n, 1_336, 5), "defi-exit"),
    ).not.toThrow();
  });

  // aquarius standard, stable and concentrated pools are permissionless, so their
  // exits run token code nobody vetted. measured on mainnet 2026-10-06/07.
  it("passes measured legitimate exits through permissionless pools", () => {
    // router withdraw and claim restoring archived reward pages (pool CDRRLX)
    expect(() =>
      assertSorobanFeeWithinCap(prepared(15_993_759n, 10_564, 12), "pool-exit"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(16_305_049n, 9_812, 9), "pool-exit"),
    ).not.toThrow();
    // the widest standard-pool withdraw (CDE57N) and router claim (CDE57N, CB37QM)
    expect(() =>
      assertSorobanFeeWithinCap(prepared(8_361_529n, 11_012, 15), "pool-exit"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(8_606_390n, 10_236, 15), "pool-exit"),
    ).not.toThrow();
    // concentrated withdraw_position: most bytes (CBRUQ7), most entries (CAAJYI),
    // highest fee (CDQ223); claim_all_position_fees at its highest fee (CAAJYI)
    expect(() =>
      assertSorobanFeeWithinCap(prepared(245_761n, 15_984, 21), "pool-exit"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(171_697n, 15_152, 22), "pool-exit"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(4_517_897n, 11_424, 15), "pool-exit"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(6_317_225n, 6_200, 8), "pool-exit"),
    ).not.toThrow();
    // pool.gauges_claim paying a gauge's XLM (CCNXGPE4, 2026-10-08)
    expect(() =>
      assertSorobanFeeWithinCap(prepared(1_694_330n, 1_532, 6), "pool-exit"),
    ).not.toThrow();
  });

  it("bounds what a token in a permissionless pool may write during an exit", () => {
    expect(() => assertSorobanFeeWithinCap(prepared(20_000n, 32_769, 2), "pool-exit")).toThrow(
      /write 32769 bytes, over the 32768-byte limit/,
    );
    expect(() => assertSorobanFeeWithinCap(prepared(20_000n, 500, 41), "pool-exit")).toThrow(
      /41 ledger entries, over the limit of 40/,
    );
    // the testnet lp exit that restored archived contract code (pair CCD3VL)
    expect(() =>
      assertSorobanFeeWithinCap(prepared(174_084_607n, 53_204, 12), "pool-exit"),
    ).toThrow(SorobanFeeCapError);
    expect(() =>
      assertSorobanFeeWithinCap(prepared(SOROBAN_RESOURCE_FEE_CAPS["pool-exit"] + 1n), "pool-exit"),
    ).toThrow(/over the 3\.3 XLM cap/);
  });

  // measured 2026-10-09 (fee-cap.ts has the rows): a held token sent as it is
  // to a destination that holds none of it yet creates its balance entry
  it("passes measured legitimate held-token transfers", () => {
    // testnet, a fresh instance of the soroban token wasm 464c7cf3...
    expect(() =>
      assertSorobanFeeWithinCap(prepared(2_563_891n, 296, 2), "untrusted-transfer"),
    ).not.toThrow();
    // mainnet: a token's fresh-holder transfer, and the widest aquarius share
    // token transfer
    expect(() =>
      assertSorobanFeeWithinCap(prepared(308_336n, 296, 2), "untrusted-transfer"),
    ).not.toThrow();
    expect(() =>
      assertSorobanFeeWithinCap(prepared(2_478_533n, 9_092, 14), "untrusted-transfer"),
    ).not.toThrow();
    // a revoke creates no entry, so it keeps its own tighter cap
    expect(() =>
      assertSorobanFeeWithinCap(prepared(2_563_891n, 296, 2), "untrusted-token"),
    ).toThrow(/over the 0\.2 XLM cap/);
  });

  it("bounds what a held-token transfer may cost and write", () => {
    expect(() =>
      assertSorobanFeeWithinCap(
        prepared(SOROBAN_RESOURCE_FEE_CAPS["untrusted-transfer"] + 1n, 296, 2),
        "untrusted-transfer",
      ),
    ).toThrow(/over the 0\.75 XLM cap/);
    expect(() =>
      assertSorobanFeeWithinCap(prepared(20_000n, 16_385, 2), "untrusted-transfer"),
    ).toThrow(/write 16385 bytes, over the 16384-byte limit/);
    expect(() =>
      assertSorobanFeeWithinCap(prepared(20_000n, 296, 25), "untrusted-transfer"),
    ).toThrow(/25 ledger entries, over the limit of 24/);
  });

  it("keeps about a 2x margin over the largest measured legitimate fee per class", () => {
    const largest = {
      "untrusted-token": 936_287n,
      "untrusted-transfer": 2_563_891n,
      "untrusted-convert": 6_923_446n,
      "pool-exit": 16_305_049n,
      "defi-exit": 11_763_314n,
    };
    for (const [cls, fee] of Object.entries(largest)) {
      const cap = SOROBAN_RESOURCE_FEE_CAPS[cls as keyof typeof largest];
      expect(cap, cls).toBeGreaterThanOrEqual(fee * 2n);
      expect(cap, cls).toBeLessThanOrEqual(fee * 3n);
    }
  });

  // a testnet lp exit that restores an archived token wasm: legitimate, but the
  // same shape as a token pushing rent onto the signer, so it is refused
  it("refuses an untrusted step that has to restore archived contract code", () => {
    expect(() =>
      assertSorobanFeeWithinCap(prepared(36_812_907n, 19_228, 10), "untrusted-convert"),
    ).toThrow(SorobanFeeCapError);
  });

  it("bounds what an untrusted token may write during a convert too", () => {
    expect(() => assertSorobanFeeWithinCap(prepared(20_000n, 9_000), "untrusted-convert")).toThrow(
      /write 9000 bytes/,
    );
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
    expect((err as Error).message).toMatch(/3\.3100001 XLM/);
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
});
