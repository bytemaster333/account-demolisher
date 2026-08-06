import { describe, it, expect } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import { TESTNET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

// realistic fixtures: pool indices are 64-hex (BytesN<32>) and tokens are valid
// Soroban contract ids, so they pass the provider's schema validation (which
// rejects malformed on-chain data).
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 3));
const IDX_A = "a".repeat(64);
const IDX_B = "b".repeat(64);
const IDX_HIDDEN = "c".repeat(64);

function aqPool(poolIndex: string) {
  return { poolIndex, poolType: "constant_product", tokens: [TOKEN], shareBalance: 100n };
}

// A provider whose Aquarius primary (REST) / fallback (on-chain scan) return the
// given pools (or throw). The other adapters are stubbed empty so only Aquarius
// affects positions.aquarius. (Soroswap uses a real import against the dummy
// server and errors out, but we only assert on the aquarius slice.)
function provider(primary: () => unknown, fallback: () => unknown) {
  return new DirectContractProvider({
    serverFactory: () => ({}) as never,
    aquariusFactory: (() => ({
      primary: { getUserPools: async () => primary() },
      fallback: { getUserPools: async () => fallback() },
    })) as never,
    blendPoolIds: [],
    blendLoadUserPositions: (async () => ({ positions: [], errors: [] })) as never,
    blendLoadBackstopDeposits: (async () => ({ deposits: [], errors: [] })) as never,
    fxdaoGetUserVaults: (async () => []) as never,
  });
}

describe("Aquarius discovery union (SEC-05: a spoofed-empty API can't hide a pool)", () => {
  it("surfaces a pool the API omitted but the on-chain scan found", async () => {
    const positions = await provider(
      () => [],
      () => [aqPool(IDX_HIDDEN)],
    ).getPositions(USER, TESTNET);
    expect(positions.aquarius.map((x) => x.poolIndex)).toEqual([IDX_HIDDEN]);
  });

  it("unions distinct pools from both sources and dedups shared ones", async () => {
    const positions = await provider(
      () => [aqPool(IDX_A)],
      () => [aqPool(IDX_A), aqPool(IDX_B)],
    ).getPositions(USER, TESTNET);
    expect(new Set(positions.aquarius.map((x) => x.poolIndex))).toEqual(new Set([IDX_A, IDX_B]));
  });

  it("errors on aquarius only when BOTH sources fail (fail-closed)", async () => {
    const boom = () => {
      throw new Error("down");
    };
    const positions = await provider(boom, boom).getPositions(USER, TESTNET);
    expect(positions.aquarius).toEqual([]);
    expect(positions.errors.some((e) => e.protocol === "aquarius")).toBe(true);
  });

  it("still returns the API result when only the on-chain scan fails", async () => {
    const positions = await provider(
      () => [aqPool(IDX_A)],
      () => {
        throw new Error("rpc down");
      },
    ).getPositions(USER, TESTNET);
    expect(positions.aquarius.map((x) => x.poolIndex)).toEqual([IDX_A]);
    expect(positions.errors.some((e) => e.protocol === "aquarius")).toBe(false);
  });

  it("rejects a malformed pool (bad poolIndex) as an aquarius discovery error (schema fail-closed)", async () => {
    const positions = await provider(
      () => [aqPool("not-hex")],
      () => [aqPool("not-hex")],
    ).getPositions(USER, TESTNET);
    // schema validation throws -> aquarius slice empty + a recorded error, so a
    // malformed position can't be silently carried into the plan
    expect(positions.aquarius).toEqual([]);
    expect(positions.errors.some((e) => e.protocol === "aquarius")).toBe(true);
  });
});
