// central slippage policy

export const DEFAULT_SLIPPAGE_BPS = 100;
export const MIN_SLIPPAGE_BPS = 10;
export const MAX_SLIPPAGE_BPS = 500;
export const BPS_DENOMINATOR = 10_000;

// a set but unusable slippage variable. thrown rather than replaced by the
// default: an operator typo must not silently change money-path protection
export class SlippageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlippageConfigError";
  }
}

// NEXT_PUBLIC_SLIPPAGE_BPS: unset or blank means DEFAULT_SLIPPAGE_BPS; anything
// else must be a decimal integer in [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS]. exported
// for the build-time env schema, so a bad value fails the build.
export function parseSlippageBpsEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_SLIPPAGE_BPS;
  const v = raw.trim();
  const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < MIN_SLIPPAGE_BPS || n > MAX_SLIPPAGE_BPS) {
    throw new SlippageConfigError(
      `NEXT_PUBLIC_SLIPPAGE_BPS must be an integer from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}; got "${raw}"`,
    );
  }
  return n;
}

// NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS: unset or blank means 0; anything else must
// be a non-negative decimal integer of stroops
export function parseMinMarketOutEnv(raw: string | undefined): bigint {
  if (raw === undefined || raw.trim().length === 0) return 0n;
  const v = raw.trim();
  if (!/^\d+$/.test(v)) {
    throw new SlippageConfigError(
      `NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS must be a non-negative integer number of stroops; got "${raw}"`,
    );
  }
  return BigInt(v);
}

// The configured slippage tolerance for the whole close. This is the single
// source of truth for slippage across the plan (DeFi-exit floors and the classic
// path-payment / LP-withdraw floors), so there is one policy rather than two
// hardcoded constants.
export function resolveConfiguredSlippageBps(): number {
  return parseSlippageBpsEnv(process.env.NEXT_PUBLIC_SLIPPAGE_BPS);
}

// Absolute floor (stroops) for a market conversion's XLM output. A sell whose
// slippage-adjusted minimum output is at or below this is refused as
// value-destroying, and the asset is routed to issuer/destination disposal instead
// of being sold. Default 0: refuse only a sell that nets nothing (the classic-
// path analog of the aggregator/router's zero-output refusal), which catches an
// illiquid asset whose whole balance routes to dust without blocking a legitimate
// small sale. Raise via NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS for a stronger floor.
export function resolveMinMarketOutStroops(): bigint {
  return parseMinMarketOutEnv(process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS);
}

// True when a market sell yielding `expectedOutStroops` XLM is worth executing:
// its slippage-adjusted minimum output must exceed the absolute floor. A sell
// that nets nothing (or ≤ the configured floor) is value-destroying — refuse it.
export function isMarketSellAcceptable(
  expectedOutStroops: bigint,
  bps: number,
  floorStroops: bigint,
): boolean {
  if (expectedOutStroops <= 0n) return false;
  const minAccepted = BigInt(applySlippageMin(expectedOutStroops.toString(), bps));
  return minAccepted > floorStroops;
}

// validate a slippage-bps value
export function clampSlippage(bps: number): number {
  if (!Number.isFinite(bps)) {
    throw new RangeError(`slippage bps must be a finite number; got ${bps}`);
  }
  if (!Number.isInteger(bps)) {
    throw new RangeError(`slippage bps must be an integer; got ${bps}`);
  }
  if (bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
    throw new RangeError(
      `slippage bps out of range [${MIN_SLIPPAGE_BPS}, ${MAX_SLIPPAGE_BPS}]; got ${bps}`,
    );
  }
  return bps;
}

// minimum-acceptable output = floor(expected * (10000 - bps) / 10000)
export function applySlippageMin(expectedAmount: string, bps: number): string {
  clampSlippage(bps);
  if (!/^\d+$/.test(expectedAmount)) {
    throw new TypeError(
      `applySlippageMin: expectedAmount must be a non-negative decimal-integer string; got "${expectedAmount}"`,
    );
  }
  const expected = BigInt(expectedAmount);
  const numerator = BigInt(BPS_DENOMINATOR - bps);
  const denominator = BigInt(BPS_DENOMINATOR);
  // integer floor division
  const min = (expected * numerator) / denominator;
  return min.toString();
}
