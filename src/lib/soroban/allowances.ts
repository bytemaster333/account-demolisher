// sep-41 allowance enumeration via soroban rpc getEvents

import { Address, rpc, xdr, type Horizon, type Transaction } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import { fromScValAddress, fromScValI128, fromScValSymbol, fromScValU32 } from "./scval";
import { allowance as readAllowance, buildApprove } from "./sep41";

// one active sep-41 allowance attributable to the user
export interface AllowanceRecord {
  readonly contractId: string;
  readonly spender: string;
  readonly amount: bigint;
  readonly live_until_ledger: number;
  readonly lastSeenLedger: number;
  // true when live_until_ledger < currentLedger at enumeration time
  readonly expired: boolean;
  // the amount read DIRECTLY from the token contract (allowance(from, spender)),
  // when it has been confirmed. `amount` above is event-derived and a hostile
  // contract can emit a fabricated approve event, so this on-chain read is the
  // accuracy check: undefined = not confirmed, null = the confirm read failed, a
  // bigint = the real current allowance. See confirmAllowancesOnChain.
  readonly onChainAmount?: bigint | null;
}

// A record whose on-chain amount is DEFINED (confirmed or failed), i.e. the
// result of confirmAllowancesOnChain.
export interface ConfirmedAllowanceRecord extends AllowanceRecord {
  readonly onChainAmount: bigint | null;
}

// true when a confirmed record's event-derived amount disagrees with the on-chain
// amount — the event was fabricated or is stale, so the displayed limit is a lie.
export function allowanceAmountMismatch(r: AllowanceRecord): boolean {
  return typeof r.onChainAmount === "bigint" && r.onChainAmount !== r.amount;
}

// Confirm each event-derived allowance against on-chain state by calling the
// token's allowance(from, spender). Best-effort and read-only: a failed read
// leaves onChainAmount = null (shown as "unconfirmed") rather than dropping the
// row. simSourcePublicKey is any valid G-address used only as the simulation
// source (the read doesn't move funds and the source needn't exist on-chain).
export async function confirmAllowancesOnChain(
  server: rpc.Server,
  ownerAddress: string,
  records: readonly AllowanceRecord[],
  network: NetworkConfig,
  simSourcePublicKey: string,
): Promise<ConfirmedAllowanceRecord[]> {
  return Promise.all(
    records.map(async (r): Promise<ConfirmedAllowanceRecord> => {
      try {
        const res = await readAllowance(
          server,
          r.contractId,
          ownerAddress,
          r.spender,
          simSourcePublicKey,
          network,
        );
        return { ...r, onChainAmount: res.amount };
      } catch {
        return { ...r, onChainAmount: null };
      }
    }),
  );
}

// Soroban RPC only retains events for ~7 days, so a wider window is not just
// wasted work — it is dishonest, since anything older simply cannot be found via
// getEvents. Match the real retention (~7 days of ledgers at 5s cadence:
// 7 * 24 * 60 * 60 / 5 = 120_960). The retention-floor retry below still clamps
// gracefully if a given RPC retains slightly less. NOTE: an allowance whose last
// approve is older than this window is not discoverable by event scan alone; the
// UI surfaces this ~7-day caveat so the empty/partial result isn't mistaken for
// "no allowances exist".
export const DEFAULT_SCAN_WINDOW_LEDGERS = 120_960;

// human-facing description of the scan window, kept next to the constant so copy
// and behavior can't drift. update both together.
export const SCAN_WINDOW_DESCRIPTION = "about the last 7 days";

// per-page event cap on the rpc
const PAGE_LIMIT = 10_000;

// when getEvents reports our startLedger is below the retained event window, we
// clamp to the floor it reports, plus this margin. The retention floor advances
// continuously (~1 ledger / 5s), so clamping to the *exact* floor races: a single
// ledger closing between the error and the retry would drop us back below it and
// fail again. A small margin absorbs that (skipping a few ledgers at the very
// oldest edge is immaterial for a best-effort "latest allowance state" scan).
const RETENTION_RETRY_MARGIN_LEDGERS = 60;

// how many times we'll re-clamp startLedger and retry after a retention-range
// error. The floor advances ~1 ledger / 5s, so the margin above absorbs any
// realistic retry gap in one shot, but a bounded loop keeps a second range
// error from propagating uncaught out of enumerateAllowances.
const MAX_RETENTION_RETRIES = 3;

