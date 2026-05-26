// sep-41 allowance enumeration via soroban rpc getEvents.
// approve emits topics [Symbol("approve"), Address(from), Address(spender)]
// and data (amount: i128, expiration_ledger: u32).

import { rpc, type Horizon, type Transaction, type xdr } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import { fromScValAddress, fromScValI128, fromScValSymbol, fromScValU32 } from "./scval";
import { buildApprove } from "./sep41";

// one active sep-41 allowance attributable to the user.
export interface AllowanceRecord {
  readonly contractId: string;
  readonly spender: string;
  readonly amount: bigint;
  readonly live_until_ledger: number;
  readonly lastSeenLedger: number;
  // true when live_until_ledger <= currentLedger at enumeration time.
  readonly expired: boolean;
}

// ~30 days of ledgers at 5s cadence.
export const DEFAULT_SCAN_WINDOW_LEDGERS = 518_400;

// per-page event cap on the rpc.
const PAGE_LIMIT = 10_000;

// enumerate active sep-41 allowances the user granted.
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

  // latest-state accumulator keyed by `${contractId}|${spender}`.
  const latest = new Map<string, AllowanceRecord>();

  // first page uses startLedger; subsequent pages use the returned cursor.
  let cursor: string | undefined;
  // hard cap so a misbehaving rpc can't loop forever.
  const MAX_PAGES = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const request: rpc.Api.GetEventsRequest =
      cursor === undefined
        ? {
            startLedger,
            filters: [{ type: "contract" }],
            limit: PAGE_LIMIT,
          }
        : {
            cursor,
            filters: [{ type: "contract" }],
            limit: PAGE_LIMIT,
          };

    let resp: rpc.Api.GetEventsResponse;
    try {
      resp = await server.getEvents(request);
    } catch (err) {
      // testnet retention is ~7 days; if startLedger is before retention the
      // rpc returns -32600 with "ledger range: <min> - <max>". parse the
      // floor and retry once.
      const directMessage =
        typeof (err as { message?: unknown } | undefined)?.message === "string"
          ? (err as { message: string }).message
          : "";
      const causeMsg =
        typeof (err as { cause?: { message?: unknown } } | undefined)?.cause?.message === "string"
          ? (err as { cause: { message: string } }).cause.message
          : "";
      const combined = `${directMessage} ${causeMsg}`;
      const match = combined.match(/ledger range:\s*(\d+)\s*-\s*(\d+)/);
      if (page === 0 && match) {
        const floor = Number.parseInt(match[1]!, 10);
        if (Number.isFinite(floor) && floor > startLedger) {
          startLedger = floor;
          const retryRequest: rpc.Api.GetEventsRequest = {
            startLedger,
            filters: [{ type: "contract" }],
            limit: PAGE_LIMIT,
          };
          resp = await server.getEvents(retryRequest);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    if (resp.events.length === 0) {
      break;
    }

    for (const ev of resp.events) {
      const decoded = tryDecodeApproveEvent(ev, userAddress);
      if (decoded === null) continue;

      const key = `${decoded.contractId}|${decoded.spender}`;
      const prev = latest.get(key);
      // compare ledgers explicitly in case of out-of-order pagination.
      if (prev === undefined || ev.ledger > prev.lastSeenLedger) {
        latest.set(key, decoded);
      }
    }

    // empty (or unchanged) cursor means end of results.
    if (!resp.cursor || resp.cursor === cursor) {
      break;
    }
    cursor = resp.cursor;
  }

  // stamp each record with its expiry and filter by default.
  const out: AllowanceRecord[] = [];
  for (const rec of latest.values()) {
    const expired = rec.live_until_ledger <= currentLedger;
    if (expired && !includeExpired) continue;
    out.push({ ...rec, expired });
  }
  return out;
}

// returns null if the event isn't an approve emitted by userAddress, or
// if its shape doesn't decode cleanly.
function tryDecodeApproveEvent(
  ev: rpc.Api.EventResponse,
  userAddress: string,
): AllowanceRecord | null {
  if (ev.contractId === undefined) return null;
  const contractId = ev.contractId.contractId();

  const topics = ev.topic;
  // sep-41 approve emits exactly three topics.
  if (topics.length !== 3) return null;

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

  // data is the tuple (amount: i128, expiration_ledger: u32).
  const decoded = tryDecodeApproveData(ev.value);
  if (decoded === null) return null;

  // expired is overwritten by the aggregator.
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

  // primary path: tuple-as-vec (sep-41 reference encoding).
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

  // fallback: some tokens emit a struct (scvMap) with the same keys.
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

// builds a revoke by calling approve(from, spender, 0, currentLedger).
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
