import { describe, it, expect } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

import { AquariusPartialPoolsError } from "@/lib/adapters/aquarius/pools";
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
  return {
    poolIndex,
    poolAddress: StrKey.encodeContract(Buffer.alloc(32, poolIndex.charCodeAt(0))),
    poolType: "constant_product",
    tokens: [TOKEN],
    shareBalance: 100n,
  };
}

// a provider whose aquarius primary (REST) / fallback (on-chain scan) return the
// given pools (or throw). every other source is stubbed empty, so any error in
// the result comes from the aquarius path under test.
function provider(primary: () => unknown, fallback: () => unknown) {
  return new DirectContractProvider({
    serverFactory: () => ({}) as never,
    aquariusFactory: (() => ({
      primary: { getUserPools: async () => primary() },
      fallback: { getUserPools: async () => fallback() },
    })) as never,
    aquariusDiscoverConcentrated: async () => [],
    blendPoolIds: [],
    blendLoadUserPositions: (async () => ({ positions: [], errors: [] })) as never,
    blendLoadBackstopDeposits: (async () => ({
      deposits: [],
      unclaimedEmissions: [],
      errors: [],
    })) as never,
    soroswapDiscover: (async () => []) as never,
  });
}

describe("Aquarius discovery union (SEC-05: a spoofed-empty API can't hide a pool)", () => {
  it("surfaces a pool the API omitted but the on-chain scan found", async () => {
    const positions = await provider(
      () => [],
      () => [aqPool(IDX_HIDDEN)],
    ).getPositions(USER, TESTNET);
    expect(positions.aquarius.map((x) => x.poolIndex)).toEqual([IDX_HIDDEN]);
    expect(positions.errors).toEqual([]);
  });

  it("unions distinct pools from both sources and dedups shared ones", async () => {
    const positions = await provider(
      () => [aqPool(IDX_A)],
      () => [aqPool(IDX_A), aqPool(IDX_B)],
    ).getPositions(USER, TESTNET);
    expect(new Set(positions.aquarius.map((x) => x.poolIndex))).toEqual(new Set([IDX_A, IDX_B]));
    expect(positions.errors).toEqual([]);
  });

  it("records an aquarius error when both sources fail (fail-closed)", async () => {
    const boom = () => {
      throw new Error("down");
    };
    const positions = await provider(boom, boom).getPositions(USER, TESTNET);
    expect(positions.aquarius).toEqual([]);
    expect(positions.errors.length).toBeGreaterThan(0);
    expect(positions.errors.every((e) => e.protocol === "aquarius")).toBe(true);
  });

  it("records an error when only the REST source fails, keeping the pools it did read", async () => {
    const positions = await provider(
      () => {
        throw new AquariusPartialPoolsError(
          ["could not read shares in pool CPOOL (HostError: trapped)"],
          [aqPool(IDX_A)],
        );
      },
      () => [aqPool(IDX_B)],
    ).getPositions(USER, TESTNET);
    expect(new Set(positions.aquarius.map((x) => x.poolIndex))).toEqual(new Set([IDX_A, IDX_B]));
    expect(positions.errors.map((e) => e.protocol)).toEqual(["aquarius"]);
    expect(positions.errors[0]?.message).toMatch(/CPOOL/);
  });

  // the scan is the check against a spoofed or partial REST answer. losing it
  // silently would let a REST source that omits a pool hide it whenever the scan
  // fails, so the API result is kept and an error is recorded (NPF-16, M-29)
  it("keeps the API result and records an error when only the on-chain scan fails", async () => {
    const positions = await provider(
      () => [aqPool(IDX_A)],
      () => {
        throw new Error("rpc down");
      },
    ).getPositions(USER, TESTNET);
    expect(positions.aquarius.map((x) => x.poolIndex)).toEqual([IDX_A]);
    expect(positions.errors.map((e) => e.protocol)).toEqual(["aquarius"]);
    expect(positions.errors[0]?.message).toMatch(/rpc down/);
    expect(positions.errors[0]?.message).toMatch(/on-chain scan/);
  });

  it("records an error when the on-chain scan stops at its page cap", async () => {
    const positions = await provider(
      () => [],
      () => {
        throw new Error(
          "Aquarius event scan stopped at its 100-page cap with more events pending; the scan is incomplete",
        );
      },
    ).getPositions(USER, TESTNET);
    expect(positions.aquarius).toEqual([]);
    expect(positions.errors.map((e) => e.protocol)).toEqual(["aquarius"]);
    expect(positions.errors[0]?.message).toMatch(/100-page cap/);
  });

  it("rejects a malformed pool (bad poolIndex) as an aquarius discovery error (schema fail-closed)", async () => {
    const positions = await provider(
      () => [aqPool("not-hex")],
      () => [aqPool("not-hex")],
    ).getPositions(USER, TESTNET);
    // schema validation throws -> aquarius slice empty + a recorded error, so a
    // malformed position can't be silently carried into the plan
    expect(positions.aquarius).toEqual([]);
    expect(positions.errors.length).toBeGreaterThan(0);
    expect(positions.errors.every((e) => e.protocol === "aquarius")).toBe(true);
  });
});
