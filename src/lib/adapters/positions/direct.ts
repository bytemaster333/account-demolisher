// direct contract provider: always-available position discovery via in-process
// reads of each protocol's contracts
import {
  loadBackstopDeposits,
  loadUserPositions,
  type BlendPoolLoader,
  type BlendPoolSnapshot,
  type LoadUserPositionsResult,
} from "@/lib/adapters/blend/client";
import { blendPoolIdsForNetwork } from "@/lib/adapters/blend/pools";
import {
  AquariusAPIPoolProvider,
  AquariusEventScanPoolProvider,
  type AquariusPool,
  type AquariusPoolProvider,
} from "@/lib/adapters/aquarius/pools";
import { discoverConcentratedPositions } from "@/lib/adapters/aquarius/concentrated";
import { discoverSoroswapPositions } from "@/lib/adapters/soroswap/discovery";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { rpc } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import {
  type AquariusConcentratedPositionSummary,
  type AquariusPositionSummary,
  type BlendBackstopSummary,
  type BlendBackstopUnclaimedEmissions,
  type BlendPositionSummary,
  type IDeFiPositionProvider,
  type ProtocolPositions,
  type SoroswapPositionSummary,
} from "./interface";
import {
  aquariusConcentratedPositionSchema,
  aquariusPositionSchema,
  blendBackstopSchema,
  blendBackstopUnclaimedSchema,
  blendPositionSchema,
  parsePositions,
  soroswapPositionSchema,
} from "./schema";

// each protocol gets its own budget, below the 30 s the page flow allows the
// whole discovery, so a slow protocol is named in errors while the others'
// results are kept
export const DEFAULT_PROTOCOL_TIMEOUT_MS = 25_000;

// aquarius sources: the REST API (primary) and the on-chain event scan
export interface AquariusProviderFactory {
  (
    server: rpc.Server,
    network: NetworkConfig,
  ): {
    readonly primary: AquariusPoolProvider;
    readonly fallback: AquariusPoolProvider;
  };
}

const defaultAquariusFactory: AquariusProviderFactory = (server, network) => ({
  primary: new AquariusAPIPoolProvider({ server, network }),
  fallback: new AquariusEventScanPoolProvider({ server, network }),
});

// pluggable deps for testability, one per external call site
export interface DirectContractProviderDeps {
  readonly blendPoolLoader?: BlendPoolLoader;
  // explicit pool list; when absent the network's registry is scanned
  readonly blendPoolIds?: readonly string[];
  readonly blendLoadUserPositions?: typeof loadUserPositions;
  readonly blendLoadBackstopDeposits?: typeof loadBackstopDeposits;
  readonly aquariusFactory?: AquariusProviderFactory;
  readonly aquariusDiscoverConcentrated?: typeof discoverConcentratedPositions;
  readonly soroswapDiscover?: typeof discoverSoroswapPositions;
  readonly serverFactory?: (network: NetworkConfig) => rpc.Server;
  readonly protocolTimeoutMs?: number;
}

type ProtocolError = { protocol: string; message: string };

export class DirectContractProvider implements IDeFiPositionProvider {
  readonly name = "direct" as const;
  private readonly deps: Required<
    Pick<
      DirectContractProviderDeps,
      | "blendLoadUserPositions"
      | "blendLoadBackstopDeposits"
      | "aquariusFactory"
      | "aquariusDiscoverConcentrated"
      | "soroswapDiscover"
      | "protocolTimeoutMs"
    >
  > & {
    readonly blendPoolLoader: BlendPoolLoader | undefined;
    readonly blendPoolIds: readonly string[] | undefined;
    readonly serverFactory: (network: NetworkConfig) => rpc.Server;
  };

