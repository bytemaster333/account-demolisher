/**
 * direct contract provider — always-available position discovery via in-process
 * soroban/horizon calls. aggregates blend, aquarius, soroswap, and fxdao in parallel
 * via Promise.allSettled so a single protocol failure becomes an errors[] entry
 * rather than aborting the response.
 *
 * soroswap discovery: gap — the SDK's getUserPositions sits behind the api-key path
 * and our /api/soroswap proxy doesn't currently route it. returns []; not an error.
 */

import {
  loadUserPositions,
  type LoadUserPositionsResult,
  type BlendPoolLoader,
  type BlendUserPositions,
} from "@/lib/adapters/blend/client";
import { BLEND_MAINNET_POOL_IDS } from "@/lib/adapters/blend/pools";
import {
  AquariusAPIPoolProvider,
  AquariusEventScanPoolProvider,
  type AquariusPool,
  type AquariusPoolProvider,
} from "@/lib/adapters/aquarius/pools";
import { getUserVaults, type FxDAOVault } from "@/lib/adapters/fxdao/client";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { rpc } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import {
  EMPTY_POSITIONS,
  type AquariusPositionSummary,
  type BlendPositionSummary,
  type FxDAOPositionSummary,
  type IDeFiPositionProvider,
  type ProtocolPositions,
  type SoroswapPositionSummary,
} from "./interface";

/**
 * default aquarius factory: try the REST provider first, fall back to event-scan
 * on failure. wired at call time since the REST endpoint can succeed for one user
 * and fail for another. injectable for tests.
 */
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

/**
 * pluggable deps for testability. each external call site (blend SDK loader, aquarius
 * factory, fxdao client) is reachable so tests inject deterministic stand-ins.
 */
export interface DirectContractProviderDeps {
  readonly blendPoolLoader?: BlendPoolLoader;
  readonly blendPoolIds?: readonly string[];
  readonly blendLoadUserPositions?: typeof loadUserPositions;
  readonly aquariusFactory?: AquariusProviderFactory;
  readonly fxdaoGetUserVaults?: typeof getUserVaults;
  readonly serverFactory?: (network: NetworkConfig) => rpc.Server;
}

export class DirectContractProvider implements IDeFiPositionProvider {
  readonly name = "direct" as const;
  private readonly deps: Required<
    Pick<
      DirectContractProviderDeps,
      "blendPoolIds" | "blendLoadUserPositions" | "aquariusFactory" | "fxdaoGetUserVaults"
    >
  > & {
    readonly blendPoolLoader: BlendPoolLoader | undefined;
    readonly serverFactory: (network: NetworkConfig) => rpc.Server;
  };

  constructor(deps: DirectContractProviderDeps = {}) {
    this.deps = {
      blendPoolLoader: deps.blendPoolLoader,
      blendPoolIds: deps.blendPoolIds ?? BLEND_MAINNET_POOL_IDS,
      blendLoadUserPositions: deps.blendLoadUserPositions ?? loadUserPositions,
      aquariusFactory: deps.aquariusFactory ?? defaultAquariusFactory,
      fxdaoGetUserVaults: deps.fxdaoGetUserVaults ?? getUserVaults,
      serverFactory: deps.serverFactory ?? defaultServerFactory,
    };
  }

  // chain is the source of truth, no external probe needed
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getPositions(userAddress: string, network: NetworkConfig): Promise<ProtocolPositions> {
    const server = this.deps.serverFactory(network);

    // each protocol independent; allSettled so any one rejecting doesn't abort the others
    const [blendSettled, aquariusSettled, soroswapSettled, fxdaoSettled] = await Promise.allSettled(
      [
        this.discoverBlend(network, userAddress),
        this.discoverAquarius(server, network, userAddress),
        this.discoverSoroswap(server, network, userAddress),
        this.discoverFxDAO(userAddress, network),
      ],
    );

    const errors: { protocol: string; message: string }[] = [];

    const blendResult = unwrap("blend", blendSettled, errors, {
      positions: [] as readonly BlendPositionSummary[],
      perPoolErrors: [] as readonly string[],
    });
    const aquarius = unwrap(
      "aquarius",
      aquariusSettled,
      errors,
      [] as readonly AquariusPositionSummary[],
    );
    const soroswap = unwrap(
      "soroswap",
      soroswapSettled,
      errors,
      [] as readonly SoroswapPositionSummary[],
    );
    const fxdao = unwrap("fxdao", fxdaoSettled, errors, [] as readonly FxDAOPositionSummary[]);

    // surface blend's per-pool failures as additional errors[] entries
    for (const e of blendResult.perPoolErrors) {
      errors.push({ protocol: "blend", message: e });
    }

    return {
      blend: blendResult.positions,
      aquarius,
      soroswap,
      fxdao,
      errors,
    };
  }