// parses the retention floor from a getEvents "ledger range: N - M" error,
// checking both the direct message and a nested cause. returns null if the
// error isn't a recognizable range error.
function parseRetentionFloor(err: unknown): number | null {
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

// enumerate active sep-41 allowances the user granted
export async function enumerateAllowances(
  server: rpc.Server,
  userAddress: string,
  currentLedger: number,
  scanWindowLedgers: number = DEFAULT_SCAN_WINDOW_LEDGERS,
  options: { includeExpired?: boolean } = {},
): Promise<AllowanceRecord[]> {
  const includeExpired = options.includeExpired === true;
  if (currentLedger <= 0) {
    throw new RangeError(`enumerateAllowances: currentLedger must be > 0; got ${currentLedger}`);
  }
  if (scanWindowLedgers < 1) {
    throw new RangeError(
      `enumerateAllowances: scanWindowLedgers must be >= 1; got ${scanWindowLedgers}`,
    );
  }
  let startLedger = Math.max(1, currentLedger - scanWindowLedgers);

  // rpc-level filter for sep-41 approve events
  const approveSymbolXdr = xdr.ScVal.scvSymbol("approve").toXDR("base64");
  const fromAddressXdr = new Address(userAddress).toScVal().toXDR("base64");
  const eventFilter3: rpc.Api.EventFilter = {
    type: "contract",
    topics: [[approveSymbolXdr, fromAddressXdr, "*"]],
  };
  const eventFilter4: rpc.Api.EventFilter = {
    type: "contract",
    topics: [[approveSymbolXdr, fromAddressXdr, "*", "*"]],
  };

  // latest-state accumulator keyed by `${contractId}|${spender}`
  const latest = new Map<string, AllowanceRecord>();

  // first page uses startLedger; subsequent pages use the returned cursor
  let cursor: string | undefined;
  // hard cap so a misbehaving rpc can't loop forever
  const MAX_PAGES = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const request: rpc.Api.GetEventsRequest =
      cursor === undefined
        ? {
            startLedger,
            filters: [eventFilter3, eventFilter4],
            limit: PAGE_LIMIT,
          }
        : {
            cursor,
            filters: [eventFilter3, eventFilter4],
            limit: PAGE_LIMIT,
          };

    let resp: rpc.Api.GetEventsResponse;
    try {
      resp = await server.getEvents(request);
    } catch (err) {
      // testnet retention is ~7 days; if startLedger is before retention the
      // rpc rejects with a "ledger range: N - M" error. Clamp to the reported
      // floor (plus a margin) and retry. A single ledger closing during the
      // retry gap could push us back below the floor, so re-parse the fresh
      // floor and re-clamp on repeat failures, up to a bounded number of tries.
      const floor = page === 0 ? parseRetentionFloor(err) : null;
      if (floor === null || floor <= startLedger) {
        throw err;
      }
      // clamp to the reported floor plus a margin so a ledger closing during
      // the retry gap can't put us right back below the retention floor
      startLedger = Math.min(currentLedger, floor + RETENTION_RETRY_MARGIN_LEDGERS);

      let retryResp: rpc.Api.GetEventsResponse | undefined;
      for (let attempt = 0; attempt < MAX_RETENTION_RETRIES; attempt++) {
        const retryRequest: rpc.Api.GetEventsRequest = {
          startLedger,
          filters: [eventFilter3, eventFilter4],
          limit: PAGE_LIMIT,
        };
        try {
          retryResp = await server.getEvents(retryRequest);
          break;
        } catch (retryErr) {
          const newFloor = parseRetentionFloor(retryErr);
          // rethrow if it isn't a range error or the floor didn't advance past
          // our clamped startLedger (re-clamping wouldn't make progress)
          if (newFloor === null || newFloor <= startLedger) {
            throw retryErr;
          }
          startLedger = Math.min(currentLedger, newFloor + RETENTION_RETRY_MARGIN_LEDGERS);
          if (attempt === MAX_RETENTION_RETRIES - 1) {
            throw retryErr;
          }
        }
      }
      // retryResp is always assigned on a successful break above; the loop
      // otherwise throws. This guard satisfies the type checker.
      if (retryResp === undefined) {
        throw err;
      }
      resp = retryResp;
    }
    // process whatever events came back (might be 0, a topic-filtered query
    for (const ev of resp.events) {
      const decoded = tryDecodeApproveEvent(ev, userAddress);
      if (decoded === null) continue;

      const key = `${decoded.contractId}|${decoded.spender}`;
      const prev = latest.get(key);
      // compare ledgers explicitly in case of out-of-order pagination
      if (prev === undefined || ev.ledger > prev.lastSeenLedger) {
        latest.set(key, decoded);
      }
    }

    // end-of-results only when there's no forward cursor. an empty page with
    // a cursor means "no matches in this slice, keep paging"; must NOT break
    if (!resp.cursor || resp.cursor === cursor) {
      break;
    }
    cursor = resp.cursor;
  }

  // stamp each record with its expiry and filter by default
  const out: AllowanceRecord[] = [];
  for (const rec of latest.values()) {
    const expired = rec.live_until_ledger < currentLedger;
    if (expired && !includeExpired) continue;
    out.push({ ...rec, expired });
  }
  return out;
}