  constructor(deps: DirectContractProviderDeps = {}) {
    this.deps = {
      blendPoolLoader: deps.blendPoolLoader,
      blendPoolIds: deps.blendPoolIds,
      blendLoadUserPositions: deps.blendLoadUserPositions ?? loadUserPositions,
      blendLoadBackstopDeposits: deps.blendLoadBackstopDeposits ?? loadBackstopDeposits,
      aquariusFactory: deps.aquariusFactory ?? defaultAquariusFactory,
      aquariusDiscoverConcentrated:
        deps.aquariusDiscoverConcentrated ?? discoverConcentratedPositions,
      soroswapDiscover: deps.soroswapDiscover ?? discoverSoroswapPositions,
      serverFactory: deps.serverFactory ?? defaultServerFactory,
      protocolTimeoutMs: deps.protocolTimeoutMs ?? DEFAULT_PROTOCOL_TIMEOUT_MS,
    };
  }

  // chain is the source of truth, no external probe needed
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getPositions(userAddress: string, network: NetworkConfig): Promise<ProtocolPositions> {
    const server = this.deps.serverFactory(network);

    // each protocol independent and on its own budget; allSettled so any one
    // rejecting or timing out doesn't abort the others
    const budget = this.deps.protocolTimeoutMs;
    const [blendSettled, aquariusSettled, soroswapSettled] = await Promise.allSettled([
      withBudget(() => this.discoverBlend(network, userAddress), budget),
      withBudget(() => this.discoverAquarius(server, network, userAddress), budget),
      withBudget(() => this.discoverSoroswap(server, network, userAddress), budget),
    ]);

    const errors: ProtocolError[] = [];

    const blendResult = unwrap("blend", blendSettled, errors, {
      positions: [] as readonly BlendPositionSummary[],
      backstop: [] as readonly BlendBackstopSummary[],
      unclaimedEmissions: [] as readonly BlendBackstopUnclaimedEmissions[],
      perPoolErrors: [] as readonly string[],
    });
    const aquariusResult = unwrap("aquarius", aquariusSettled, errors, {
      positions: [] as readonly AquariusPositionSummary[],
      concentrated: [] as readonly AquariusConcentratedPositionSummary[],
      sourceErrors: [] as readonly string[],
    });
    const soroswap = unwrap(
      "soroswap",
      soroswapSettled,
      errors,
      [] as readonly SoroswapPositionSummary[],
    );

    // per-pool and per-source failures are errors too: each one means a
    // position may exist that discovery could not see
    for (const e of blendResult.perPoolErrors) errors.push({ protocol: "blend", message: e });
    for (const e of aquariusResult.sourceErrors) errors.push({ protocol: "aquarius", message: e });

    return {
      blend: blendResult.positions,
      backstop: blendResult.backstop,
      aquarius: aquariusResult.positions,
      aquariusConcentrated: aquariusResult.concentrated,
      soroswap,
      backstopUnclaimedEmissions: blendResult.unclaimedEmissions,
      errors,
    };
  }

