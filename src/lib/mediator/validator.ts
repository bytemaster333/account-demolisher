// strict 2-op merge envelope validator

import { Asset, FeeBumpTransaction, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

import { encodeMemoCommitment, MAX_FORWARD_FEE } from "@/lib/mediator/forward-terms";

// callers must check ok before reading tx (success) or code/reason (failure)
export type ValidationResult =
  | { readonly ok: true; readonly tx: Transaction }
  | { readonly ok: false; readonly code: ValidationFailureCode; readonly reason: string };

// closed enum of rejection causes; surfaced verbatim in 400 responses
export type ValidationFailureCode =
  | "MALFORMED_XDR"
  | "FEE_BUMP_NOT_ALLOWED"
  | "WRONG_OPERATION_COUNT"
  | "MISSING_TIME_BOUNDS"
  | "TIME_BOUNDS_EXCESSIVE"
  | "FORWARD_TX_SOURCE_NOT_MEDIATOR"
  | "FORWARD_OP0_NOT_PAYMENT"
  | "FORWARD_OP0_ASSET_NOT_NATIVE"
  | "FORWARD_OP0_SOURCE_NOT_MEDIATOR"
  | "FORWARD_OP1_NOT_ACCOUNT_MERGE"
  | "FORWARD_OP1_SOURCE_NOT_MEDIATOR"
  | "FORWARD_DESTINATION_MISMATCH"
  | "FORWARD_DESTINATION_NOT_COMMITTED"
  | "FORWARD_MEMO_NOT_COMMITTED"
  | "FORWARD_FEE_TOO_HIGH"
  | "FORWARD_PRECONDITION_NOT_ALLOWED";

// what the flow token committed the forward to
export interface ForwardCommitment {
  readonly destination: string;
  // base64 xdr of the deposit memo, MemoNone when none was committed
  readonly memoXdr: string;
}

// max maxTime horizon. shields against replay of a leaked envelope
export const MAX_TIME_BOUND_SECONDS = 3600;

// the forward envelope is the ONLY shape the mediator co-signs:
//   op0 = mediator-sourced native payment -> destination D
//   op1 = mediator accountMerge           -> destination D (same D)
// carrying the committed memo, a bounded fee and no precondition beyond a short
// timebound. for an exchange the destination is a shared omnibus address and
// the memo decides whose account gets credited, so the memo is bound as tightly
// as the destination.
export function validateMediatorForwardEnvelope(
  envelopeXdr: string,
  networkPassphrase: string,
  mediatorPublicKey: string,
  commitment: ForwardCommitment,
): ValidationResult {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXdr(envelopeXdr, networkPassphrase);
  } catch (err) {
    return {
      ok: false,
      code: "MALFORMED_XDR",
      reason: `Could not parse envelope XDR: ${describeError(err)}`,
    };
  }
  if (parsed instanceof FeeBumpTransaction) {
    return {
      ok: false,
      code: "FEE_BUMP_NOT_ALLOWED",
      reason: "Fee-bump envelopes are not accepted by the mediator.",
    };
  }
  const tx = parsed;

  if (tx.source !== mediatorPublicKey) {
    return {
      ok: false,
      code: "FORWARD_TX_SOURCE_NOT_MEDIATOR",
      reason: "Forward envelope must have the mediator as the transaction source.",
    };
  }
  if (tx.operations.length !== 2) {
    return {
      ok: false,
      code: "WRONG_OPERATION_COUNT",
      reason: `Expected exactly 2 operations; got ${String(tx.operations.length)}.`,
    };
  }
  const op0 = tx.operations[0]!;
  const op1 = tx.operations[1]!;

  if (op0.type !== "payment") {
    return {
      ok: false,
      code: "FORWARD_OP0_NOT_PAYMENT",
      reason: `Forward operation 0 must be payment; got "${op0.type}".`,
    };
  }
  if (!op0.asset.equals(Asset.native())) {
    return {
      ok: false,
      code: "FORWARD_OP0_ASSET_NOT_NATIVE",
      reason: "Forward payment asset must be native XLM.",
    };
  }
  // op[0].source: undefined (inherits) or explicit mediator
  if (op0.source !== undefined && op0.source !== mediatorPublicKey) {
    return {
      ok: false,
      code: "FORWARD_OP0_SOURCE_NOT_MEDIATOR",
      reason: "Forward payment source must be the mediator (or omitted to inherit it).",
    };
  }
  if (op1.type !== "accountMerge") {
    return {
      ok: false,
      code: "FORWARD_OP1_NOT_ACCOUNT_MERGE",
      reason: `Forward operation 1 must be accountMerge; got "${op1.type}".`,
    };
  }
  if (op1.source !== undefined && op1.source !== mediatorPublicKey) {
    return {
      ok: false,
      code: "FORWARD_OP1_SOURCE_NOT_MEDIATOR",
      reason: "Forward accountMerge source must be the mediator (or omitted to inherit it).",
    };
  }
  // the payout (op0) and the reserve-reclaiming merge (op1) must go to the SAME
  // final destination. without this, a crafted envelope could pay the mediator's
  // balance to an attacker while merging the reserve elsewhere.
  if (op0.destination !== op1.destination) {
    return {
      ok: false,
      code: "FORWARD_DESTINATION_MISMATCH",
      reason: "Forward payment and accountMerge must target the same destination.",
    };
  }
  // the destination must equal the one committed in the flow token: without this,
  // a leaked/replayed token could co-sign a forward to an attacker-chosen address
  if (op0.destination !== commitment.destination) {
    return {
      ok: false,
      code: "FORWARD_DESTINATION_NOT_COMMITTED",
      reason: "Forward destination does not match the destination committed in the flow token.",
    };
  }
  // compared as xdr so the memo type and its exact bytes both have to match
  if (encodeMemoCommitment(tx.memo) !== commitment.memoXdr) {
    return {
      ok: false,
      code: "FORWARD_MEMO_NOT_COMMITTED",
      reason: "Forward memo does not match the deposit memo committed in the flow token.",
    };
  }
  if (BigInt(tx.fee) > BigInt(MAX_FORWARD_FEE)) {
    return {
      ok: false,
      code: "FORWARD_FEE_TOO_HIGH",
      reason: `Forward fee ${tx.fee} stroops is above the ${String(MAX_FORWARD_FEE)} stroop ceiling.`,
    };
  }
  if (
    tx.ledgerBounds !== undefined ||
    tx.minAccountSequence !== undefined ||
    (tx.minAccountSequenceAge ?? 0n) !== 0n ||
    (tx.minAccountSequenceLedgerGap ?? 0) !== 0 ||
    (tx.extraSigners?.length ?? 0) > 0
  ) {
    return {
      ok: false,
      code: "FORWARD_PRECONDITION_NOT_ALLOWED",
      reason:
        "Forward may only carry time bounds; ledger bounds, sequence conditions and extra signers are refused.",
    };
  }

  if (
    tx.timeBounds === undefined ||
    tx.timeBounds === null ||
    tx.timeBounds.maxTime === undefined ||
    tx.timeBounds.maxTime === null ||
    tx.timeBounds.maxTime === "" ||
    tx.timeBounds.maxTime === "0"
  ) {
    return {
      ok: false,
      code: "MISSING_TIME_BOUNDS",
      reason: "Transaction must include timeBounds with a non-zero maxTime.",
    };
  }
  const maxTimeSec = Number(tx.timeBounds.maxTime);
  if (!Number.isFinite(maxTimeSec) || maxTimeSec <= 0) {
    return {
      ok: false,
      code: "MISSING_TIME_BOUNDS",
      reason: "Transaction timeBounds.maxTime is not a positive integer.",
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (maxTimeSec > nowSec + MAX_TIME_BOUND_SECONDS) {
    return {
      ok: false,
      code: "TIME_BOUNDS_EXCESSIVE",
      reason: `Transaction timeBounds.maxTime must be within ${String(
        MAX_TIME_BOUND_SECONDS,
      )}s of now; got ${String(maxTimeSec - nowSec)}s in the future.`,
    };
  }

  return { ok: true, tx };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}
