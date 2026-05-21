// claimable-balance predicate evaluation.
//
// horizon serializes predicates with both snake_case and camelCase keys
// across versions; we accept both. unknown shapes evaluate to false —
// conservative: skip a cb the user can manually claim later rather than ask
// them to sign a claim that would just bounce.

import type { ClaimableBalanceEntry } from "@/lib/types/account";

// horizon-shaped predicate node. recursive `unknown`-leaning since horizon's
// shape is not pinned across versions.
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

// returns true iff the user holding this predicate may claim NOW.
// unknown / unrecognized shapes return false.
export function evaluatePredicate(predicate: unknown, ledgerCloseTime: Date): boolean {
  if (predicate === null || predicate === undefined) {
    // a null predicate on a claimant means "unconditional" in some encodings.
    return true;
  }
  if (typeof predicate !== "object") return false;
  const p = predicate as Record<string, unknown>;

  if ("unconditional" in p) {
    const v = p["unconditional"];
    return v === true || v === "true" || v === undefined || v === null;
  }

  if ("and" in p) {
    const children = p["and"];
    if (!Array.isArray(children)) return false;
    return children.every((c) => evaluatePredicate(c, ledgerCloseTime));
  }

  if ("or" in p) {
    const children = p["or"];
    if (!Array.isArray(children)) return false;
    return children.some((c) => evaluatePredicate(c, ledgerCloseTime));
  }

  if ("not" in p) {
    const child = p["not"];
    // `not: null` → not-evaluable, return false.
    if (child === null || child === undefined) return false;
    return !evaluatePredicate(child, ledgerCloseTime);
  }

  // abs_before / absBefore — claimable if ledger time is strictly before.
  const absRaw = pickStringOrNumber(p, ["abs_before", "absBefore"]);
  if (absRaw !== null) {
    const epochMs = parseAbsTime(absRaw);
    if (epochMs === null) return false;
    return ledgerCloseTime.getTime() < epochMs;
  }
  // standalone abs_before_epoch / absBeforeEpoch.
  const absEpochRaw = pickStringOrNumber(p, ["abs_before_epoch", "absBeforeEpoch"]);
  if (absEpochRaw !== null) {
    const seconds = parseEpochSeconds(absEpochRaw);
    if (seconds === null) return false;
    return ledgerCloseTime.getTime() < seconds * 1000;
  }

  // rel_before — needs the original record creation time we don't have;
  // be conservative and return false. horizon usually resolves these to
  // abs_before in the sibling field.
  if ("rel_before" in p || "relBefore" in p) {
    return false;
  }

  return false;
}

// filter cbs down to those the user can claim right now.
//
// note: ClaimableBalanceEntry.predicate (per account-audit) is the raw
// claimants array — NOT a single predicate. find the matching claimant
// and evaluate its predicate.
export function filterClaimableNow(
  cbs: readonly ClaimableBalanceEntry[],
  userPublicKey: string,
  ledgerCloseTime: Date,
): readonly ClaimableBalanceEntry[] {
  return cbs.filter((cb) => isClaimableForUser(cb, userPublicKey, ledgerCloseTime));
}

function isClaimableForUser(
  cb: ClaimableBalanceEntry,
  userPublicKey: string,
  ledgerCloseTime: Date,
): boolean {
  if (!cb.claimants.includes(userPublicKey)) return false;
  const raw = cb.predicate;

  // case A: predicate is the full claimants array.
  if (Array.isArray(raw)) {
    const entry = (raw as readonly unknown[]).find(
      (e): e is HorizonClaimant =>
        typeof e === "object" &&
        e !== null &&
        (e as { destination?: unknown }).destination === userPublicKey,
    );
    if (!entry) return false;
    return evaluatePredicate(entry.predicate, ledgerCloseTime);
  }

  // case B: predicate is a single node already addressed to the user.
  return evaluatePredicate(raw, ledgerCloseTime);
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

function parseAbsTime(raw: string | number): number | null {
  if (typeof raw === "number") {
    // numbers are epoch seconds.
    return Number.isFinite(raw) ? raw * 1000 : null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // pure-digit string → epoch seconds.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n * 1000 : null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function parseEpochSeconds(raw: string | number): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
