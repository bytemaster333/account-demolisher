import { describe, it, expect } from "vitest";
import type { Pool } from "@blend-capital/blend-sdk";

import {
  loadBackstopDeposits,
  loadUserPositions,
  loadUserPositionsForPool,
  type BackstopDepositLoader,
  type BlendPoolLoader,
} from "@/lib/adapters/blend/client";
import { TESTNET } from "@/lib/config/networks";

// build a minimal Pool-shaped fake exposing only the fields the loader reads:
// id, metadata.name, version, reserves (assetId -> { config.index }), and
// loadUser(pk) -> { positions:{liabilities,collateral,supply}, emissions }.
function makeFakePool(opts: {
  reserveIndexByAssetId: ReadonlyArray<readonly [string, number]>;
  liabilities?: Map<number, bigint>;
  collateral?: Map<number, bigint>;
  supply?: Map<number, bigint>;
}): Pool {
  const reserves = new Map<string, { config: { index: number } }>(
    opts.reserveIndexByAssetId.map(([assetId, index]) => [assetId, { config: { index } }]),
  );
  const fake = {
    id: "POOL_TEST",
    version: "V2" as const,
    metadata: { name: "Test Pool" },
    reserves,
    loadUser: async () => ({
      positions: {
        liabilities: opts.liabilities ?? new Map<number, bigint>(),
        collateral: opts.collateral ?? new Map<number, bigint>(),
        supply: opts.supply ?? new Map<number, bigint>(),
      },
      emissions: new Map(),
    }),
  };
  return fake as unknown as Pool;
}

function loaderFor(pool: Pool): BlendPoolLoader {
  return { load: async () => pool };
}

const USER = "GTESTUSERTESTUSERTESTUSERTESTUSERTESTUSERTESTUSER1234567";

describe("reindexByAssetId (via loadUserPositionsForPool)", () => {
  it("maps positions from reserve-index keys to asset-id keys when all indices are known", async () => {
    const pool = makeFakePool({
      reserveIndexByAssetId: [
        ["ASSET_A", 0],
        ["ASSET_B", 1],
      ],
      liabilities: new Map([
        [0, 100n],
        [1, 200n],
      ]),
    });

    const positions = await loadUserPositionsForPool(TESTNET, USER, "POOL_TEST", loaderFor(pool));

    expect(positions.liabilities.get("ASSET_A")).toBe(100n);
    expect(positions.liabilities.get("ASSET_B")).toBe(200n);
    expect(positions.liabilities.size).toBe(2);
  });

  it("throws instead of silently dropping a position at an unmapped reserve index", async () => {
    // user has a liability at reserve index 5, but the pool only knows index 0.
    // the old code did `continue` here, producing a "clean" (empty) position and
    // reporting outstanding Blend debt as fully drained.
    const pool = makeFakePool({
      reserveIndexByAssetId: [["ASSET_A", 0]],
      liabilities: new Map([[5, 999n]]),
    });

    await expect(
      loadUserPositionsForPool(TESTNET, USER, "POOL_TEST", loaderFor(pool)),
    ).rejects.toThrow(/reserve index 5/);
  });
});

describe("loadUserPositions surfaces the unmapped-index failure via errors[]", () => {
  it("reports the pool as an error instead of a false-clean position", async () => {
    const pool = makeFakePool({
      reserveIndexByAssetId: [["ASSET_A", 0]],
      // undrained collateral parked at an index absent from the reserve list
      collateral: new Map([[7, 500n]]),
    });

    const result = await loadUserPositions(TESTNET, USER, ["POOL_TEST"], loaderFor(pool));

    // must NOT appear as a (falsely clean) fulfilled position
    expect(result.positions).toHaveLength(0);
    // must be surfaced as a per-pool load error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.poolId).toBe("POOL_TEST");
    expect(result.errors[0]?.message).toMatch(/reserve index 7/);
  });

  it("does not throw for the normal all-indices-mapped case", async () => {
    const pool = makeFakePool({
      reserveIndexByAssetId: [["ASSET_A", 0]],
      supply: new Map([[0, 42n]]),
    });

    const result = await loadUserPositions(TESTNET, USER, ["POOL_TEST"], loaderFor(pool));

    expect(result.errors).toHaveLength(0);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]?.supply.get("ASSET_A")).toBe(42n);
  });
});

