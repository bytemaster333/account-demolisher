// scam-token heuristics

import { isAllowedContract } from "@/lib/config/contracts";
import type { AssetIdentifier, AuditBalance } from "@/lib/types/account";

export type ScamSeverity = "info" | "warning" | "critical";

export type ScamHeuristicId =
  | "lookalike_symbol"
  | "exact_symbol_collision"
  | "suspicious_character"
  | "unknown_contract";

export interface ScamFlag {
  readonly id: ScamHeuristicId;
  readonly severity: ScamSeverity;
  // short user-presentable message. no html/markdown
  readonly message: string;
  // optional structured detail for ui rendering
  readonly detail?: Readonly<Record<string, string | number>>;
}

export interface TokenSubject {
  // human-readable name as published by the issuer/contract. may be empty
  readonly name?: string;
  // asset code / sep-41 symbol. may be empty
  readonly symbol?: string;
  // soroban contract id (c...) for sep-41 tokens. omit for classic trustlines
  readonly contractId?: string;
  // for classic trustlines: the issuer g-address. used to decide whether a
  // tier-1-matching symbol is the real asset or an impersonator
  readonly issuer?: string;
}

// tier-1 reference list. frozen at compile time
export interface Tier1Asset {
  readonly symbol: string;
  // issuer g-address, or null for native / sac-only assets
  readonly issuer: string | null;
}

export const TIER1_ASSETS: readonly Tier1Asset[] = [
  { symbol: "XLM", issuer: null },
  { symbol: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { symbol: "EURC", issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2" },
  { symbol: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
  { symbol: "BLND", issuer: null },
];

const TIER1_BY_SYMBOL: ReadonlyMap<string, Tier1Asset> = new Map(
  TIER1_ASSETS.map((a) => [a.symbol.toUpperCase(), a]),
);

// edit distance <= this (and > 0) counts as suspicious
const LOOKALIKE_DISTANCE_THRESHOLD = 2;

// run all heuristics against the subject
export function evaluateScamHeuristics(subject: TokenSubject): readonly ScamFlag[] {
  const flags: ScamFlag[] = [];

  const rawSymbol = (subject.symbol ?? "").trim();
  if (rawSymbol.length > 0) {
    const symbolUpper = rawSymbol.toUpperCase();
    const tier1 = TIER1_BY_SYMBOL.get(symbolUpper);

    if (tier1 !== undefined) {
      // exact symbol match: collision iff canonical issuer exists AND
      // subject issuer differs. abstain if either side is null
      const seenIssuer = subject.issuer ?? null;
      if (tier1.issuer !== null && seenIssuer !== null && seenIssuer !== tier1.issuer) {
        flags.push({
          id: "exact_symbol_collision",
          severity: "critical",
          message: `Symbol "${rawSymbol}" matches a tier-1 asset but is issued by ${seenIssuer}, not the canonical issuer.`,
          detail: {
            symbol: rawSymbol,
            seenIssuer,
            canonicalIssuer: tier1.issuer,
          },
        });
      }
    } else {
      // no exact tier-1 match — look for a lookalike
      const lookalike = nearestTier1Match(symbolUpper);
      if (lookalike !== null && lookalike.distance <= LOOKALIKE_DISTANCE_THRESHOLD) {
        flags.push({
          id: "lookalike_symbol",
          severity: lookalike.distance === 1 ? "warning" : "info",
          message: `Symbol "${rawSymbol}" is suspiciously close to "${lookalike.tier1Symbol}" (edit distance ${lookalike.distance}).`,
          detail: {
            symbol: rawSymbol,
            lookalikeOf: lookalike.tier1Symbol,
            distance: lookalike.distance,
          },
        });
      }
    }

    // suspicious character class — runs regardless of tier-1 status so a
    // collision + suspicious-character combo (e.g. cyrillic usdс) both fire
    if (!/^[A-Z0-9]+$/.test(rawSymbol)) {
      flags.push({
        id: "suspicious_character",
        severity: "critical",
        message: `Symbol "${rawSymbol}" contains characters outside [A-Z0-9]. Legitimate SEP-1 issuers do not use homoglyphs or accents.`,
        detail: { symbol: rawSymbol },
      });
    }
  }

  // soroban contract not on the allow-list
  if (subject.contractId !== undefined && subject.contractId.length > 0) {
    if (!isAllowedContract(subject.contractId)) {
      flags.push({
        id: "unknown_contract",
        severity: "warning",
        message: `Contract ${subject.contractId} is not on the verified allow-list.`,
        detail: { contractId: subject.contractId },
      });
    }
  }

  return flags;
}

interface LookalikeMatch {
  readonly tier1Symbol: string;
  readonly distance: number;
}

function nearestTier1Match(symbolUpper: string): LookalikeMatch | null {
  let best: LookalikeMatch | null = null;
  for (const tier1 of TIER1_ASSETS) {
    const t = tier1.symbol.toUpperCase();
    if (t === symbolUpper) continue; // exact match handled separately
    const d = levenshtein(symbolUpper, t);
    if (best === null || d < best.distance) {
      best = { tier1Symbol: tier1.symbol, distance: d };
    }
  }
  return best;
}

// classic dp levenshtein. tiny inputs (symbols are <= 12 chars), no deps
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // make `a` the shorter string so the row is small
  let s = a;
  let t = b;
  if (s.length > t.length) {
    const tmp = s;
    s = t;
    t = tmp;
  }

  const m = s.length;
  let prev: number[] = new Array<number>(m + 1);
  let curr: number[] = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;

  for (let j = 1; j <= t.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= m; i++) {
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      const deletion = (curr[i - 1] ?? 0) + 1;
      const insertion = (prev[i] ?? 0) + 1;
      const substitution = (prev[i - 1] ?? 0) + cost;
      curr[i] = Math.min(deletion, insertion, substitution);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[m] ?? 0;
}

// run scam heuristics across every credit balance in an audit. one finding
// per (asset, flag) hit
export function runScamHeuristics(balances: readonly AuditBalance[]): readonly ScamFinding[] {
  const findings: ScamFinding[] = [];
  for (const balance of balances) {
    if (balance.asset.kind !== "credit") continue;
    const { code, issuer } = balance.asset;
    const flags = evaluateScamHeuristics({ symbol: code, issuer });
    for (const flag of flags) {
      findings.push({ flag, asset: balance.asset });
    }
  }
  return findings;
}

export interface ScamFinding {
  readonly flag: ScamFlag;
  readonly asset: AssetIdentifier;
}

// filter findings to those touching a given asset identifier
export function findingsForAsset(
  findings: readonly ScamFinding[],
  asset: AssetIdentifier,
): readonly ScamFinding[] {
  return findings.filter((f) => sameAsset(f.asset, asset));
}

function sameAsset(a: AssetIdentifier, b: AssetIdentifier): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "native" && b.kind === "native") return true;
  if (a.kind === "credit" && b.kind === "credit") {
    return a.code === b.code && a.issuer === b.issuer;
  }
  if (a.kind === "liquidity_pool_shares" && b.kind === "liquidity_pool_shares") {
    return a.poolId === b.poolId;
  }
  return false;
}
