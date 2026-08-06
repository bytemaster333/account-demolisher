// central slippage policy

export const DEFAULT_SLIPPAGE_BPS = 100;
export const MIN_SLIPPAGE_BPS = 10;
export const MAX_SLIPPAGE_BPS = 500;
export const BPS_DENOMINATOR = 10_000;

// thrown when an executed swap returns less than the slippage-min
export class SlippageGuardTripped extends Error {
  public readonly expected: string;
  public readonly minimumAccepted: string;
  public readonly actual: string;
  public readonly slippageBps: number;

  constructor(args: {
    expected: string;
    minimumAccepted: string;
    actual: string;
    slippageBps: number;
  }) {
    super(
      `Slippage guard tripped: quote returned ${args.actual} (< minimum ${args.minimumAccepted} ` +
        `derived from expected ${args.expected} @ ${args.slippageBps} bps)`,
    );
    this.name = "SlippageGuardTripped";
    this.expected = args.expected;
    this.minimumAccepted = args.minimumAccepted;
    this.actual = args.actual;
    this.slippageBps = args.slippageBps;
  }
}

// The configured slippage tolerance for the whole close: NEXT_PUBLIC_SLIPPAGE_BPS
// when set to a valid in-range integer, else DEFAULT_SLIPPAGE_BPS. This is the
// SINGLE source of truth for slippage across the plan (DeFi-exit floors AND the
// classic path-payment / LP-withdraw floors), so there is one policy rather than
// two hardcoded constants. An out-of-range/malformed override falls back to the
// default rather than throwing, so a bad env value can never break plan-building.
export function resolveConfiguredSlippageBps(): number {
  const raw = process.env.NEXT_PUBLIC_SLIPPAGE_BPS;
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_SLIPPAGE_BPS;
  const n = Number(raw.trim());
  if (!Number.isInteger(n)) return DEFAULT_SLIPPAGE_BPS;
  try {
    return clampSlippage(n);
  } catch {
    return DEFAULT_SLIPPAGE_BPS;
  }
}

// Absolute floor (stroops) for a market conversion's XLM output. A sell whose
// slippage-adjusted minimum output is AT or BELOW this is refused as
// value-destroying — the asset is routed to issuer/destination disposal instead
// of being sold. Default 0: refuse only a sell that nets nothing (the classic-
// path analog of the aggregator/router's zero-output refusal), which catches an
// illiquid asset whose whole balance routes to dust without blocking a legitimate
// small sale. Raise via NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS for a stronger floor.
export function resolveMinMarketOutStroops(): bigint {
  const raw = process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS;
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return 0n;
  return BigInt(raw.trim());
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