describe("loadBackstopDeposits (detect stranded backstop shares)", () => {
  const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
  const BACKSTOP = "CBACKSTOP";

  it("reports pools where the user holds active or queued backstop shares", async () => {
    const loader: BackstopDepositLoader = {
      async loadUser(_net, _bs, poolId) {
        if (poolId === "POOL_ACTIVE") return { shares: 5_000n, totalQ4W: 0n };
        if (poolId === "POOL_QUEUED") return { shares: 0n, totalQ4W: 100n };
        return { shares: 0n, totalQ4W: 0n }; // POOL_EMPTY
      },
    };
    const res = await loadBackstopDeposits(
      TESTNET,
      USER,
      ["POOL_ACTIVE", "POOL_QUEUED", "POOL_EMPTY"],
      BACKSTOP,
      loader,
    );
    expect(res.errors).toHaveLength(0);
    expect(res.deposits.map((d) => d.poolId).sort()).toEqual(["POOL_ACTIVE", "POOL_QUEUED"]);
  });

  it("surfaces a read failure instead of treating it as 'no backstop position'", async () => {
    const loader: BackstopDepositLoader = {
      async loadUser() {
        throw new Error("rpc down");
      },
    };
    const res = await loadBackstopDeposits(TESTNET, USER, ["POOL_X"], BACKSTOP, loader);
    expect(res.deposits).toHaveLength(0);
    expect(res.errors[0]).toContain("backstop read failed");
  });
});

// The Blend SDK builds its own RPC Server from the single {rpc} we hand it, so it
// bypasses the failover Proxy getRpc() gives our direct reads. On mainnet the
// primary endpoint rate-limits (429) under the concurrent per-pool load burst,
// which surfaced as a "DeFi positions" discovery warning. These assert the SDK
// reads now retry against the next configured endpoint, exactly like our reads.
describe("Blend SDK reads fail over across endpoints", () => {
  const FAILOVER_USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
  const FALLBACK = TESTNET.rpcFallbacks![0]!;

  it("retries a pool load on the fallback endpoint when the primary rate-limits (429)", async () => {
    const seenRpc: string[] = [];
    const pool = makeFakePool({
      reserveIndexByAssetId: [["ASSET_A", 0]],
      supply: new Map([[0, 7n]]),
    });
    const loader: BlendPoolLoader = {
      async load(network) {
        seenRpc.push(network.rpc);
        if (network.rpc === TESTNET.rpc) throw new Error("Request failed with status code 429");
        return pool;
      },
    };

    const positions = await loadUserPositionsForPool(TESTNET, FAILOVER_USER, "POOL_TEST", loader);

    expect(positions.supply.get("ASSET_A")).toBe(7n);
    expect(seenRpc).toEqual([TESTNET.rpc, FALLBACK]);
  });

  it("does NOT fail over on a deterministic (non-transport) error", async () => {
    const seenRpc: string[] = [];
    const loader: BlendPoolLoader = {
      async load(network) {
        seenRpc.push(network.rpc);
        throw new Error("Pool.load failed for POOL_TEST: contract not found");
      },
    };

    await expect(
      loadUserPositionsForPool(TESTNET, FAILOVER_USER, "POOL_TEST", loader),
    ).rejects.toThrow(/contract not found/);
    expect(seenRpc).toEqual([TESTNET.rpc]); // deterministic error: same on every host
  });

  it("absorbs a per-pool backstop 429 via the fallback, so no warning is surfaced", async () => {
    const seenRpc: string[] = [];
    const loader: BackstopDepositLoader = {
      async loadUser(network) {
        seenRpc.push(network.rpc);
        if (network.rpc === TESTNET.rpc) throw new Error("Request failed with status code 429");
        return { shares: 3_000n, totalQ4W: 0n };
      },
    };

    const res = await loadBackstopDeposits(TESTNET, FAILOVER_USER, ["POOL_X"], "CBACKSTOP", loader);

    expect(res.errors).toHaveLength(0);
    expect(res.deposits[0]?.shares).toBe(3_000n);
    expect(seenRpc).toEqual([TESTNET.rpc, FALLBACK]);
  });
});
