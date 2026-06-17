// IDeFiPositionProvider — abstraction over the three position-discovery adapters
import type { NetworkConfig } from "@/lib/config/networks";

// all numeric balances are bigint in the protocol's smallest integer unit. no floats

// one blend pool position. three balance maps because blend tracks them independently:
export interface BlendPositionSummary {
  readonly poolId: string;
  readonly liabilities: ReadonlyMap<string, bigint>;
  readonly collateral: ReadonlyMap<string, bigint>;
  readonly supply: ReadonlyMap<string, bigint>;
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

// aggregated DeFi positions for one user. each protocol independent; partial failures
export interface ProtocolPositions {
  readonly blend: readonly BlendPositionSummary[];
  readonly aquarius: readonly AquariusPositionSummary[];
  readonly soroswap: readonly SoroswapPositionSummary[];
  readonly fxdao: readonly FxDAOPositionSummary[];
  readonly errors: readonly { protocol: string; message: string }[];
}

// only one provider now: our own on-chain discovery. (OctoPos/Orion REST shells
// were removed — the chain doesn't index positions, so we probe contracts.)
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
  aquarius: Object.freeze([]) as readonly AquariusPositionSummary[],
  soroswap: Object.freeze([]) as readonly SoroswapPositionSummary[],
  fxdao: Object.freeze([]) as readonly FxDAOPositionSummary[],
  errors: Object.freeze([]) as readonly { protocol: string; message: string }[],
});
