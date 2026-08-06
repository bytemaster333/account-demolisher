// direct contract provider: always-available position discovery via in-process
import {
  loadBackstopDeposits,
  loadUserPositions,
  type LoadUserPositionsResult,
  type BlendPoolLoader,
  type BlendUserPositions,
} from "@/lib/adapters/blend/client";
import { resolveBackstopId } from "@/lib/adapters/blend/constants";
import { BLEND_MAINNET_POOL_IDS, BLEND_TESTNET_POOL_IDS } from "@/lib/adapters/blend/pools";
import {
  AquariusAPIPoolProvider,
  AquariusEventScanPoolProvider,
  type AquariusPool,
  type AquariusPoolProvider,
} from "@/lib/adapters/aquarius/pools";
import { getUserVaults, type FxDAOVault } from "@/lib/adapters/fxdao/client";
import { discoverSoroswapPositions } from "@/lib/adapters/soroswap/discovery";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { rpc } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import {
  type AquariusPositionSummary,
  type BlendBackstopSummary,
  type BlendPositionSummary,
  type FxDAOPositionSummary,
  type IDeFiPositionProvider,
  type ProtocolPositions,
  type SoroswapPositionSummary,
} from "./interface";
import {
  aquariusPositionSchema,
  blendBackstopSchema,
  blendPositionSchema,
  fxdaoPositionSchema,
  parsePositions,
  soroswapPositionSchema,
} from "./schema";

// default aquarius factory: try the REST provider first, fall back to event-scan
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

// pluggable deps for testability. each external call site (blend SDK loader, aquarius
export interface DirectContractProviderDeps {
  readonly blendPoolLoader?: BlendPoolLoader;
  readonly blendPoolIds?: readonly string[];
  readonly blendLoadUserPositions?: typeof loadUserPositions;
  readonly blendLoadBackstopDeposits?: typeof loadBackstopDeposits;
  readonly aquariusFactory?: AquariusProviderFactory;
  readonly fxdaoGetUserVaults?: typeof getUserVaults;
  readonly serverFactory?: (network: NetworkConfig) => rpc.Server;
}

