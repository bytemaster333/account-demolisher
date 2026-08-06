import { describe, it, expect } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

import {
  aquariusPositionSchema,
  blendBackstopSchema,
  blendPositionSchema,
  fxdaoPositionSchema,
  parsePositions,
  soroswapPositionSchema,
} from "@/lib/adapters/positions/schema";

const C1 = StrKey.encodeContract(Buffer.alloc(32, 1));
const C2 = StrKey.encodeContract(Buffer.alloc(32, 2));
const IDX = "a".repeat(64);

describe("position provider schemas — validated boundary", () => {
  it("accepts a well-formed blend position and rejects a negative balance", () => {
    const ok = {
      poolId: C1,
      liabilities: new Map([[C2, 100n]]),
      collateral: new Map(),
      supply: new Map(),
      emissionReserveTokenIds: [0, 3],
    };
    expect(() => blendPositionSchema.parse(ok)).not.toThrow();
    expect(() =>
      blendPositionSchema.parse({ ...ok, liabilities: new Map([[C2, -1n]]) }),
    ).toThrow();
    // a non-contract-id asset key is rejected
    expect(() =>
      blendPositionSchema.parse({ ...ok, collateral: new Map([["not-a-contract", 1n]]) }),
    ).toThrow();
  });

  it("rejects a blend position whose poolId is not a contract id", () => {
    expect(() =>
      blendPositionSchema.parse({
        poolId: "GABC",
        liabilities: new Map(),
        collateral: new Map(),
        supply: new Map(),
        emissionReserveTokenIds: [],
      }),
    ).toThrow();
  });

  it("validates backstop, soroswap, fxdao shapes and rejects malformed ones", () => {
    expect(() =>
      blendBackstopSchema.parse({ poolId: C1, shares: 5n, queuedForWithdrawal: 0n }),
    ).not.toThrow();
    expect(() =>
      soroswapPositionSchema.parse({ pair: { tokenA: C1, tokenB: C2 }, shareBalance: 9n }),
    ).not.toThrow();
    expect(() =>
      soroswapPositionSchema.parse({ pair: { tokenA: "bad", tokenB: C2 }, shareBalance: 9n }),
    ).toThrow();
    expect(() =>
      fxdaoPositionSchema.parse({ denomination: "USD", debt: 1n, collateral: 2n }),
    ).not.toThrow();
    expect(() =>
      fxdaoPositionSchema.parse({ denomination: "", debt: 1n, collateral: 2n }),
    ).toThrow();
  });

  it("accepts a 64-hex aquarius pool index (with or without 0x) and rejects others", () => {
    const base = { poolIndex: IDX, shareBalance: 1n, tokens: [C1] };
    expect(() => aquariusPositionSchema.parse(base)).not.toThrow();
    expect(() => aquariusPositionSchema.parse({ ...base, poolIndex: `0x${IDX}` })).not.toThrow();
    expect(() => aquariusPositionSchema.parse({ ...base, poolIndex: "abc" })).toThrow();
    expect(() => aquariusPositionSchema.parse({ ...base, tokens: ["not-a-contract"] })).toThrow();
  });

  it("parsePositions maps a whole array and throws on the first bad record", () => {
    const good = { denomination: "EUR", debt: 1n, collateral: 2n };
    expect(parsePositions(fxdaoPositionSchema, [good, good])).toHaveLength(2);
    expect(() =>
      parsePositions(fxdaoPositionSchema, [good, { denomination: "GBP", debt: -1n, collateral: 2n }]),
    ).toThrow();
  });
});
