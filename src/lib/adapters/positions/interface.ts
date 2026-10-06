// IDeFiPositionProvider: abstraction over position discovery
import type { NetworkConfig } from "@/lib/config/networks";

// all numeric balances are bigint in the protocol's smallest integer unit. no floats

// one blend pool position. three balance maps because blend tracks them
// independently, keyed by asset contract id. amounts are in the asset's own
// units: liabilities are the debt owed (not dTokens), collateral and supply what
// a full withdraw returns (not bTokens). a pool whose only content is accrued
// emissions is still reported, so its claim is planned and the merge-time
// reprobe keeps counting it until it is claimed.
export interface BlendPositionSummary {
  readonly poolId: string;
  readonly liabilities: ReadonlyMap<string, bigint>;
  readonly collateral: ReadonlyMap<string, bigint>;
  readonly supply: ReadonlyMap<string, bigint>;
  // reserve_token_ids with emissions accrued to this user in this pool (the u32
  // keys Blend's claim(from, reserve_token_ids, to) expects). Empty when there is
  // nothing to claim.
  readonly emissionReserveTokenIds: readonly number[];
}

// one aquarius AMM pool LP position
export interface AquariusPositionSummary {
  readonly poolIndex: string;
  readonly shareBalance: bigint;
  readonly tokens: readonly string[];
}

// one soroswap LP position. pairs are two-asset constant-product pools
export interface SoroswapPositionSummary {
  readonly pair: {
    readonly tokenA: string;
    readonly tokenB: string;
  };
  readonly shareBalance: bigint;
}

// one fxdao vault position
export interface FxDAOPositionSummary {
  readonly denomination: string;
  readonly debt: bigint;
  readonly collateral: bigint;
}

// one Blend backstop position. The backstop is a SEPARATE contract from the
// lending pool (each pool names its own: v1 pools use the v1 backstop with a
// 21-day queue, v2 pools the v2 backstop with a 17-day queue). Its withdrawal is
// queued and locked, so a close can only START it (queue_withdrawal) and finish
// it after the unlock; any entry here blocks the final account merge, including
// one whose only content is accrued emissions (a claim pays them into new
// backstop shares, which then need the same queue).
//
// discovery always sets the optional fields. they are optional only so a
// summary built by hand without them still means "nothing beyond shares and
// queue", which never weakens the merge guard because the guard counts entries.
export interface BlendBackstopSummary {
  readonly poolId: string;
  readonly shares: bigint; // active shares not yet queued
  readonly queuedForWithdrawal: bigint; // every share in the Q4W queue, locked or not
  readonly backstopId?: string;
  readonly unlockedQueuedForWithdrawal?: bigint; // queued shares past their unlock time
  readonly accruedEmissions?: bigint; // BLND (7 decimals) a backstop claim would add
  readonly queueDurationSeconds?: number;
}

// aggregated DeFi positions for one user. each protocol independent; partial failures
export interface ProtocolPositions {
  readonly blend: readonly BlendPositionSummary[];
  readonly backstop: readonly BlendBackstopSummary[];
  readonly aquarius: readonly AquariusPositionSummary[];
  readonly soroswap: readonly SoroswapPositionSummary[];
  readonly fxdao: readonly FxDAOPositionSummary[];
  readonly errors: readonly { protocol: string; message: string }[];
}

// only one provider now: our own on-chain discovery. (OctoPos/Orion REST shells
// were removed. The chain doesn't index positions, so we probe contracts.)
export type DeFiPositionProviderName = "direct";

// common shape every position-discovery adapter implements
export interface IDeFiPositionProvider {
  readonly name: DeFiPositionProviderName;
  // lightweight probe; MUST NOT throw. returns false when source isn't reachable
  isAvailable(): Promise<boolean>;
  // per-protocol failures are collected into ProtocolPositions.errors, not thrown
  getPositions(userAddress: string, network: NetworkConfig): Promise<ProtocolPositions>;
}

// empty constant for the "nothing to report" case
export const EMPTY_POSITIONS: ProtocolPositions = Object.freeze({
  blend: Object.freeze([]) as readonly BlendPositionSummary[],
  backstop: Object.freeze([]) as readonly BlendBackstopSummary[],
  aquarius: Object.freeze([]) as readonly AquariusPositionSummary[],
  soroswap: Object.freeze([]) as readonly SoroswapPositionSummary[],
  fxdao: Object.freeze([]) as readonly FxDAOPositionSummary[],
  errors: Object.freeze([]) as readonly { protocol: string; message: string }[],
});