  private async discoverBlend(
    network: NetworkConfig,
    userAddress: string,
  ): Promise<{
    positions: readonly BlendPositionSummary[];
    backstop: readonly BlendBackstopSummary[];
    unclaimedEmissions: readonly BlendBackstopUnclaimedEmissions[];
    perPoolErrors: readonly string[];
  }> {
    const poolIds = this.deps.blendPoolIds ?? blendPoolIdsForNetwork(network);
    // omit the 4th arg so the SDK-backed loader default is used when no override is wired
    const result: LoadUserPositionsResult =
      this.deps.blendPoolLoader !== undefined
        ? await this.deps.blendLoadUserPositions(
            network,
            userAddress,
            poolIds,
            this.deps.blendPoolLoader,
          )
        : await this.deps.blendLoadUserPositions(network, userAddress, poolIds);

    const positions = result.positions.filter(hasBlendPosition).map(blendSnapshotToSummary);

    const perPoolErrors = result.errors.map(
      (e) => `pool ${e.poolId} stage=${e.stage}: ${e.message}`,
    );

    // backstop deposits live in a separate contract, and each pool names its own
    // backstop in its metadata (v1 pools use the v1 backstop), so every loaded
    // pool is checked against that backstop. a pool that failed to load already
    // carries an error above, which blocks the merge on its own.
    const backstopSummaries: BlendBackstopSummary[] = [];
    const unclaimed: BlendBackstopUnclaimedEmissions[] = [];
    try {
      const backstop = await this.deps.blendLoadBackstopDeposits(
        network,
        userAddress,
        result.positions.map((p) => ({ poolId: p.poolId, backstopId: p.backstopId })),
      );
      for (const d of backstop.deposits) {
        backstopSummaries.push({
          poolId: d.poolId,
          shares: d.shares,
          queuedForWithdrawal: d.queuedForWithdrawal,
          backstopId: d.backstopId,
          unlockedQueuedForWithdrawal: d.unlockedQueuedForWithdrawal,
          accruedEmissions: d.accruedEmissions,
          queueDurationSeconds: d.queueDurationSeconds,
          ...(d.latestQueueUnlocksAt === undefined
            ? {}
            : { latestQueueUnlocksAt: d.latestQueueUnlocksAt }),
        });
      }
      unclaimed.push(...backstop.unclaimedEmissions);
      perPoolErrors.push(...backstop.errors);
    } catch (e) {
      perPoolErrors.push(
        `Blend backstop check failed; could not confirm you have no backstop deposit ` +
          `(${errorMessage(e)}).`,
      );
    }

    // schema-validate before returning: a malformed balance / bad contract id
    // throws, which the getPositions allSettled turns into a blend discovery
    // error (fail-closed) instead of carrying bad data into the plan.
    return {
      positions: parsePositions(blendPositionSchema, positions),
      backstop: parsePositions(blendBackstopSchema, backstopSummaries),
      unclaimedEmissions: parsePositions(blendBackstopUnclaimedSchema, unclaimed),
      perPoolErrors,
    };
  }

  private async discoverAquarius(
    server: rpc.Server,
    network: NetworkConfig,
    userAddress: string,
  ): Promise<{
    positions: readonly AquariusPositionSummary[];
    concentrated: readonly AquariusConcentratedPositionSummary[];
    sourceErrors: readonly string[];
  }> {
    const { primary, fallback } = this.deps.aquariusFactory(server, network);

    // the REST API is the complete source for router (standard) pools. the
    // on-chain event scan only sees router deposit/withdraw events inside the
    // RPC's retention window (about the last 7 days) and never sees LP received
    // by transfer, so an empty scan is not evidence of no position. it runs
    // alongside REST as a check against a spoofed or partial REST answer, and the
    // two are unioned. when either source fails, whatever the other found (and
    // any pools REST did read before failing) is kept and an error is recorded,
    // so preview warns and the merge-time reprobe refuses to merge around a
    // position it could not rule out. a failed scan counts too: without it a REST
    // answer that left a recent pool out would go unchecked.
    // concentrated positions sit in the pool contracts, where neither source
    // looks, so every pinned concentrated pool is read directly.
    const [apiResult, scanResult, concentratedResult] = await Promise.allSettled([
      primary.getUserPools(userAddress),
      fallback.getUserPools(userAddress),
      this.deps.aquariusDiscoverConcentrated(server, network, userAddress),
    ]);

    const sourceErrors: string[] = [];
    if (apiResult.status === "rejected") {
      const apiMsg = errorMessage(apiResult.reason);
      if (scanResult.status === "rejected") {
        throw new Error(
          `Aquarius discovery failed: REST=${apiMsg}; event-scan fallback=${errorMessage(scanResult.reason)}`,
        );
      }
      sourceErrors.push(
        `Aquarius REST source failed (${apiMsg}); the on-chain scan only covers about the ` +
          `last 7 days, so an older Aquarius position could not be ruled out`,
      );
    } else if (scanResult.status === "rejected") {
      sourceErrors.push(
        `Aquarius on-chain scan failed (${errorMessage(scanResult.reason)}); the REST ` +
          `answer could not be checked against the chain, so a recent Aquarius position ` +
          `it left out could not be ruled out`,
      );
    }

    let concentrated: readonly AquariusConcentratedPositionSummary[] = [];
    if (concentratedResult.status === "rejected") {
      sourceErrors.push(errorMessage(concentratedResult.reason));
    } else {
      try {
        concentrated = parsePositions(aquariusConcentratedPositionSchema, concentratedResult.value);
      } catch (e) {
        sourceErrors.push(`Aquarius concentrated position failed validation: ${errorMessage(e)}`);
      }
    }

    // pool_index is only unique within a token set (the router's get_pools(tokens)
    // returns index -> pool), so the same index can name different pools for
    // different pairs. key by the sorted token set plus the index, which is
    // exactly what the router withdraw is addressed by.
    const byPool = new Map<string, AquariusPool>();
    if (apiResult.status === "rejected") {
      for (const pool of partialPools(apiResult.reason)) byPool.set(aquariusPoolKey(pool), pool);
    }
    for (const result of [apiResult, scanResult]) {
      if (result.status === "fulfilled") {
        for (const pool of result.value) byPool.set(aquariusPoolKey(pool), pool);
      }
    }

    return {
      positions: parsePositions(
        aquariusPositionSchema,
        [...byPool.values()].map(aquariusPoolToSummary),
      ),
      concentrated,
      sourceErrors,
    };
  }

