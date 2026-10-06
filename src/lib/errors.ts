import { AccountRequiresMemoError } from "@stellar/stellar-sdk";

// not every rejection is an Error: the soroban rpc client in stellar-sdk rejects
// with a plain { code, message } object, so `err instanceof Error` alone drops
// the real message (e.g. "startLedger must be within the ledger range") and
// String(err) gives "[object Object]". this reads .message off plain objects too
// and uses `fallback` only when nothing meaningful can be extracted.
export function errorMessage(err: unknown, fallback?: string): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string" &&
    (err as { message: string }).message.length > 0
  ) {
    return (err as { message: string }).message;
  }
  return fallback ?? String(err);
}

// horizon's result codes when it ran the transaction, otherwise the error's own
// message, so a refusal that never reached horizon (the sdk's sep-29 memo check,
// a network failure) is not reduced to a bare "no result codes"
export function describeSubmitError(err: unknown): string {
  if (err instanceof AccountRequiresMemoError) {
    return (
      `destination ${err.accountId} requires a memo (SEP-29 config.memo_required), and the ` +
      `transaction has none (operation ${err.operationIndex})`
    );
  }
  const codes = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } } | null)
    ?.response?.data?.extras?.result_codes;
  if (codes !== undefined && codes !== null) return JSON.stringify(codes);
  return errorMessage(err);
}
