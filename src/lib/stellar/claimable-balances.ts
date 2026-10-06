// claimable-balance predicate evaluation

import type { ClaimableBalanceEntry } from "@/lib/types/account";

// horizon-shaped predicate node. recursive `unknown`-leaning since horizon's
// shape is not pinned across versions
export type ClaimPredicate =
  | { readonly unconditional: true }
  | { readonly and: readonly ClaimPredicate[] }
  | { readonly or: readonly ClaimPredicate[] }
  | { readonly not: ClaimPredicate | null }
  | { readonly abs_before: string; readonly abs_before_epoch?: string }
  | { readonly absBefore: string; readonly absBeforeEpoch?: string }
  | { readonly rel_before: string }
  | { readonly relBefore: string }
  | Record<string, unknown>;

interface HorizonClaimant {
  readonly destination: string;
  readonly predicate: unknown;
}

// how a predicate behaves over a closed time window [from, to] (epoch seconds):
// claimable at every instant, at none, or something in between. "mixed" also
// covers anything unreadable, so it is never treated as claimable and never
// flips to claimable under not().
type WindowTruth = "always" | "never" | "mixed";

// a bound past any ledger time core can produce. used for horizon's
// expanded-year strings when no epoch is given.
const FAR_FUTURE = 1n << 64n;

// returns true iff the claimant may claim at the given ledger close time.
// unknown or malformed shapes return false
export function evaluatePredicate(predicate: unknown, ledgerCloseTime: Date): boolean {
  const t = toEpochSeconds(ledgerCloseTime);
  return evaluateOverWindow(predicate, t, t) === "always";
}

function evaluateOverWindow(predicate: unknown, from: bigint, to: bigint): WindowTruth {
  // horizon always emits a predicate; a missing one is malformed, not unconditional
  if (predicate === null || typeof predicate !== "object") return "mixed";
  const p = predicate as Record<string, unknown>;

  if ("unconditional" in p) {
    const v = p["unconditional"];
    return v === true || v === "true" ? "always" : "mixed";
  }

  if ("and" in p) {
    const children = p["and"];
    if (!Array.isArray(children)) return "mixed";
    const results = children.map((c) => evaluateOverWindow(c, from, to));
    if (results.includes("never")) return "never";
    return results.every((r) => r === "always") ? "always" : "mixed";
  }

  if ("or" in p) {
    const children = p["or"];
    if (!Array.isArray(children)) return "mixed";
    const results = children.map((c) => evaluateOverWindow(c, from, to));
    if (results.includes("always")) return "always";
    return results.every((r) => r === "never") ? "never" : "mixed";
  }

  if ("not" in p) {
    const inner = evaluateOverWindow(p["not"], from, to);
    return inner === "always" ? "never" : inner === "never" ? "always" : "mixed";
  }

  // abs_before: claimable while the ledger close time is strictly before it
  const bound = readAbsBefore(p);
  if (bound !== null) {
    if (to < bound) return "always";
    if (from >= bound) return "never";
    return "mixed";
  }

  // core stores rel_before as abs_before at creation, so horizon never returns
  // it; anything left here is unreadable
  return "mixed";
}

// abs_before_epoch is the exact value core holds, so it wins over the rfc3339
// string, which horizon renders with an expanded year ("+10000-...") that
// Date.parse rejects once the bound is past 9999.
function readAbsBefore(p: Record<string, unknown>): bigint | null {
  const epochRaw = pickStringOrNumber(p, ["abs_before_epoch", "absBeforeEpoch"]);
  if (epochRaw !== null) return parseEpochSeconds(epochRaw);
  const absRaw = pickStringOrNumber(p, ["abs_before", "absBefore"]);
  if (absRaw !== null) return parseAbsTime(absRaw);
  return null;
}

// filter cbs down to those the user can claim at the given ledger close time and
// for the following `validForSeconds` (the validity window of the transaction
// that will carry the claim), so a claim is never built that could expire, or
// not yet be open, by the time it applies
export function filterClaimableNow(
  cbs: readonly ClaimableBalanceEntry[],
  userPublicKey: string,
  ledgerCloseTime: Date,
  validForSeconds = 0,
): readonly ClaimableBalanceEntry[] {
  if (!Number.isInteger(validForSeconds) || validForSeconds < 0) {
    throw new RangeError(
      `filterClaimableNow: validForSeconds must be a non-negative integer; got ${validForSeconds}`,
    );
  }
  const from = toEpochSeconds(ledgerCloseTime);
  const to = from + BigInt(validForSeconds);
  return cbs.filter((cb) => isClaimableForUser(cb, userPublicKey, from, to));
}

function isClaimableForUser(
  cb: ClaimableBalanceEntry,
  userPublicKey: string,
  from: bigint,
  to: bigint,
): boolean {
  if (!cb.claimants.includes(userPublicKey)) return false;
  const raw = cb.predicate;

  // case a: predicate is the full claimants array
  if (Array.isArray(raw)) {
    const entry = (raw as readonly unknown[]).find(
      (e): e is HorizonClaimant =>
        typeof e === "object" &&
        e !== null &&
        (e as { destination?: unknown }).destination === userPublicKey,
    );
    if (!entry) return false;
    return evaluateOverWindow(entry.predicate, from, to) === "always";
  }

  // case b: predicate is a single node already addressed to the user
  return evaluateOverWindow(raw, from, to) === "always";
}

function toEpochSeconds(d: Date): bigint {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("claimable-balances: invalid ledger close time");
  return BigInt(Math.floor(ms / 1000));
}

function pickStringOrNumber(
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | number | null {
  for (const k of keys) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (typeof v === "string" || typeof v === "number") return v;
  }
  return null;
}

function parseAbsTime(raw: string | number): bigint | null {
  if (typeof raw === "number") return parseEpochSeconds(raw);
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // pure-digit string: epoch seconds
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) return BigInt(Math.floor(ms / 1000));
  // expanded year of five or more digits: past anything a ledger can close at
  if (/^\+\d{5,}-/.test(trimmed)) return FAR_FUTURE;
  return null;
}

function parseEpochSeconds(raw: string | number): bigint | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
  }
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? BigInt(trimmed) : null;
}
