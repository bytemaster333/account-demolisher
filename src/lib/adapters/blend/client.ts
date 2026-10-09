// blend client wrapper. thin layer over the blend-sdk that handles v1/v2 dispatch
import {
  BackstopPoolUser,
  BackstopPoolV1,
  BackstopPoolV2,
  PoolV1,
  PoolV2,
  type BackstopPool,
  type Network as BlendSdkNetwork,
  type Pool,
  type PoolUser,
  type PoolUserEmissionData,
  type Q4W,
  type Reserve,
} from "@blend-capital/blend-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { isFailoverError } from "@/lib/soroban/rpc-client";

import { resolveKnownBackstop, type BlendBackstopRef } from "./constants";

// one pool's user positions keyed by asset id (the SAC/SEP-41 token contract).
// amounts are UNDERLYING token units: liabilities are the debt owed (dTokens
// times the reserve's dRate, rounded up) and collateral/supply what a full
// withdraw returns (bTokens times bRate, rounded down). the exit builders re-read
// the pool on chain, so these only drive the plan and the shortfall check.
export interface BlendUserPositions {
  readonly poolId: string;
  readonly poolName: string;
  readonly poolVersion: "V1" | "V2";
  readonly liabilities: Map<string, bigint>;
  readonly collateral: Map<string, bigint>;
  readonly supply: Map<string, bigint>;
  readonly emissions: Map<number, PoolUserEmissionData>;
}

// what discovery knows about a pool beyond the balances
export interface BlendPoolSnapshot extends BlendUserPositions {
  // the backstop named in the pool's own metadata (v1 pools use the v1 backstop)
  readonly backstopId: string;
  // reserve token ids (reserve index * 2, +1 for supply) with emissions accrued
  // to this user, which is what claim(from, reserve_token_ids, to) takes
  readonly claimableEmissionTokenIds: readonly number[];
}

// failure record for a single pool
export interface BlendPoolLoadError {
  readonly poolId: string;
  readonly stage: "pool" | "user";
  readonly message: string;
}

export interface LoadUserPositionsResult {
  readonly positions: readonly BlendPoolSnapshot[];
  readonly errors: readonly BlendPoolLoadError[];
}

// pluggable pool loader. tries v2 first then falls back to v1
export interface BlendPoolLoader {
  load(network: BlendSdkNetwork, poolId: string): Promise<Pool>;
}

// SDK-backed loader. PoolV2.load and PoolV1.load each reject the other version's
// reserve layout, so whichever succeeds is the pool's real version. a v1 pool
// always fails the v2 decode ("ReserveConfig scvMap value malformed": its
// reserves carry no supply_cap or enabled).
//
// a host fault (429, 5xx, a dropped connection) on either attempt is thrown as
// it is, so withBlendFailover recognises it and runs the load on the next
// endpoint. wrapped in the two-attempt message it no longer reads as a rate
// limit, and a v1 pool on a throttled host was reported as a load failure
// without the other endpoints ever being tried.
export const defaultBlendPoolLoader: BlendPoolLoader = {
  async load(network: BlendSdkNetwork, poolId: string): Promise<Pool> {
    try {
      return await PoolV2.load(network, poolId);
    } catch (errV2) {
      // a host fault says nothing about the pool's version
      if (isFailoverError(errV2)) throw errV2;
      try {
        return await PoolV1.load(network, poolId);
      } catch (errV1) {
        if (isFailoverError(errV1)) throw errV1;
        throw new Error(
          `Pool.load failed for ${poolId}: V2 attempt=${errorMessage(errV2)}; ` +
            `V1 attempt=${errorMessage(errV1)}`,
        );
      }
    }
  },
};

// the blend-sdk builds its own rpc Server from the single {rpc} we hand it, so it
// bypasses the failover proxy getRpc() gives our direct reads. on mainnet the
// primary endpoint rate-limits (429) under the concurrent per-pool load burst
// (v1 pools load twice: a v2 attempt, then v1), which surfaced as a spurious
// "DeFi positions" discovery warning. so a unit of blend work runs against the
// primary and, on a failover-worthy fault (429/5xx/network), the same work is
// retried against the next configured endpoint. deterministic errors
// (contract-not-found, unmapped reserve index) are identical on every host, so
// they propagate immediately instead of wasting endpoints.
export async function withBlendFailover<T>(
  network: NetworkConfig,
  op: (sdkNetwork: BlendSdkNetwork) => Promise<T>,
): Promise<T> {
  const urls = [network.rpc, ...(network.rpcFallbacks ?? [])];
  let lastErr: unknown;
  for (let i = 0; i < urls.length; i += 1) {
    try {
      return await op({ rpc: urls[i]!, passphrase: network.passphrase });
    } catch (err) {
      lastErr = err;
      if (i === urls.length - 1 || !isFailoverError(err)) throw err;
    }
  }
  throw lastErr;
}

// an error that remembers whether the pool or the user read failed
class BlendLoadStageError extends Error {
  readonly stage: "pool" | "user";
  constructor(stage: "pool" | "user", cause: unknown) {
    super(errorMessage(cause));
    this.name = "BlendLoadStageError";
    this.stage = stage;
  }
}

