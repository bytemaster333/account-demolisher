// blend client wrapper. thin layer over the blend-sdk that handles v1/v2 dispatch
import {
  PoolV1,
  PoolV2,
  type Network as BlendSdkNetwork,
  type Pool,
  type PoolUser,
  type PoolUserEmissionData,
} from "@blend-capital/blend-sdk";

import type { NetworkConfig } from "@/lib/config/networks";

// one pool's user-positions snapshot, keyed by asset id (the SAC/SEP-41 token contract)
export interface BlendUserPositions {
  readonly poolId: string;
  readonly poolName: string;
  readonly poolVersion: "V1" | "V2";
  readonly liabilities: Map<string, bigint>;
  readonly collateral: Map<string, bigint>;
  readonly supply: Map<string, bigint>;
  readonly emissions: Map<number, PoolUserEmissionData>;
}

// failure record for a single pool
export interface BlendPoolLoadError {
  readonly poolId: string;
  readonly stage: "pool" | "user";
  readonly message: string;
}

export interface LoadUserPositionsResult {
  readonly positions: readonly BlendUserPositions[];
  readonly errors: readonly BlendPoolLoadError[];
}

// pluggable pool loader. tries v2 first then falls back to v1
export interface BlendPoolLoader {
  load(network: BlendSdkNetwork, poolId: string): Promise<Pool>;
}

// SDK-backed loader
export const defaultBlendPoolLoader: BlendPoolLoader = {
  async load(network: BlendSdkNetwork, poolId: string): Promise<Pool> {
    try {
      return await PoolV2.load(network, poolId);
    } catch (errV2) {
      try {
        return await PoolV1.load(network, poolId);
      } catch (errV1) {
        const msgV2 = errV2 instanceof Error ? errV2.message : String(errV2);
        const msgV1 = errV1 instanceof Error ? errV1.message : String(errV1);
        throw new Error(`Pool.load failed for ${poolId}: V2 attempt=${msgV2}; V1 attempt=${msgV1}`);
      }
    }
  },
};

// adapt our NetworkConfig to the SDK's network shape
export function toBlendSdkNetwork(network: NetworkConfig): BlendSdkNetwork {
  return {
    rpc: network.rpc,
    passphrase: network.passphrase,
  };
}

// remap SDK positions from reserve-index keys to asset-id keys
function reindexByAssetId(indexedPositions: Map<number, bigint>, pool: Pool): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const indexToAssetId = new Map<number, string>();
  for (const [assetId, reserve] of pool.reserves) {
    indexToAssetId.set(reserve.config.index, assetId);
  }
  for (const [index, amount] of indexedPositions) {
    const assetId = indexToAssetId.get(index);
    if (assetId === undefined) continue;
    out.set(assetId, amount);
  }
  return out;
}

// load a single user's positions from one pool
export async function loadUserPositionsForPool(
  network: NetworkConfig,
  userPublicKey: string,
  poolId: string,
  loader: BlendPoolLoader = defaultBlendPoolLoader,
): Promise<BlendUserPositions> {
  const sdkNetwork = toBlendSdkNetwork(network);
  const pool = await loader.load(sdkNetwork, poolId);
  const user: PoolUser = await pool.loadUser(userPublicKey);

  return {
    poolId: pool.id,
    poolName: pool.metadata.name,
    poolVersion: pool.version,
    liabilities: reindexByAssetId(user.positions.liabilities, pool),
    collateral: reindexByAssetId(user.positions.collateral, pool),
    supply: reindexByAssetId(user.positions.supply, pool),
    emissions: user.emissions,
  };
}

// load positions across a set of pools in parallel. per-pool errors go to errors[]
export async function loadUserPositions(
  network: NetworkConfig,
  userPublicKey: string,
  poolIds: readonly string[],
  loader: BlendPoolLoader = defaultBlendPoolLoader,
): Promise<LoadUserPositionsResult> {
  const settled = await Promise.allSettled(
    poolIds.map((poolId) => loadUserPositionsForPool(network, userPublicKey, poolId, loader)),
  );

  const positions: BlendUserPositions[] = [];
  const errors: BlendPoolLoadError[] = [];

  settled.forEach((result, i) => {
    const poolId = poolIds[i] ?? "<unknown>";
    if (result.status === "fulfilled") {
      positions.push(result.value);
    } else {
      const reason = result.reason;
      errors.push({
        poolId,
        stage: classifyStage(reason),
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  });

  return { positions, errors };
}

// heuristic: loadUser-related errors attributed to user stage, otherwise pool stage
function classifyStage(err: unknown): "pool" | "user" {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("loadUser") || msg.includes("Positions.load") ? "user" : "pool";
}
