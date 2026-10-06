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
  // keys blend's claim(from, reserve_token_ids, to) expects). empty when there is
  // nothing to claim.
  readonly emissionReserveTokenIds: readonly number[];
}

// one aquarius AMM pool LP position
export interface AquariusPositionSummary {
  readonly poolIndex: string;
  readonly shareBalance: bigint;
  readonly tokens: readonly string[];
}

// one tick range of an aquarius concentrated position
export interface AquariusConcentratedRangeSummary {
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
}

// one aquarius concentrated-liquidity position. the liquidity sits in the pool
// contract itself (no share token), so each range needs its own
// withdraw_position, plus a fee collection and a reward claim. discovery only
// reports a pool with at least one live range, unpaid fees or a reward.
export interface AquariusConcentratedPositionSummary {
  readonly poolAddress: string;
  readonly poolIndex: string;
  readonly tokens: readonly string[];
  readonly ranges: readonly AquariusConcentratedRangeSummary[];
  // per token, in the order of tokens
  readonly pendingFees: readonly bigint[];
  readonly pendingReward: bigint;
}

// one soroswap LP position. pairs are two-asset constant-product pools
export interface SoroswapPositionSummary {
  readonly pair: {
    readonly tokenA: string;
    readonly tokenB: string;
  };
  readonly shareBalance: bigint;
}

// one blend backstop position with active or queued shares. the backstop is a
// separate contract from the lending pool (each pool names its own: v1 pools use
// the v1 backstop with a 21-day queue, v2 pools the v2 backstop with a 17-day
// queue). its withdrawal is queued and locked, so a close can only start it
// (queue_withdrawal) and finish it after the unlock (withdraw); any entry here
// blocks the final account merge. accruedEmissions is what a claim ahead of the
// queue would pay into new shares.
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

// backstop emissions accrued to a user who holds no backstop shares and nothing
// queued. queue_withdrawal stores the accrual up to that moment, so this is what
// is left once a queued deposit has been withdrawn. claiming it would mint new
// shares and restart the 17 or 21 day lock, so it never blocks the merge; it is
// reported so the user can be told what stays behind.
export interface BlendBackstopUnclaimedEmissions {
  readonly poolId: string;
  readonly backstopId: string;
  readonly accruedEmissions: bigint; // BLND, 7 decimals
}

// aggregated DeFi positions for one user. each protocol independent; partial failures
export interface ProtocolPositions {
  readonly blend: readonly BlendPositionSummary[];
  readonly backstop: readonly BlendBackstopSummary[];
  readonly aquarius: readonly AquariusPositionSummary[];
  readonly aquariusConcentrated: readonly AquariusConcentratedPositionSummary[];
  readonly soroswap: readonly SoroswapPositionSummary[];
  // informational only: never counted as an open position
  readonly backstopUnclaimedEmissions: readonly BlendBackstopUnclaimedEmissions[];
  readonly errors: readonly { protocol: string; message: string }[];
}

// one provider: our own on-chain discovery. the chain does not index positions,
// so it probes each protocol's contracts.
export type DeFiPositionProviderName = "direct";

// common shape every position-discovery adapter implements
export interface IDeFiPositionProvider {
  readonly name: DeFiPositionProviderName;
  // lightweight probe; MUST NOT throw. returns false when source isn't reachable
  isAvailable(): Promise<boolean>;
  // per-protocol failures are collected into ProtocolPositions.errors, not thrown
  getPositions(userAddress: string, network: NetworkConfig): Promise<ProtocolPositions>;
}

// the positions that keep the account from merging: every protocol list except
// the informational backstopUnclaimedEmissions. the merge-time reprobe and the
// preview must count with this, so a new position kind is counted in one place.
export function openPositionCount(p: ProtocolPositions): number {
  return (
    p.blend.length +
    p.backstop.length +
    p.aquarius.length +
    p.aquariusConcentrated.length +
    p.soroswap.length
  );
}

// empty constant for the "nothing to report" case
export const EMPTY_POSITIONS: ProtocolPositions = Object.freeze({
  blend: Object.freeze([]) as readonly BlendPositionSummary[],
  backstop: Object.freeze([]) as readonly BlendBackstopSummary[],
  aquarius: Object.freeze([]) as readonly AquariusPositionSummary[],
  aquariusConcentrated: Object.freeze([]) as readonly AquariusConcentratedPositionSummary[],
  soroswap: Object.freeze([]) as readonly SoroswapPositionSummary[],
  backstopUnclaimedEmissions: Object.freeze([]) as readonly BlendBackstopUnclaimedEmissions[],
  errors: Object.freeze([]) as readonly { protocol: string; message: string }[],
});
