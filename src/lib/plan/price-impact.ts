// price impact of a full-size conversion measured against a small reference trade
// through the same market. Shared by the classic path-payment conversions and the
// soroban held-token swap so both apply one cap.

// a conversion whose full-size rate is more than this far below the reference
// rate is never sold without an explicit per-asset confirmation
export const MAX_PRICE_IMPACT_BPS = 200;

// share of the balance quoted as the reference trade
export const REFERENCE_TRADE_DIVISOR = 1000n;

// impact in basis points, rounded up so the cap is never undercut by rounding.
// null when the reference cannot price the asset (zero in or out), which callers
// treat as "unpriced", not as "no impact".
export function priceImpactBps(
  fullIn: bigint,
  fullOut: bigint,
  referenceIn: bigint,
  referenceOut: bigint,
): number | null {
  if (fullIn <= 0n || referenceIn <= 0n || referenceOut <= 0n || fullOut < 0n) return null;
  // impact = 1 - (fullOut / fullIn) / (referenceOut / referenceIn)
  const referenceScaled = referenceOut * fullIn;
  const fullScaled = fullOut * referenceIn;
  if (fullScaled >= referenceScaled) return 0;
  const numerator = (referenceScaled - fullScaled) * 10_000n;
  const bps = (numerator + referenceScaled - 1n) / referenceScaled;
  return Number(bps);
}

// the reference slice of a balance: 1/1000 of it, at least one unit
export function referenceTradeAmount(fullIn: bigint): bigint {
  const slice = fullIn / REFERENCE_TRADE_DIVISOR;
  return slice > 0n ? slice : 1n;
}
