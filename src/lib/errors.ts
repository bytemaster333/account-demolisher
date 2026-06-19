// Extract a human-readable message from an unknown thrown value.
//
// Not every rejection is an `Error`. The Soroban RPC client in
// `@stellar/stellar-sdk` rejects with a plain object shaped `{ code, message }`
// rather than an `Error` instance, so a bare `err instanceof Error ? err.message
// : fallback` check silently discards the real message (e.g. "startLedger must be
// within the ledger range: 3517481 - 3638440") — and a `String(err)` fallback
// renders the useless "[object Object]". This reads `.message` off plain objects
// too, and only uses `fallback` when nothing meaningful can be extracted.
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
