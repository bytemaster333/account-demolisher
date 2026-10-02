// scam-token heuristics

import { Asset } from "@stellar/stellar-sdk";
import { isAllowedContract } from "@/lib/config/contracts";
import { NETWORKS, type StellarNetwork } from "@/lib/config/networks";
import { hasHiddenCharacters, safeDisplay } from "@/lib/safe-display";
import type { AssetIdentifier, AuditBalance } from "@/lib/types/account";

export type ScamSeverity = "info" | "warning" | "critical";

export type ScamHeuristicId =
  "lookalike_symbol" | "exact_symbol_collision" | "suspicious_character" | "unknown_contract";

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
  // issuer g-address, or null when there is no canonical issuer to compare with
  // (native lumens, or no official issuer on that network)
  readonly issuer: string | null;
  // native lumens: never a classic credit asset, and its only contract is the
  // native asset contract
  readonly native?: true;
}

// Canonical issuers, per network. Every non-null address below was verified
// against the issuer's official source (Circle's contract-address docs for
// USDC/EURC; Aquarius's stellar.toml for AQUA; Blend's mainnet deployments page,
// docs.blend.capital/mainnet-deployments, for BLND). null = no canonical issuer
// we can vouch for on that network, so the collision check abstains rather than
// compare against the wrong address (e.g. AQUA has no official testnet issuer).
export const TIER1_MAINNET: readonly Tier1Asset[] = [
  { symbol: "XLM", issuer: null, native: true },
  { symbol: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  { symbol: "EURC", issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2" },
  { symbol: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
  { symbol: "BLND", issuer: "GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY" },
];

export const TIER1_TESTNET: readonly Tier1Asset[] = [
  { symbol: "XLM", issuer: null, native: true },
  { symbol: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
  { symbol: "EURC", issuer: "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO" },
  { symbol: "AQUA", issuer: null },
  { symbol: "BLND", issuer: null },
];

// mainnet is the default reference set (kept as TIER1_ASSETS for compatibility)
export const TIER1_ASSETS = TIER1_MAINNET;

function tier1For(network: StellarNetwork): readonly Tier1Asset[] {
  return network === "mainnet" ? TIER1_MAINNET : network === "testnet" ? TIER1_TESTNET : [];
}

// edit distance <= this (and > 0) counts as suspicious
const LOOKALIKE_DISTANCE_THRESHOLD = 2;

// run all heuristics against the subject, using the canonical issuer set for the
// given network (defaults to mainnet)
export function evaluateScamHeuristics(
  subject: TokenSubject,
  network: StellarNetwork = "mainnet",
): readonly ScamFlag[] {
  const flags: ScamFlag[] = [];
  const tier1List = tier1For(network);
  const tier1BySymbol = new Map(tier1List.map((a) => [a.symbol.toUpperCase(), a]));

  const contractId =
    subject.contractId !== undefined && subject.contractId.length > 0 ? subject.contractId : null;
  const rawSymbol = (subject.symbol ?? "").trim();
  const shown = safeDisplay(rawSymbol);
  if (rawSymbol.length > 0) {
    const symbolUpper = rawSymbol.toUpperCase();
    const tier1 = tier1BySymbol.get(symbolUpper);

    if (tier1 !== undefined) {
      const collision =
        contractId !== null
          ? contractCollision(shown, tier1, contractId, network)
          : issuerCollision(shown, tier1, subject.issuer ?? null);
      if (collision !== null) flags.push(collision);
    } else {
      // no exact tier-1 match, look for a lookalike
      const lookalike = nearestTier1Match(symbolUpper, tier1List);
      if (lookalike !== null && lookalike.distance <= LOOKALIKE_DISTANCE_THRESHOLD) {
        flags.push({
          id: "lookalike_symbol",
          severity: lookalike.distance === 1 ? "warning" : "info",
          message: `Symbol "${shown}" is suspiciously close to "${lookalike.tier1Symbol}" (edit distance ${lookalike.distance}).`,
          detail: {
            symbol: shown,
            lookalikeOf: lookalike.tier1Symbol,
            distance: lookalike.distance,
          },
        });
      }
    }

    // suspicious character class, flags non-ASCII-alphanumeric symbols
    // (homoglyphs, cyrillic, accents). Lowercase ASCII is a valid (if unusual)
    // Stellar asset code, so it must NOT trip this. otherwise every lowercase
    // code is a false positive. Case impersonation is caught by the collision /
    // lookalike checks above, which compare upper-cased.
    if (!/^[A-Za-z0-9]+$/.test(rawSymbol)) {
      flags.push({
        id: "suspicious_character",
        severity: "critical",
        message: `Symbol "${shown}" contains characters outside [A-Za-z0-9]. Legitimate SEP-1 issuers do not use homoglyphs or accents.`,
        detail: { symbol: shown },
      });
    }
  }

  // a sep-41 name is free text, so only hidden or reordering characters count
  const name = subject.name ?? "";
  if (hasHiddenCharacters(name)) {
    flags.push({
      id: "suspicious_character",
      severity: "critical",
      message: `Token name "${safeDisplay(name)}" contains hidden or text-reordering characters.`,
      detail: { name: safeDisplay(name) },
    });
  }

  // soroban contract not on this network's allow-list
  if (contractId !== null && !isAllowedContract(contractId, NETWORKS[network])) {
    flags.push({
      id: "unknown_contract",
      severity: "warning",
      message: `Contract ${contractId} is not on the verified allow-list.`,
      detail: { contractId },
    });
  }

  return flags;
}

// classic trustline with a tier-1 code. a credit asset coded XLM is never native
// lumens; any other tier-1 code collides when the canonical issuer is known and
// differs. abstains when either issuer is unknown.
function issuerCollision(
  symbol: string,
  tier1: Tier1Asset,
  seenIssuer: string | null,
): ScamFlag | null {
  if (seenIssuer === null) return null;
  if (tier1.native === true) {
    return {
      id: "exact_symbol_collision",
      severity: "critical",
      message: `"${symbol}" here is a credit asset issued by ${seenIssuer}. Real lumens (XLM) are native and have no issuer.`,
      detail: { symbol: symbol, seenIssuer },
    };
  }
  if (tier1.issuer === null || seenIssuer === tier1.issuer) return null;
  return {
    id: "exact_symbol_collision",
    severity: "critical",
    message: `Symbol "${symbol}" matches a tier-1 asset but is issued by ${seenIssuer}, not the canonical issuer.`,
    detail: { symbol: symbol, seenIssuer, canonicalIssuer: tier1.issuer },
  };
}

// sep-41 token with a tier-1 symbol. the real asset's only contract is its
// stellar asset contract, derived from the canonical asset and the network, so
// any other contract claiming the symbol is an impersonation. abstains when the
// canonical issuer is unknown on this network.
function contractCollision(
  symbol: string,
  tier1: Tier1Asset,
  contractId: string,
  network: StellarNetwork,
): ScamFlag | null {
  const passphrase = NETWORKS[network].passphrase;
  let canonical: string;
  if (tier1.native === true) canonical = Asset.native().contractId(passphrase);
  else if (tier1.issuer !== null) {
    canonical = new Asset(tier1.symbol, tier1.issuer).contractId(passphrase);
  } else return null;
  if (contractId === canonical) return null;
  return {
    id: "exact_symbol_collision",
    severity: "critical",
    message: `Token symbol "${symbol}" matches a tier-1 asset, but contract ${contractId} is not its canonical contract ${canonical}.`,
    detail: { symbol: symbol, contractId, canonicalContract: canonical },
  };
}

interface LookalikeMatch {
  readonly tier1Symbol: string;
  readonly distance: number;
}

function nearestTier1Match(
  symbolUpper: string,
  tier1List: readonly Tier1Asset[],
): LookalikeMatch | null {
  let best: LookalikeMatch | null = null;
  for (const tier1 of tier1List) {
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
export function runScamHeuristics(
  balances: readonly AuditBalance[],
  network: StellarNetwork = "mainnet",
): readonly ScamFinding[] {
  const findings: ScamFinding[] = [];
  for (const balance of balances) {
    if (balance.asset.kind !== "credit") continue;
    const { code, issuer } = balance.asset;
    const flags = evaluateScamHeuristics({ symbol: code, issuer }, network);
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

export interface HeldTokenSubject {
  readonly contractId: string;
  // read from the contract's symbol() / name(); attacker-controlled
  readonly symbol?: string;
  readonly name?: string;
}

// run scam heuristics across held SEP-41 tokens. their symbol and name come from
// the token contract itself, so this is where lookalike, homoglyph and
// impersonation checks actually matter
export function runHeldTokenScamHeuristics(
  tokens: readonly HeldTokenSubject[],
  network: StellarNetwork = "mainnet",
): readonly ScamFinding[] {
  const findings: ScamFinding[] = [];
  for (const token of tokens) {
    const flags = evaluateScamHeuristics(
      {
        contractId: token.contractId,
        ...(token.symbol !== undefined ? { symbol: token.symbol } : {}),
        ...(token.name !== undefined ? { name: token.name } : {}),
      },
      network,
    );
    const asset: AssetIdentifier = {
      kind: "contract",
      contractId: token.contractId,
      ...(token.symbol !== undefined ? { symbol: safeDisplay(token.symbol) } : {}),
    };
    for (const flag of flags) findings.push({ flag, asset });
  }
  return findings;
}
