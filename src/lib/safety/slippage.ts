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

// the slippage tolerance for the whole close: one policy for the defi-exit
// floors and the classic path-payment and lp-withdraw floors
export function resolveConfiguredSlippageBps(): number {
  return parseSlippageBpsEnv(process.env.NEXT_PUBLIC_SLIPPAGE_BPS);
}

// absolute floor (stroops) for a market conversion's xlm output. a sell whose
// slippage-adjusted minimum output is at or below it is refused and the asset
// goes to the issuer or destination disposal instead. the default 0 refuses only
// a sell that rounds to nothing after slippage; it does not catch a large balance
// sold far below its fair rate, which is the price-impact cap's job (measured
// against the reference quote). NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS raises it.
export function resolveMinMarketOutStroops(): bigint {
  return parseMinMarketOutEnv(process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS);
}

// true when the slippage-adjusted minimum output of a sell yielding
// expectedOutStroops exceeds the absolute floor
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
