import { describe, it, expect } from "vitest";
import { Address, Keypair, StrKey, hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  address,
  fromScValAddress,
  fromScValI128,
  fromScValString,
  fromScValSymbol,
  fromScValU32,
  i128,
  symbol,
  u32,
  vec,
} from "@/lib/soroban/scval";

// These helpers marshal sep-41 contract-call arguments to/from xdr.ScVal. A
// wrong ScVal switch or a silently-truncated i128 would produce a malformed but
// still-signable contract invocation, so we assert both the produced ScVal type
// and exact round-trip values, including the i128 signed extremes.

const ACCOUNT = Keypair.random().publicKey();
const CONTRACT = StrKey.encodeContract(hash(Buffer.from("scval-test-contract")));

// i128 is a signed 128-bit two's-complement integer
const I128_MAX = 170141183460469231731687303715884105727n;
const I128_MIN = -170141183460469231731687303715884105728n;

describe("address / fromScValAddress", () => {
  it("encodes an account (G...) address as scvAddress", () => {
    const v = address(ACCOUNT);
    expect(v.switch().name).toBe("scvAddress");
  });

  it("round-trips an account address", () => {
    expect(fromScValAddress(address(ACCOUNT))).toBe(ACCOUNT);
  });

  it("round-trips a contract (C...) address", () => {
    const v = address(CONTRACT);
    expect(v.switch().name).toBe("scvAddress");
    expect(fromScValAddress(v)).toBe(CONTRACT);
  });

  it("agrees with the SDK Address decoder", () => {
    const v = address(ACCOUNT);
    expect(Address.fromScVal(v).toString()).toBe(ACCOUNT);
  });

  it("rejects a non-address ScVal", () => {
    expect(() => fromScValAddress(u32(1))).toThrow(/Expected scvAddress/);
  });
});

describe("i128 / fromScValI128", () => {
  it("encodes as scvI128", () => {
    expect(i128(1n).switch().name).toBe("scvI128");
  });

  it("round-trips a small positive value", () => {
    expect(fromScValI128(i128(42n))).toBe(42n);
  });

  it("round-trips zero", () => {
    const v = i128(0n);
    expect(v.switch().name).toBe("scvI128");
    expect(fromScValI128(v)).toBe(0n);
  });

  it("round-trips a negative value", () => {
    expect(fromScValI128(i128(-5n))).toBe(-5n);
  });

  it("round-trips a large positive value beyond 64 bits", () => {
    const big = 9_223_372_036_854_775_808n; // 2^63, does not fit in i64
    expect(fromScValI128(i128(big))).toBe(big);
  });

  it("round-trips the signed 128-bit maximum", () => {
    expect(fromScValI128(i128(I128_MAX))).toBe(I128_MAX);
  });

  it("round-trips the signed 128-bit minimum", () => {
    expect(fromScValI128(i128(I128_MIN))).toBe(I128_MIN);
  });

  it("splits a value that spans both 64-bit halves correctly", () => {
    // hi != 0 and lo != 0 exercises the two-limb encoding
    const spanning = (123n << 64n) | 456n;
    expect(fromScValI128(i128(spanning))).toBe(spanning);
  });

  it("rejects a non-i128 ScVal", () => {
    expect(() => fromScValI128(u32(1))).toThrow(/Expected scvI128/);
  });
});

describe("u32 / fromScValU32", () => {
  it("encodes as scvU32 and round-trips", () => {
    const v = u32(7);
    expect(v.switch().name).toBe("scvU32");
    expect(fromScValU32(v)).toBe(7);
  });

  it("round-trips zero", () => {
    expect(fromScValU32(u32(0))).toBe(0);
  });

  it("round-trips the u32 maximum", () => {
    const max = 0xffff_ffff;
    expect(fromScValU32(u32(max))).toBe(max);
  });

  it("rejects a value above the u32 range", () => {
    expect(() => u32(0x1_0000_0000)).toThrow(RangeError);
  });

  it("rejects a negative value", () => {
    expect(() => u32(-1)).toThrow(RangeError);
  });

  it("rejects a non-integer value", () => {
    expect(() => u32(1.5)).toThrow(RangeError);
  });

  it("rejects a non-u32 ScVal on decode", () => {
    expect(() => fromScValU32(i128(1n))).toThrow(/Expected scvU32/);
  });
});

describe("symbol / fromScValSymbol", () => {
  it("encodes as scvSymbol and round-trips", () => {
    const v = symbol("transfer");
    expect(v.switch().name).toBe("scvSymbol");
    expect(fromScValSymbol(v)).toBe("transfer");
  });

  it("round-trips an empty symbol", () => {
    expect(fromScValSymbol(symbol(""))).toBe("");
  });

  it("rejects a non-symbol ScVal", () => {
    expect(() => fromScValSymbol(u32(1))).toThrow(/Expected scvSymbol/);
  });
});

describe("vec", () => {
  it("wraps its members in an scvVec preserving order and contents", () => {
    const members = [u32(1), symbol("approve"), i128(-9n)];
    const v = vec(members);
    expect(v.switch().name).toBe("scvVec");
    const inner = v.vec();
    expect(inner).not.toBeNull();
    expect(inner!).toHaveLength(3);
    expect(fromScValU32(inner![0]!)).toBe(1);
    expect(fromScValSymbol(inner![1]!)).toBe("approve");
    expect(fromScValI128(inner![2]!)).toBe(-9n);
  });

  it("wraps an empty member list", () => {
    const v = vec([]);
    expect(v.switch().name).toBe("scvVec");
    expect(v.vec()!).toHaveLength(0);
  });
});

describe("fromScValString", () => {
  it("decodes an scvString", () => {
    const v = xdr.ScVal.scvString("Wrapped Bitcoin");
    expect(v.switch().name).toBe("scvString");
    expect(fromScValString(v)).toBe("Wrapped Bitcoin");
  });

  it("also accepts an scvSymbol (sep-41 symbol()-shaped return)", () => {
    expect(fromScValString(symbol("wBTC"))).toBe("wBTC");
  });

  it("decodes an scvString carrying raw bytes via the SDK", () => {
    // scValToNative may hand back a Uint8Array for non-utf-friendly strings;
    // the helper must still yield the decoded text
    const bytes = new Uint8Array([0x77, 0x42, 0x54, 0x43]); // "wBTC"
    const v = xdr.ScVal.scvString(Buffer.from(bytes));
    const native = scValToNative(v);
    const expected = typeof native === "string" ? native : new TextDecoder().decode(bytes);
    expect(fromScValString(v)).toBe(expected);
  });

  it("rejects an ScVal that is neither string nor symbol", () => {
    expect(() => fromScValString(u32(1))).toThrow(/Expected scvString or scvSymbol/);
  });
});
