// Shared helpers for Soroban getEvents scans that page back to the RPC retention
// floor. A start ledger below the ~7-day retention window makes getEvents throw a
// "ledger range: N - M" error; these let a scanner re-clamp startLedger to the
// reported floor (plus a margin) and retry, instead of aborting the whole scan.

// stellar-rpc's stock history-retention-window (about 7 days at 5s a ledger). every
// event scan looks back this far at most; the reported oldest ledger can cut it
// shorter on a host that retains less.
export const EVENT_RETENTION_WINDOW_LEDGERS = 120_960;

// margin above the reported floor: the floor advances ~1 ledger / 5s, so a ledger
// closing between the error and the retry would otherwise drop us back below it.
export const RETENTION_RETRY_MARGIN_LEDGERS = 60;

// bounded re-clamp retries so a second range error can't loop forever.
export const MAX_RETENTION_RETRIES = 3;

// parses the retention floor from a getEvents "ledger range: N - M" error, checking
// both the direct message and a nested cause. returns null if the error isn't a
// recognizable range error.
export function parseRetentionFloor(err: unknown): number | null {
  const directMessage =
    typeof (err as { message?: unknown } | undefined)?.message === "string"
      ? (err as { message: string }).message
      : "";
  const causeMsg =
    typeof (err as { cause?: { message?: unknown } } | undefined)?.cause?.message === "string"
      ? (err as { cause: { message: string } }).cause.message
      : "";
  const match = `${directMessage} ${causeMsg}`.match(/ledger range:\s*(\d+)\s*-\s*(\d+)/);
  if (!match) return null;
  const floor = Number.parseInt(match[1]!, 10);
  return Number.isFinite(floor) ? floor : null;
}
