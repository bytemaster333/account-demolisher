// turns a close failure string into a plain summary plus the raw result codes

export interface ParsedError {
  readonly summary: string;
  readonly txCode: string | null;
  readonly ops: readonly string[];
}
// plain-language cause for a Stellar result code, so the failure summary reads
// like a sentence instead of a raw protocol code. Unknown codes fall through to
// a generic phrase (the raw code is still available in the technical details).
function plainResultCode(code: string): string {
  // wording verified against the official Stellar result-code reference
  // (developers.stellar.org … /errors/result-codes).
  const map: Record<string, string> = {
    // tx_insufficient_fee: source account can't pay the minimum fee
    tx_insufficient_fee: "the fee offered was below the network's minimum",
    // tx_bad_seq: sequence number does not match the source account
    tx_bad_seq: "the account's transaction number was out of date",
    // tx_too_late: the ledger close time was after the transaction's maxTime
    tx_too_late: "the time window to submit it passed",
    // tx_failed: one of the operations failed and none were applied
    tx_failed: "one of the steps was rejected, so nothing was applied",
    // op_underfunded: not enough balance to send while keeping the min reserve
    op_underfunded: "there wasn't enough balance to cover it",
    // op_low_reserve: the result would drop below the minimum reserve
    op_low_reserve: "it would drop the account below its minimum reserve",
    // op_no_trust: destination has no trustline for the asset
    op_no_trust: "the destination can't hold that asset (no trustline)",
    // op_src_no_trust: source no longer holds that asset
    op_src_no_trust: "the account no longer holds the asset this step tried to send",
    // op_line_full: destination is at its limit for the asset
    op_line_full: "the destination can't hold any more of that asset",
    // op_no_destination: destination account does not exist
    op_no_destination: "the destination account doesn't exist",
    // path_payment_strict_send_under_dest_min: swap would fall short of destMin
    op_under_dest_min: "the swap would have returned less than allowed, the price moved",
    // op_malformed: the operation's input was invalid
    op_malformed: "the step was built incorrectly",
    // payment_no_issuer: the asset's issuer does not exist
    op_no_issuer: "the token's issuer no longer exists",
  };
  return map[code] ?? "the network rejected it";
}

// every balanced {...} span in the text, in order. String-aware so a brace inside
// a quoted value doesn't end the object early. Errors from several attempts are
// joined with "; ", so the text can carry more than one result-code object.
function balancedObjects(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) out.push(raw.slice(start, i + 1));
    }
  }
  return out;
}

interface ResultCodes {
  readonly transaction?: unknown;
  readonly operations?: unknown;
}

export function parseDemolishError(raw: string | null): ParsedError {
  if (!raw) {
    return { summary: "The close stopped. See the details below.", txCode: null, ops: [] };
  }
  // the last attempt's result codes describe where the run actually stopped
  const objects = balancedObjects(raw);
  for (let i = objects.length - 1; i >= 0; i--) {
    let parsed: ResultCodes;
    try {
      parsed = JSON.parse(objects[i]!) as ResultCodes;
    } catch {
      continue;
    }
    const txCode = typeof parsed.transaction === "string" ? parsed.transaction : null;
    const ops = Array.isArray(parsed.operations)
      ? parsed.operations.filter((o): o is string => typeof o === "string")
      : [];
    if (txCode === null && ops.length === 0) continue;
    // these index operations inside ONE transaction, not plan steps, so they're
    // labelled as operations to avoid clashing with the step counter
    const firstBadIdx = ops.findIndex((o) => o !== "op_success");
    const summary =
      firstBadIdx >= 0
        ? `Operation ${firstBadIdx + 1} of ${ops.length} in the transaction was rejected: ${plainResultCode(ops[firstBadIdx]!)}.`
        : `The transaction couldn't complete: ${plainResultCode(txCode ?? "")}.`;
    return { summary, txCode, ops };
  }
  return { summary: raw, txCode: null, ops: [] };
}