// load a pool and the user's state in it against the same endpoint, so a 429 on
// either read retries the whole unit on the next one
export async function loadPoolAndUser(
  network: NetworkConfig,
  poolId: string,
  userPublicKey: string,
  loader: BlendPoolLoader = defaultBlendPoolLoader,
): Promise<{ readonly pool: Pool; readonly user: PoolUser }> {
  let stage: "pool" | "user" = "pool";
  try {
    return await withBlendFailover(network, async (sdkNetwork) => {
      stage = "pool";
      const pool = await loader.load(sdkNetwork, poolId);
      stage = "user";
      const user = await pool.loadUser(userPublicKey);
      return { pool, user };
    });
  } catch (err) {
    throw new BlendLoadStageError(stage, err);
  }
}

// convert reserve-index keyed token balances into asset-id keyed underlying
// amounts. an index with no reserve means the pool's reserve list and the user's
// positions disagree, which is a load failure, never an empty position.
function toUnderlyingByAsset(
  indexed: Map<number, bigint>,
  pool: Pool,
  convert: (reserve: Reserve, tokens: bigint) => bigint,
): Map<string, bigint> {
  const byIndex = new Map<number, Reserve>();
  for (const reserve of pool.reserves.values()) byIndex.set(reserve.config.index, reserve);
  const out = new Map<string, bigint>();
  for (const [index, tokens] of indexed) {
    const reserve = byIndex.get(index);
    if (reserve === undefined) {
      throw new Error(
        `reindexByAssetId: position at reserve index ${index} (amount=${tokens.toString()}) has no matching reserve in pool ${pool.id}; refusing to treat as empty`,
      );
    }
    out.set(reserve.assetId, convert(reserve, tokens));
  }
  return out;
}

function snapshotFromPoolUser(pool: Pool, user: PoolUser): BlendPoolSnapshot {
  const { claimedTokens } = user.estimateEmissions(Array.from(pool.reserves.values()));
  return {
    poolId: pool.id,
    poolName: pool.metadata.name,
    poolVersion: pool.version,
    liabilities: toUnderlyingByAsset(user.positions.liabilities, pool, (r, d) =>
      r.toAssetFromDToken(d),
    ),
    collateral: toUnderlyingByAsset(user.positions.collateral, pool, (r, b) =>
      r.toAssetFromBToken(b),
    ),
    supply: toUnderlyingByAsset(user.positions.supply, pool, (r, b) => r.toAssetFromBToken(b)),
    emissions: user.emissions,
    backstopId: pool.metadata.backstop,
    claimableEmissionTokenIds: [...claimedTokens].sort((a, b) => a - b),
  };
}

// load a single user's positions from one pool
export async function loadUserPositionsForPool(
  network: NetworkConfig,
  userPublicKey: string,
  poolId: string,
  loader: BlendPoolLoader = defaultBlendPoolLoader,
): Promise<BlendPoolSnapshot> {
  const { pool, user } = await loadPoolAndUser(network, poolId, userPublicKey, loader);
  return snapshotFromPoolUser(pool, user);
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

  const positions: BlendPoolSnapshot[] = [];
  const errors: BlendPoolLoadError[] = [];

  settled.forEach((result, i) => {
    const poolId = poolIds[i] ?? "<unknown>";
    if (result.status === "fulfilled") {
      positions.push(result.value);
    } else {
      const reason: unknown = result.reason;
      errors.push({
        poolId,
        stage: reason instanceof BlendLoadStageError ? reason.stage : "pool",
        message: errorMessage(reason),
      });
    }
  });

  return { positions, errors };
}

// ── backstop deposits ────────────────────────────────────────────────────────
// blend backstop shares live in a separate contract, not the pool, so they don't
// show up in pool positions and don't block an account merge by themselves.
// every pool's backstop is read: active shares, queued (Q4W) shares, the part
// of the queue already unlocked, when the still-locked part unlocks, and BLND
// emissions accrued to the user.

export interface BackstopUserState {
  readonly shares: bigint;
  readonly totalQ4W: bigint;
  readonly unlockedQ4W: bigint;
  // estimated BLND (7 decimals) a claim would pay into the backstop for the user
  readonly accruedEmissions: bigint;
  // when the last still-locked queue entry unlocks; unset when none is locked
  readonly latestQueueUnlocksAt?: Date;
}

export interface BackstopDeposit {
  readonly poolId: string;
  readonly backstopId: string;
  readonly backstopVersion: "V1" | "V2";
  readonly shares: bigint;
  readonly queuedForWithdrawal: bigint;
  readonly unlockedQueuedForWithdrawal: bigint;
  readonly accruedEmissions: bigint;
  readonly queueDurationSeconds: number;
  readonly latestQueueUnlocksAt?: Date;
}

export interface BackstopDepositLoader {
  loadUser(
    network: BlendSdkNetwork,
    backstop: BlendBackstopRef,
    poolId: string,
    userId: string,
  ): Promise<BackstopUserState>;
}

