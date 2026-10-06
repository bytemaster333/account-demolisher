import { describe, it, expect } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

import {
  aquariusConcentratedPositionSchema,
  aquariusPositionSchema,
  blendBackstopSchema,
  blendBackstopUnclaimedSchema,
  blendPositionSchema,
  parsePositions,
  soroswapPositionSchema,
} from "@/lib/adapters/positions/schema";
import { EMPTY_POSITIONS, openPositionCount } from "@/lib/adapters/positions/interface";

const C1 = StrKey.encodeContract(Buffer.alloc(32, 1));
const C2 = StrKey.encodeContract(Buffer.alloc(32, 2));
const C3 = StrKey.encodeContract(Buffer.alloc(32, 3));
const IDX = "a".repeat(64);

describe("position provider schemas, the validated boundary", () => {
  it("accepts a well-formed blend position and rejects a negative balance", () => {
    const ok = {
      poolId: C1,
      liabilities: new Map([[C2, 100n]]),
      collateral: new Map(),
      supply: new Map(),
      emissionReserveTokenIds: [0, 3],
    };
    expect(() => blendPositionSchema.parse(ok)).not.toThrow();
    expect(() => blendPositionSchema.parse({ ...ok, liabilities: new Map([[C2, -1n]]) })).toThrow();
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

  it("validates backstop and soroswap shapes and rejects malformed ones", () => {
    expect(() =>
      blendBackstopSchema.parse({ poolId: C1, shares: 5n, queuedForWithdrawal: 0n }),
    ).not.toThrow();
    expect(() =>
      soroswapPositionSchema.parse({ pair: { tokenA: C1, tokenB: C2 }, shareBalance: 9n }),
    ).not.toThrow();
    expect(() =>
      soroswapPositionSchema.parse({ pair: { tokenA: "bad", tokenB: C2 }, shareBalance: 9n }),
    ).toThrow();
  });

  it("accepts leftover backstop emissions only with a positive amount", () => {
    const ok = { poolId: C1, backstopId: C2, accruedEmissions: 18_611_659n };
    expect(() => blendBackstopUnclaimedSchema.parse(ok)).not.toThrow();
    expect(() => blendBackstopUnclaimedSchema.parse({ ...ok, accruedEmissions: 0n })).toThrow();
    expect(() => blendBackstopUnclaimedSchema.parse({ ...ok, backstopId: "bad" })).toThrow();
  });

  it("accepts a 64-hex aquarius pool index (with or without 0x) and rejects others", () => {
    const base = { poolIndex: IDX, shareBalance: 1n, tokens: [C1] };
    expect(() => aquariusPositionSchema.parse(base)).not.toThrow();
    expect(() => aquariusPositionSchema.parse({ ...base, poolIndex: `0x${IDX}` })).not.toThrow();
    expect(() => aquariusPositionSchema.parse({ ...base, poolIndex: "abc" })).toThrow();
    expect(() => aquariusPositionSchema.parse({ ...base, tokens: ["not-a-contract"] })).toThrow();
  });

  it("validates an aquarius concentrated position (H-26)", () => {
    const ok = {
      poolAddress: C3,
      poolIndex: IDX,
      tokens: [C1, C2],
      ranges: [{ tickLower: -887_220, tickUpper: 887_220, liquidity: 5n }],
      pendingFees: [0n, 0n],
      pendingReward: 0n,
    };
    const parse = (v: unknown) => () => aquariusConcentratedPositionSchema.parse(v);
    expect(parse(ok)).not.toThrow();
    // fees or a reward alone still make a position
    expect(parse({ ...ok, ranges: [], pendingFees: [0n, 1n] })).not.toThrow();
    expect(parse({ ...ok, ranges: [], pendingReward: 1n })).not.toThrow();
    // nothing left is not a position
    expect(parse({ ...ok, ranges: [] })).toThrow();
    expect(parse({ ...ok, ranges: [{ tickLower: 10, tickUpper: 10, liquidity: 5n }] })).toThrow();
    expect(parse({ ...ok, ranges: [{ tickLower: 0, tickUpper: 10, liquidity: 0n }] })).toThrow();
    expect(parse({ ...ok, ranges: [{ tickLower: 0.5, tickUpper: 10, liquidity: 5n }] })).toThrow();
    expect(parse({ ...ok, pendingFees: [0n] })).toThrow();
    expect(parse({ ...ok, poolAddress: "bad" })).toThrow();
  });

  it("parsePositions maps a whole array and throws on the first bad record", () => {
    const good = { pair: { tokenA: C1, tokenB: C2 }, shareBalance: 1n };
    expect(parsePositions(soroswapPositionSchema, [good, good])).toHaveLength(2);
    expect(() =>
      parsePositions(soroswapPositionSchema, [good, { ...good, shareBalance: -1n }]),
    ).toThrow();
  });
});

describe("openPositionCount", () => {
  it("counts every position list and ignores leftover backstop emissions", () => {
    expect(openPositionCount(EMPTY_POSITIONS)).toBe(0);
    const one = <T>(v: T): readonly T[] => [v];
    expect(
      openPositionCount({
        ...EMPTY_POSITIONS,
        blend: one({
          poolId: C1,
          liabilities: new Map(),
          collateral: new Map(),
          supply: new Map(),
          emissionReserveTokenIds: [1],
        }),
        backstop: one({ poolId: C1, shares: 0n, queuedForWithdrawal: 1n }),
        aquarius: one({ poolIndex: IDX, shareBalance: 1n, tokens: [C1] }),
        aquariusConcentrated: one({
          poolAddress: C3,
          poolIndex: IDX,
          tokens: [C1, C2],
          ranges: [],
          pendingFees: [0n, 0n],
          pendingReward: 1n,
        }),
        soroswap: one({ pair: { tokenA: C1, tokenB: C2 }, shareBalance: 1n }),
        backstopUnclaimedEmissions: one({ poolId: C1, backstopId: C2, accruedEmissions: 5n }),
      }),
    ).toBe(5);
  });
});