// returns null if the event isn't an approve emitted by userAddress, or
// if its shape doesn't decode cleanly
function tryDecodeApproveEvent(
  ev: rpc.Api.EventResponse,
  userAddress: string,
): AllowanceRecord | null {
  if (ev.contractId === undefined) return null;
  const contractId = ev.contractId.contractId();

  const topics = ev.topic;
  // sep-41 spec emits three topics: symbol("approve"), address(from), address(spender)
  // tolerate the occasional 4-topic variant by reading from the start
  if (topics.length < 3 || topics.length > 4) return null;

  let topicName: string;
  try {
    topicName = fromScValSymbol(topics[0]!);
  } catch {
    return null;
  }
  if (topicName !== "approve") return null;

  let from: string;
  let spender: string;
  try {
    from = fromScValAddress(topics[1]!);
    spender = fromScValAddress(topics[2]!);
  } catch {
    return null;
  }
  if (from !== userAddress) return null;

  // data is the tuple (amount: i128, expiration_ledger: u32)
  const decoded = tryDecodeApproveData(ev.value);
  if (decoded === null) return null;

  // expired is overwritten by the aggregator
  return {
    contractId,
    spender,
    amount: decoded.amount,
    live_until_ledger: decoded.live_until_ledger,
    lastSeenLedger: ev.ledger,
    expired: false,
  };
}

function tryDecodeApproveData(v: xdr.ScVal): { amount: bigint; live_until_ledger: number } | null {
  const kind = v.switch().name;

  // primary path: tuple-as-vec (sep-41 reference encoding)
  if (kind === "scvVec") {
    const arr = v.vec();
    if (!arr || arr.length !== 2) return null;
    try {
      return {
        amount: fromScValI128(arr[0]!),
        live_until_ledger: fromScValU32(arr[1]!),
      };
    } catch {
      return null;
    }
  }

  // fallback: some tokens emit a struct (scvMap) with the same keys
  if (kind === "scvMap") {
    const entries = v.map();
    if (!entries) return null;
    let amount: bigint | undefined;
    let liveUntilLedger: number | undefined;
    for (const entry of entries) {
      const key = entry.key();
      if (key.switch().name !== "scvSymbol") continue;
      const k = key.sym().toString();
      try {
        if (k === "amount") amount = fromScValI128(entry.val());
        else if (k === "live_until_ledger" || k === "expiration_ledger") {
          liveUntilLedger = fromScValU32(entry.val());
        }
      } catch {
        return null;
      }
    }
    if (amount === undefined || liveUntilLedger === undefined) return null;
    return { amount, live_until_ledger: liveUntilLedger };
  }

  return null;
}

// builds a revoke by calling approve(from, spender, 0, currentLedger)
export async function buildRevoke(
  server: rpc.Server,
  contractId: string,
  userAddress: string,
  spender: string,
  currentLedger: number,
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
): Promise<Transaction> {
  return buildApprove(
    server,
    contractId,
    userAddress,
    spender,
    0n,
    currentLedger,
    network,
    sourceAccount,
  );
}
