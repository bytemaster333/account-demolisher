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