  // our own on-chain soroswap LP discovery: walks the factory's pair list and
  // probes the user's LP balance on each pair. no third-party position API.
  private async discoverSoroswap(
    server: rpc.Server,
    network: NetworkConfig,
    userAddress: string,
  ): Promise<readonly SoroswapPositionSummary[]> {
    return parsePositions(
      soroswapPositionSchema,
      await this.deps.soroswapDiscover(server, network, userAddress),
    );
  }
}

// keep a pool with any balance, and one whose only content is accrued emissions
function hasBlendPosition(p: BlendPoolSnapshot): boolean {
  for (const v of p.liabilities.values()) if (v !== 0n) return true;
  for (const v of p.collateral.values()) if (v !== 0n) return true;
  for (const v of p.supply.values()) if (v !== 0n) return true;
  return p.claimableEmissionTokenIds.length > 0;
}

function blendSnapshotToSummary(p: BlendPoolSnapshot): BlendPositionSummary {
  return {
    poolId: p.poolId,
    liabilities: new Map(p.liabilities),
    collateral: new Map(p.collateral),
    supply: new Map(p.supply),
    emissionReserveTokenIds: [...p.claimableEmissionTokenIds].sort((a, b) => a - b),
  };
}

// a REST failure partway through the per-pool balance reads carries the pools
// that did read as partialPools. they still pass the schema check below.
function partialPools(reason: unknown): readonly AquariusPool[] {
  if (typeof reason !== "object" || reason === null || !("partialPools" in reason)) return [];
  const pools: unknown = reason.partialPools;
  return Array.isArray(pools) ? (pools as AquariusPool[]) : [];
}

function aquariusPoolKey(p: AquariusPool): string {
  return `${[...p.tokens].sort().join(",")}|${p.poolIndex.toLowerCase().replace(/^0x/u, "")}`;
}

function aquariusPoolToSummary(p: AquariusPool): AquariusPositionSummary {
  return {
    poolIndex: p.poolIndex,
    shareBalance: p.shareBalance,
    tokens: p.tokens,
  };
}

// settle with the protocol's result, or reject once the budget runs out. the
// timer is cleared either way so nothing stays scheduled; the slow work itself
// cannot be aborted, its late result is ignored.
function withBudget<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work(), timeout]).finally(() => clearTimeout(timer));
}

// generic allSettled unwrap: returns fulfilled value or fallback, stamping any rejection onto errors
function unwrap<T>(
  protocol: string,
  settled: PromiseSettledResult<T>,
  errors: ProtocolError[],
  fallback: T,
): T {
  if (settled.status === "fulfilled") return settled.value;
  errors.push({ protocol, message: errorMessage(settled.reason) });
  return fallback;
}

// default RPC factory; forwards to the memoized getRpc
function defaultServerFactory(network: NetworkConfig): rpc.Server {
  return getRpc(network);
}
