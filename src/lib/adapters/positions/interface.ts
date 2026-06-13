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

export type DeFiPositionProviderName = "orion" | "octopos" | "direct";

// common shape every position-discovery adapter implements
export interface IDeFiPositionProvider {
  readonly name: DeFiPositionProviderName;
  // lightweight probe; MUST NOT throw. returns false when source isn't reachable or configured
  isAvailable(): Promise<boolean>;
  // throws ProviderUnavailable when the source isn't reachable
  getPositions(userAddress: string, network: NetworkConfig): Promise<ProtocolPositions>;
}

// thrown when a provider's backing source isn't reachable. selector catches and falls over
export class ProviderUnavailable extends Error {
  readonly provider: DeFiPositionProviderName;
  override readonly cause: unknown;
  constructor(provider: DeFiPositionProviderName, message: string, cause?: unknown) {
    super(message);
    this.name = "ProviderUnavailable";
    this.provider = provider;
    this.cause = cause;
  }
}

// thrown when an upstream's response shape doesn't match the contract. hard failure
export class ProviderSchemaMismatch extends Error {
  readonly provider: DeFiPositionProviderName;
  readonly issues: string;
  constructor(provider: DeFiPositionProviderName, issues: string) {
    super(`Provider "${provider}" returned an invalid response: ${issues}`);
    this.name = "ProviderSchemaMismatch";
    this.provider = provider;
    this.issues = issues;
  }
}

// empty constant for the "nothing to report" case
export const EMPTY_POSITIONS: ProtocolPositions = Object.freeze({
  blend: Object.freeze([]) as readonly BlendPositionSummary[],
  aquarius: Object.freeze([]) as readonly AquariusPositionSummary[],
  soroswap: Object.freeze([]) as readonly SoroswapPositionSummary[],
  fxdao: Object.freeze([]) as readonly FxDAOPositionSummary[],
  errors: Object.freeze([]) as readonly { protocol: string; message: string }[],
});
