// shared helpers for Soroban getEvents scans that page back to the RPC retention
// floor. a start ledger below the ~7-day retention window makes getEvents throw a
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

// how far a host's history may fall short of its configured window before it
// counts as a short host rather than one whose window just slid a little
export const SHORT_HOST_TOLERANCE_LEDGERS = 1_000;

// a range error whose floor sits this far above the ledger asked for came from a
// host short of history (a load balancer can send the next request to a full
// one), not from the window sliding past the request. the scanners ask again
// instead of narrowing the scan to that host's floor.
export function isShortHostFloor(floor: number, requestedStart: number): boolean {
  return floor - requestedStart > SHORT_HOST_TOLERANCE_LEDGERS;
}

// how often a scanner asks again after a short host's range error before it
// reports the range as unreadable. with one short host behind a balancer that
// spreads requests evenly, six refusals in a row is about a 1-in-64 chance.
export const MAX_SHORT_HOST_RETRIES = 6;

// the first ledger a scan should ask for, judged from one getHealth answer. a
// load-balanced endpoint can mix hosts with different history: on 2026-10-16
// soroban-testnet.stellar.org answered from hosts holding the full 120,960
// ledgers and from one holding about 9,800, which had restarted. that host's
// oldest ledger is not the network's floor, so a scan sized by it would quietly
// cover hours instead of days. a host short of its own configured window is
// ignored in favour of that window; requests below its floor then fail over to
// a host that has them (isFailoverError), and a floor every host reports is
// still clamped to by the scanners.
export function scanStartFromHealth(health: {
  readonly latestLedger: number;
  readonly oldestLedger: number;
  readonly ledgerRetentionWindow?: number;
}): number {
  const window = health.ledgerRetentionWindow;
  const held = health.latestLedger - health.oldestLedger + 1;
  if (typeof window === "number" && window > 0 && held < window - SHORT_HOST_TOLERANCE_LEDGERS) {
    return Math.max(1, health.latestLedger - window + 1) + RETENTION_RETRY_MARGIN_LEDGERS;
  }
  return health.oldestLedger + RETENTION_RETRY_MARGIN_LEDGERS;
}

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
