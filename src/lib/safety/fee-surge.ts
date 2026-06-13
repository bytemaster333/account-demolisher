// fee-surge protection

import type { NetworkConfig } from "@/lib/config/networks";

const BASE_FEE_STROOPS = 100n;
const MIN_FEE_CAP_MULTIPLIER = 100n;
const P99_CAP_MULTIPLIER = 2n;
const SURGE_THRESHOLD_MULTIPLIER = 10n;
const RECOMMENDED_MULTIPLIER = 5n;

export interface FeeAdvice {
  // recommended per-op fee, in stroops (decimal-integer string)
  readonly recommended: string;
  // maximum per-op fee the orchestrator should pay, in stroops
  readonly max: string;
  // true if the network is currently in a fee surge (p99 > min_fee * 10)
  readonly surge: boolean;
}

// partial /fee_stats shape — only fields we use
export interface FeeStatsLike {
  readonly last_ledger_base_fee?: string;
  readonly fee_charged?: {
    readonly min?: string;
    readonly mode?: string;
    readonly p70?: string;
    readonly p99?: string;
  };
  readonly max_fee?: {
    readonly min?: string;
    readonly mode?: string;
    readonly p70?: string;
    readonly p99?: string;
  };
}

// pure derivation
export function feeAdviceFromStats(stats: FeeStatsLike | null | undefined): FeeAdvice {
  if (!stats) return defaultAdvice();

  const ledgerBase = parsePositive(stats.last_ledger_base_fee) ?? BASE_FEE_STROOPS;
  const minFee = parsePositive(stats.fee_charged?.min) ?? ledgerBase;
  const p99 = parsePositive(stats.fee_charged?.p99) ?? minFee;
  const mode = parsePositive(stats.fee_charged?.mode);

  const capFromMin = minFee * MIN_FEE_CAP_MULTIPLIER;
  const capFromP99 = p99 * P99_CAP_MULTIPLIER;
  const max = bigIntMax(capFromMin, capFromP99);

  // prefer the mode when present; else 5x the ledger base. floor at
  // ledgerBase so we never undercut the published minimum
  const recommendedRaw = mode ?? ledgerBase * RECOMMENDED_MULTIPLIER;
  const recommended = bigIntMax(recommendedRaw, ledgerBase);

  const surge = p99 > minFee * SURGE_THRESHOLD_MULTIPLIER;

  return {
    recommended: recommended.toString(),
    max: max.toString(),
    surge,
  };
}

// cap an orchestrator-proposed fee at advice.max. malformed proposals are
// coerced to advice.recommended rather than passed through
export function applyFeeCap(proposed: string, advice: FeeAdvice): string {
  const max = parsePositive(advice.max) ?? BASE_FEE_STROOPS * MIN_FEE_CAP_MULTIPLIER;
  const p = parsePositive(proposed);
  if (p === null) return advice.recommended;
  if (p > max) return max.toString();
  return p.toString();
}

// fetch /fee_stats and derive the advice
export async function getCurrentFeeAdvice(
  network: NetworkConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<FeeAdvice> {
  const url = `${network.horizon.replace(/\/$/, "")}/fee_stats`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    return defaultAdvice();
  }

  if (!res.ok) return defaultAdvice();

  let body: FeeStatsLike;
  try {
    body = (await res.json()) as FeeStatsLike;
  } catch {
    return defaultAdvice();
  }

  return feeAdviceFromStats(body);
}

// conservative fallback when /fee_stats is unavailable
export function defaultAdvice(): FeeAdvice {
  return {
    recommended: (BASE_FEE_STROOPS * RECOMMENDED_MULTIPLIER).toString(),
    max: (BASE_FEE_STROOPS * MIN_FEE_CAP_MULTIPLIER).toString(),
    surge: false,
  };
}

function parsePositive(v: string | undefined | null): bigint | null {
  if (v === undefined || v === null) return null;
  const trimmed = String(v).trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  let n: bigint;
  try {
    n = BigInt(trimmed);
  } catch {
    return null;
  }
  return n > 0n ? n : null;
}

function bigIntMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
