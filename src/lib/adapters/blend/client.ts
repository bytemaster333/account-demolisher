// blend client wrapper. thin layer over the blend-sdk that handles v1/v2 dispatch
import {
  BackstopPoolUser,
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
    if (assetId === undefined) {
      // do not silently drop: an unmapped reserve index means the pool's reserve
      // list and the user's positions disagree; treat as a load failure so the
      // orchestrator never reports the position as clean.
      throw new Error(
        `reindexByAssetId: position at reserve index ${index} (amount=${amount.toString()}) has no matching reserve in pool ${pool.id}; refusing to treat as empty`,
      );
    }
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

// ── backstop deposits ────────────────────────────────────────────────────────
// Blend backstop shares live in a SEPARATE contract, not the pool, so they don't
// show up in pool positions and don't block an account merge. We don't auto-unwind
// them yet (a backstop withdrawal is a queued, 17-day-locked flow), so we DETECT
// them and surface a warning rather than silently letting the close strand them.

export interface BackstopDeposit {
  readonly poolId: string;
  readonly shares: bigint; // active backstop shares
  readonly queuedForWithdrawal: bigint; // shares already in the Q4W queue
}

export interface BackstopDepositLoader {
  loadUser(
    network: BlendSdkNetwork,
    backstopId: string,
    poolId: string,
    userId: string,
  ): Promise<{ shares: bigint; totalQ4W: bigint }>;
}

export const defaultBackstopDepositLoader: BackstopDepositLoader = {
  async loadUser(network, backstopId, poolId, userId) {
    const user = await BackstopPoolUser.load(network, backstopId, poolId, userId);
    return { shares: user.balance.shares, totalQ4W: user.balance.totalQ4W };
  },
};

export interface LoadBackstopDepositsResult {
  readonly deposits: readonly BackstopDeposit[];
  readonly errors: readonly string[];
}

// detect any active or queued backstop deposit the user holds across the pools.
// A read failure is reported (not swallowed), so we never treat an RPC error as
// "no backstop position".
export async function loadBackstopDeposits(
  network: NetworkConfig,
  userPublicKey: string,
  poolIds: readonly string[],
  backstopId: string,
  loader: BackstopDepositLoader = defaultBackstopDepositLoader,
): Promise<LoadBackstopDepositsResult> {
  const sdkNetwork = toBlendSdkNetwork(network);
  const deposits: BackstopDeposit[] = [];
  const errors: string[] = [];
  const settled = await Promise.allSettled(
    poolIds.map((poolId) => loader.loadUser(sdkNetwork, backstopId, poolId, userPublicKey)),
  );
  settled.forEach((result, i) => {
    const poolId = poolIds[i] ?? "<unknown>";
    if (result.status === "fulfilled") {
      if (result.value.shares > 0n || result.value.totalQ4W > 0n) {
        deposits.push({
          poolId,
          shares: result.value.shares,
          queuedForWithdrawal: result.value.totalQ4W,
        });
      }
    } else {
      const reason = result.reason;
      errors.push(
        `backstop read failed for pool ${poolId}: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  });
  return { deposits, errors };
}

// heuristic: loadUser-related errors attributed to user stage, otherwise pool stage
function classifyStage(err: unknown): "pool" | "user" {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("loadUser") || msg.includes("Positions.load") ? "user" : "pool";
}