  private async discoverBlend(
    network: NetworkConfig,
    userAddress: string,
  ): Promise<{
    positions: readonly BlendPositionSummary[];
    perPoolErrors: readonly string[];
  }> {
    // omit the 4th arg so the SDK-backed loader default is used when no override is wired
    const result: LoadUserPositionsResult =
      this.deps.blendPoolLoader !== undefined
        ? await this.deps.blendLoadUserPositions(
            network,
            userAddress,
            this.deps.blendPoolIds,
            this.deps.blendPoolLoader,
          )
        : await this.deps.blendLoadUserPositions(network, userAddress, this.deps.blendPoolIds);

    const positions = result.positions
      .filter(hasAnyNonZeroBlendBalance)
      .map(blendUserPositionsToSummary);

    const perPoolErrors = result.errors.map(
      (e) => `pool ${e.poolId} stage=${e.stage}: ${e.message}`,
    );

    return { positions, perPoolErrors };
  }

  private async discoverAquarius(
    server: rpc.Server,
    network: NetworkConfig,
    userAddress: string,
  ): Promise<readonly AquariusPositionSummary[]> {
    const { primary, fallback } = this.deps.aquariusFactory(server, network);

    // try REST first; on failure fall over to event-scan. if both fail, propagate.
    let pools: AquariusPool[];
    try {
      pools = await primary.getUserPools(userAddress);
    } catch (errPrimary) {
      try {
        pools = await fallback.getUserPools(userAddress);
      } catch (errFallback) {
        const msgPrimary = errPrimary instanceof Error ? errPrimary.message : String(errPrimary);
        const msgFallback =
          errFallback instanceof Error ? errFallback.message : String(errFallback);
        throw new Error(
          `Aquarius discovery failed: REST=${msgPrimary}; event-scan fallback=${msgFallback}`,
        );
      }
    }

    return pools.map(aquariusPoolToSummary);
  }

  // soroswap getUserPositions isn't routed through our proxy yet; returns [] until wired
  private async discoverSoroswap(
    _server: rpc.Server,
    _network: NetworkConfig,
    _userAddress: string,
  ): Promise<readonly SoroswapPositionSummary[]> {
    return [];
  }

  private async discoverFxDAO(
    userAddress: string,
    network: NetworkConfig,
  ): Promise<readonly FxDAOPositionSummary[]> {
    const vaults: FxDAOVault[] = await this.deps.fxdaoGetUserVaults(userAddress, network);
    return vaults.map(fxdaoVaultToSummary);
  }
}

export { EMPTY_POSITIONS };

// drop a pool entry if every balance map is empty or all-zero
function hasAnyNonZeroBlendBalance(p: BlendUserPositions): boolean {
  for (const v of p.liabilities.values()) if (v !== 0n) return true;
  for (const v of p.collateral.values()) if (v !== 0n) return true;
  for (const v of p.supply.values()) if (v !== 0n) return true;
  return false;
}

function blendUserPositionsToSummary(p: BlendUserPositions): BlendPositionSummary {
  return {
    poolId: p.poolId,
    liabilities: new Map(p.liabilities),
    collateral: new Map(p.collateral),
    supply: new Map(p.supply),
  };
}

function aquariusPoolToSummary(p: AquariusPool): AquariusPositionSummary {
  return {
    poolIndex: p.poolIndex,
    shareBalance: p.shareBalance,
    tokens: p.tokens,
  };
}

function fxdaoVaultToSummary(v: FxDAOVault): FxDAOPositionSummary {
  return {
    denomination: v.denomination,
    debt: v.debt,
    collateral: v.collateral,
  };
}

// generic allSettled unwrap: returns fulfilled value or fallback, stamping any rejection onto errors
function unwrap<T>(
  protocol: string,
  settled: PromiseSettledResult<T>,
  errors: { protocol: string; message: string }[],
  fallback: T,
): T {
  if (settled.status === "fulfilled") return settled.value;
  const reason = settled.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  errors.push({ protocol, message });
  return fallback;
}

// default RPC factory; forwards to the memoized getRpc
function defaultServerFactory(network: NetworkConfig): rpc.Server {
  return getRpc(network);
}
