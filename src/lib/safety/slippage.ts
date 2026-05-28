// central slippage policy.
//
// every soroban swap and every classical path-payment conversion clamps
// user-supplied slippage through this module.
//   - default 1.00% (100 bps).
//   - allowed override range [10, 500] bps (0.10% - 5.00%). out-of-range
//     values are rejected, not silently clamped.
//   - applySlippageMin produces a stroop-precise floor of expected * (10000 - bps) / 10000
//     as a decimal string, using exact bigint math.

export const DEFAULT_SLIPPAGE_BPS = 100;
export const MIN_SLIPPAGE_BPS = 10;
export const MAX_SLIPPAGE_BPS = 500;
export const BPS_DENOMINATOR = 10_000;

// thrown when an executed swap returns less than the slippage-min.
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

// validate a slippage-bps value. throws RangeError on bad input — we don't
// silently clamp because out-of-range values usually signal a bug or a
// bypass attempt.
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

// minimum-acceptable output = floor(expected * (10000 - bps) / 10000).
// exact bigint math; result is the integer floor (we never accept more
// slippage than policy permits).
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
  // integer floor division.
  const min = (expected * numerator) / denominator;
  return min.toString();
}
