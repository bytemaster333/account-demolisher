/**
 * IDeFiPositionProvider — abstraction over the three position-discovery adapters
 * (OrionProvider, OctoposProvider, DirectContractProvider). orchestrator picks one
 * via selectProvider and only ever consumes getPositions.
 *
 * orion and octopos return isAvailable() === false and getPositions throws
 * ProviderUnavailable until their REST schemas ship. they MUST NEVER return
 * synthesized data; the selector falls over to DirectContractProvider.
 */

import type { NetworkConfig } from "@/lib/config/networks";

// all numeric balances are bigint in the protocol's smallest integer unit. no floats.

/**
 * one blend pool position. three balance maps because blend tracks them independently:
 *  - liabilities: outstanding borrows
 *  - collateral: supplied reserves posted as borrow collateral
 *  - supply: supplied reserves NOT posted as collateral (pure lend)
 *
 * each map is keyed by the SAC contract id of the underlying asset.
 */
export interface BlendPositionSummary {
  readonly poolId: string;
  readonly liabilities: ReadonlyMap<string, bigint>;
  readonly collateral: ReadonlyMap<string, bigint>;
  readonly supply: ReadonlyMap<string, bigint>;
}

/**
 * one aquarius AMM pool LP position.
 *  - poolIndex: BytesN<32> hex string
 *  - shareBalance: u128 base units
 *  - tokens: ordered pool asset contract ids
 */
export interface AquariusPositionSummary {
  readonly poolIndex: string;
  readonly shareBalance: bigint;
  readonly tokens: readonly string[];
}

/**
 * one soroswap LP position. pairs are two-asset constant-product pools.
 *  - pair: token A/B SAC ids (canonical soroswap ordering)
 *  - shareBalance: i128 base units
 */
export interface SoroswapPositionSummary {
  readonly pair: {
    readonly tokenA: string;
    readonly tokenB: string;
  };
  readonly shareBalance: bigint;
}

/**
 * one fxdao vault position.
 *  - denomination: synthetic-stablecoin code (USDx/EURx/GBPx)
 *  - debt: outstanding synthetic debt
 *  - collateral: XLM collateral locked in the vault (stroops)
 */
export interface FxDAOPositionSummary {
  readonly denomination: string;
  readonly debt: bigint;
  readonly collateral: bigint;
}

/**
 * aggregated DeFi positions for one user. each protocol independent; partial failures
 * surface in errors[] rather than blocking the response.
 */
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
  // lightweight probe; MUST NOT throw. returns false when source isn't reachable or configured.
  isAvailable(): Promise<boolean>;
  // throws ProviderUnavailable when the source isn't reachable
  getPositions(userAddress: string, network: NetworkConfig): Promise<ProtocolPositions>;
}

// thrown when a provider's backing source isn't reachable. selector catches and falls over.
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

// thrown when an upstream's response shape doesn't match the contract. hard failure.
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