export class DirectContractProvider implements IDeFiPositionProvider {
  readonly name = "direct" as const;
  private readonly deps: Required<
    Pick<
      DirectContractProviderDeps,
      | "blendPoolIds"
      | "blendLoadUserPositions"
      | "blendLoadBackstopDeposits"
      | "aquariusFactory"
      | "fxdaoGetUserVaults"
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
      blendLoadBackstopDeposits: deps.blendLoadBackstopDeposits ?? loadBackstopDeposits,
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
      backstop: [] as readonly BlendBackstopSummary[],
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
      backstop: blendResult.backstop,
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
    backstop: readonly BlendBackstopSummary[];
    perPoolErrors: readonly string[];
  }> {
    // pick pool ids per network unless the caller injected an explicit override
    const poolIds =
      this.deps.blendPoolIds.length > 0 &&
      this.deps.blendPoolIds !== BLEND_MAINNET_POOL_IDS &&
      this.deps.blendPoolIds !== BLEND_TESTNET_POOL_IDS
        ? this.deps.blendPoolIds
        : network.id === "testnet"
          ? BLEND_TESTNET_POOL_IDS
          : BLEND_MAINNET_POOL_IDS;
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

    const positions = result.positions
      .filter(hasAnyNonZeroBlendBalance)
      .map(blendUserPositionsToSummary);

    const perPoolErrors = result.errors.map(
      (e) => `pool ${e.poolId} stage=${e.stage}: ${e.message}`,
    );

    // Backstop shares are a SEPARATE Blend position class (a distinct contract).
    // The close now QUEUES the 17-day withdrawal (a BackstopQueue plan node) and
    // shows the unlock date, but cannot complete it in one session, so a detected
    // backstop is surfaced as a structured position that also blocks the final
    // merge (the account must survive to receive the withdrawal). Where no
    // backstop contract is snapshotted (futurenet) resolveBackstopId returns null
    // and the check is skipped. A read error is reported (never swallowed) so an
    // unreadable backstop is never treated as "none".
    const backstopSummaries: BlendBackstopSummary[] = [];
    const backstopId = resolveBackstopId(network);
    if (backstopId !== null) {
      try {
        const backstop = await this.deps.blendLoadBackstopDeposits(
          network,
          userAddress,
          poolIds,
          backstopId,
        );
        for (const d of backstop.deposits) {
          backstopSummaries.push({
            poolId: d.poolId,
            shares: d.shares,
            queuedForWithdrawal: d.queuedForWithdrawal,
          });
        }
        perPoolErrors.push(...backstop.errors);
      } catch (e) {
        perPoolErrors.push(
          `Blend backstop check failed; could not confirm you have no backstop deposit ` +
            `(${e instanceof Error ? e.message : String(e)}).`,
        );
      }
    }

    // schema-validate before returning: a malformed balance / bad contract id
    // throws, which the getPositions allSettled turns into a blend discovery
    // error (fail-closed) instead of carrying bad data into the plan.
    return {
      positions: parsePositions(blendPositionSchema, positions),
      backstop: parsePositions(blendBackstopSchema, backstopSummaries),
      perPoolErrors,
    };
  }

  private async discoverAquarius(
    server: rpc.Server,
    network: NetworkConfig,
    userAddress: string,
  ): Promise<readonly AquariusPositionSummary[]> {
    const { primary, fallback } = this.deps.aquariusFactory(server, network);

    // Union the REST API result with the on-chain event scan. The Aquarius REST
    // backend is attacker-influenceable: a compromised/spoofed response can return
    // a well-formed EMPTY or PARTIAL list to HIDE a held LP position. The old
    // catch-only fallback (event-scan ran ONLY when the API THREW) never caught
    // that — a hidden pool was merged around and stranded. So run both and merge
    // by pool index; a pool that EITHER source finds is reported. Only when BOTH
    // fail do we propagate a discovery error (which blocks a clean close).
    const [apiResult, scanResult] = await Promise.allSettled([
      primary.getUserPools(userAddress),
      fallback.getUserPools(userAddress),
    ]);

    if (apiResult.status === "rejected" && scanResult.status === "rejected") {
      const apiMsg =
        apiResult.reason instanceof Error ? apiResult.reason.message : String(apiResult.reason);
      const scanMsg =
        scanResult.reason instanceof Error ? scanResult.reason.message : String(scanResult.reason);
      throw new Error(`Aquarius discovery failed: REST=${apiMsg}; event-scan fallback=${scanMsg}`);
    }

    const byIndex = new Map<string, AquariusPool>();
    for (const result of [apiResult, scanResult]) {
      if (result.status === "fulfilled") {
        for (const pool of result.value) byIndex.set(pool.poolIndex, pool);
      }
    }

    return parsePositions(aquariusPositionSchema, [...byIndex.values()].map(aquariusPoolToSummary));
  }

  // our own on-chain Soroswap LP discovery: walks the factory's pair list and
  // probes the user's LP balance on each pair. No third-party position API.
  private async discoverSoroswap(
    server: rpc.Server,
    network: NetworkConfig,
    userAddress: string,
  ): Promise<readonly SoroswapPositionSummary[]> {
    return parsePositions(
      soroswapPositionSchema,
      await discoverSoroswapPositions(server, network, userAddress),
    );
  }

  private async discoverFxDAO(
    userAddress: string,
    network: NetworkConfig,
  ): Promise<readonly FxDAOPositionSummary[]> {
    const vaults: FxDAOVault[] = await this.deps.fxdaoGetUserVaults(userAddress, network);
    return parsePositions(fxdaoPositionSchema, vaults.map(fxdaoVaultToSummary));
  }
}

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
    // the emissions map is keyed by reserve_token_id; those keys ARE the ids
    // claim() expects. Sorted for deterministic plan output.
    emissionReserveTokenIds: Array.from(p.emissions.keys()).sort((a, b) => a - b),
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
