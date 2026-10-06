// typed close failures. the kind decides what RETRY does: a retryable kind
// re-executes the same tree (confirmed steps are skipped, failed ones re-run),
// any other kind rebuilds the plan from fresh discovery.

import { NetworkError, NotFoundError } from "@stellar/stellar-sdk";

import { errorMessage } from "@/lib/errors";

export type FailureKind =
  // the source account's sequence moved under a step
  | "bad_seq"
  // the ledger entries a soroban step declared changed before it landed
  | "changed_footprint"
  // horizon, rpc or the mediator endpoint did not answer usefully
  | "network"
  // the account can no longer be merged as planned
  | "not_mergeable"
  // a defi position is still open at merge time
  | "position_open"
  // a soroban step reverted on chain
  | "reverted"
  // the wallet did not sign
  | "signing"
  // a submission's outcome is unknown; retry reconciles it before signing again
  | "ambiguous"
  // the merge into the exchange-forward account landed but the forward did not
  | "forward_pending"
  // the user stopped the close at a step boundary
  | "interrupted"
  // a step's transaction asked for more than the step needs and was not signed
  | "unsafe"
  // a collected multisig bundle can no longer land; signatures must be collected again
  | "bundle_stale"
  // the exchange-forward authorization ran too low to sign the merge safely
  | "mediator_expired"
  // a conversion the user reviewed would now sell at a worse price, or over the
  // price-impact cap; the plan is rebuilt so they can decide per token
  | "conversion_refused"
  // a backstop emissions claim that simulated at review can no longer run; the
  // plan is rebuilt so the user can acknowledge leaving the BLND unclaimed
  | "claim_unavailable"
  // another run of the close for this account is still going in this tab; a
  // retry after it ends re-runs only what did not land
  | "close_running"
  | "unknown";

export class CloseFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "CloseFailure";
  }
}

// a submit whose outcome horizon never confirmed either way. the hash and the
// tx's maxTime let a retry look it up before anything is signed again.
export class AmbiguousSubmitError extends CloseFailure {
  constructor(
    readonly txHash: string,
    readonly maxTime: number | null,
    detail: string,
  ) {
    super(
      "ambiguous",
      `The network did not confirm whether transaction ${txHash} landed (${detail}). ` +
        "Retry checks it on chain before signing anything again.",
    );
    this.name = "AmbiguousSubmitError";
  }
}

export interface ResultCodes {
  readonly transaction?: string;
  readonly operations?: readonly string[];
}

// horizon refused the transaction with result codes
export class SubmitRejectedError extends Error {
  constructor(
    readonly codes: ResultCodes,
    readonly httpStatus: number | undefined,
  ) {
    super(`submitClassic rejected: ${JSON.stringify(codes)}`);
    this.name = "SubmitRejectedError";
  }
}

// result codes from a typed rejection, or from the json embedded in a legacy
// "submitClassic rejected: {...}" message
export function rejectionCodes(err: unknown): ResultCodes | null {
  if (err instanceof SubmitRejectedError) return err.codes;
  const msg = errorMessage(err);
  const at = msg.indexOf("submitClassic rejected: ");
  if (at < 0) return null;
  const json = msg.slice(at + "submitClassic rejected: ".length);
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as { transaction?: unknown; operations?: unknown };
    return {
      ...(typeof p.transaction === "string" ? { transaction: p.transaction } : {}),
      ...(Array.isArray(p.operations)
        ? { operations: p.operations.filter((o): o is string => typeof o === "string") }
        : {}),
    };
  } catch {
    return null;
  }
}

export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof CloseFailure) return err.kind;
  const codes = rejectionCodes(err);
  if (codes) return kindFromCodes(codes);
  if (isTransientHorizonError(err)) return "network";
  return classifyMessage(errorMessage(err));
}

// the sdk rejects a failed horizon read with NetworkError, whose message is only
// the status text ("Too Many Requests", or "" over http/2). the status sits on
// the response: horizon's problem json carries it, and a submit error wraps the
// http response itself. a rate limit, a 5xx, or an error page with no readable
// status (a proxy answering for horizon) is transient.
function isTransientHorizonError(err: unknown): boolean {
  if (!(err instanceof NetworkError) || err instanceof NotFoundError) return false;
  const status = (err.response as { status?: unknown } | undefined)?.status;
  if (typeof status !== "number") return true;
  return status === 429 || status >= 500;
}

function kindFromCodes(codes: ResultCodes): FailureKind {
  switch (codes.transaction) {
    case "tx_bad_seq":
      return "bad_seq";
    case "tx_too_late":
    case "tx_insufficient_fee":
      // a rebuild with a fresh timebound or a higher bid can land
      return "network";
    case "tx_insufficient_balance":
      return "not_mergeable";
    default:
      // tx_failed with op codes, tx_bad_auth and the rest are deterministic for
      // this plan: rebuild it from fresh state rather than replay it
      return "not_mergeable";
  }
}

// last resort for errors raised below the typed boundaries (simulation and rpc
// errors, other callers' submitters). only specific phrases count.
function classifyMessage(raw: string): FailureKind {
  const m = raw.toLowerCase();
  if (m.includes("tx_bad_seq") || m.includes("txbadseq")) return "bad_seq";
  // diverged-state stops first, so a detail that mentions "archived" cannot turn
  // them into a retryable footprint race
  if (m.includes("position(s) still open")) return "position_open";
  if (m.includes("account_merge blocked")) return "not_mergeable";
  if (
    m.includes("footprint") ||
    m.includes("restorepreamble") ||
    m.includes("entryarchived") ||
    m.includes("entry_archived") ||
    m.includes("entry_expired")
  ) {
    return "changed_footprint";
  }
  if (m.includes("failed on-chain")) return "reverted";
  if (
    m.includes("timed out") ||
    m.includes("timeout of") ||
    m.includes("fetch failed") ||
    m.includes("failed to fetch") ||
    m.includes("network error") ||
    m.includes("networkerror") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("429") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504") ||
    m.includes("bad gateway") ||
    m.includes("service unavailable") ||
    m.includes("gateway timeout")
  ) {
    return "network";
  }
  return "unknown";
}

export function isRetryableFailure(kind: FailureKind): boolean {
  switch (kind) {
    case "bad_seq":
    case "changed_footprint":
    case "network":
    case "signing":
    case "ambiguous":
    case "forward_pending":
    case "interrupted":
    case "close_running":
      return true;
    case "not_mergeable":
    case "position_open":
    case "reverted":
    case "unsafe":
    case "bundle_stale":
    case "mediator_expired":
    case "conversion_refused":
    case "claim_unavailable":
    // an unclassified fault says nothing about the tree, so rebuild it
    case "unknown":
      return false;
  }
}