// the SDK's own accrual formula (UserEmissions.estimateAccrual) kept in integer
// units: stored accrual plus shares times the index growth since the user's
// last update. queued shares earn nothing, which is why only balance.shares
// counts.
export function estimateBackstopEmissions(user: BackstopPoolUser, pool: BackstopPool): bigint {
  const stored = user.emissions?.accrued ?? 0n;
  const shares = user.balance.shares;
  if (shares === 0n || pool.emissions === undefined) return stored;
  const userIndex = user.emissions?.index ?? 0n;
  const scalar = 10n ** BigInt(pool.emissions.epsDecimals);
  return stored + (shares * (pool.emissions.index - userIndex)) / scalar;
}

// the sdk parses the queue at load time and keeps in q4w only the entries that
// are still locked (exp in unix seconds), so the latest of those is when the
// whole existing queue can be withdrawn. a queue a close is about to add locks
// for the full duration from when it lands, which the plan dates on its own.
export function latestQueueUnlocksAt(balance: { readonly q4w: readonly Q4W[] }): Date | undefined {
  let latest: bigint | undefined;
  for (const entry of balance.q4w) {
    if (latest === undefined || entry.exp > latest) latest = entry.exp;
  }
  return latest === undefined ? undefined : new Date(Number(latest) * 1000);
}

export const defaultBackstopDepositLoader: BackstopDepositLoader = {
  async loadUser(network, backstop, poolId, userId) {
    const user = await BackstopPoolUser.load(network, backstop.id, poolId, userId);
    let accruedEmissions = user.emissions?.accrued ?? 0n;
    if (user.balance.shares > 0n) {
      const pool =
        backstop.version === "V1"
          ? await BackstopPoolV1.load(network, backstop.id, poolId)
          : await BackstopPoolV2.load(network, backstop.id, poolId);
      accruedEmissions = estimateBackstopEmissions(user, pool);
    }
    const unlocksAt = latestQueueUnlocksAt(user.balance);
    return {
      shares: user.balance.shares,
      totalQ4W: user.balance.totalQ4W,
      unlockedQ4W: user.balance.unlockedQ4W,
      accruedEmissions,
      ...(unlocksAt === undefined ? {} : { latestQueueUnlocksAt: unlocksAt }),
    };
  },
};

// accrual left to a user with no shares and nothing queued
export interface BackstopUnclaimedEmissions {
  readonly poolId: string;
  readonly backstopId: string;
  readonly accruedEmissions: bigint;
}

export interface LoadBackstopDepositsResult {
  // active or queued shares: these keep the account open
  readonly deposits: readonly BackstopDeposit[];
  // emissions with no shares behind them. queue_withdrawal stores the accrual up
  // to that moment, so every withdrawn deposit leaves some; claiming it mints new
  // shares under a fresh lock, so it is reported but never blocks the merge.
  readonly unclaimedEmissions: readonly BackstopUnclaimedEmissions[];
  readonly errors: readonly string[];
}

// detect any active or queued backstop position across the pools, each read
// against the backstop the pool itself names. a read failure or an unknown
// backstop is reported (not swallowed), so an RPC error is never treated as "no
// backstop position".
export async function loadBackstopDeposits(
  network: NetworkConfig,
  userPublicKey: string,
  pools: readonly { readonly poolId: string; readonly backstopId: string }[],
  loader: BackstopDepositLoader = defaultBackstopDepositLoader,
): Promise<LoadBackstopDepositsResult> {
  const deposits: BackstopDeposit[] = [];
  const unclaimedEmissions: BackstopUnclaimedEmissions[] = [];
  const errors: string[] = [];
  const settled = await Promise.allSettled(
    pools.map(async ({ poolId, backstopId }) => {
      const backstop = resolveKnownBackstop(network, backstopId);
      const state = await withBlendFailover(network, (sdkNetwork) =>
        loader.loadUser(sdkNetwork, backstop, poolId, userPublicKey),
      );
      return { backstop, state };
    }),
  );
  settled.forEach((result, i) => {
    const poolId = pools[i]?.poolId ?? "<unknown>";
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      errors.push(`backstop read failed for pool ${poolId}: ${errorMessage(reason)}`);
      return;
    }
    const { backstop, state } = result.value;
    if (state.shares === 0n && state.totalQ4W === 0n) {
      if (state.accruedEmissions > 0n) {
        unclaimedEmissions.push({
          poolId,
          backstopId: backstop.id,
          accruedEmissions: state.accruedEmissions,
        });
      }
      return;
    }
    deposits.push({
      poolId,
      backstopId: backstop.id,
      backstopVersion: backstop.version,
      shares: state.shares,
      queuedForWithdrawal: state.totalQ4W,
      unlockedQueuedForWithdrawal: state.unlockedQ4W,
      accruedEmissions: state.accruedEmissions,
      queueDurationSeconds: backstop.queueDurationSeconds,
      ...(state.latestQueueUnlocksAt === undefined
        ? {}
        : { latestQueueUnlocksAt: state.latestQueueUnlocksAt }),
    });
  });
  return { deposits, unclaimedEmissions, errors };
}
