// kept around for potential future reuse (e.g., a verbose log mode); the
// execute step now uses the plan tree directly
// parse a demolisher error string into a human-readable summary + structured
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

export function parseDemolishError(raw: string | null): ParsedError {
  if (!raw) {
    return {
      summary: "Something went wrong while closing the account. Your funds are safe, try again.",
      txCode: null,
      ops: [],
    };
  }
  // try to find an embedded result_codes json object
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const blob = raw.slice(jsonStart, jsonEnd + 1);
    try {
      const parsed = JSON.parse(blob) as {
        readonly transaction?: string;
        readonly operations?: readonly string[];
      };
      const txCode = typeof parsed.transaction === "string" ? parsed.transaction : null;
      const ops = Array.isArray(parsed.operations)
        ? (parsed.operations.filter((o) => typeof o === "string") as string[])
        : [];
      const firstBadIdx = ops.findIndex((o) => o !== "op_success");
      const summary =
        firstBadIdx >= 0
          ? `Step ${firstBadIdx + 1} of ${ops.length} couldn't complete, ${plainResultCode(ops[firstBadIdx]!)}.`
          : txCode
            ? `The transaction couldn't complete, ${plainResultCode(txCode)}.`
            : raw.slice(0, jsonStart).trim() || raw;
      return { summary, txCode, ops };
    } catch {
      // fall through to raw
    }
  }
  return { summary: raw, txCode: null, ops: [] };
}
