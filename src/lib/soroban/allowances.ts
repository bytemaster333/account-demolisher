// sep-41 allowance enumeration via soroban rpc getEvents

import {
  Address,
  rpc,
  xdr,
  type Account,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import { fromScValAddress, fromScValI128, fromScValSymbol, fromScValU32 } from "./scval";
import { allowance as readAllowance, buildApprove } from "./sep41";
import { mapConcurrent } from "./concurrency";
import { EVENT_RETENTION_WINDOW_LEDGERS } from "./event-retention";
import { scanEventWindows, type EventScanIncomplete } from "./event-scan";

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
// any contract can emit approve events naming the user, so the record list is
// attacker-sized: the reads run a few at a time, not all at once.
export const CONFIRM_CONCURRENCY = 6;

export async function confirmAllowancesOnChain(
  server: rpc.Server,
  ownerAddress: string,
  records: readonly AllowanceRecord[],
  network: NetworkConfig,
  simSourcePublicKey: string,
): Promise<ConfirmedAllowanceRecord[]> {
  return mapConcurrent(
    records,
    CONFIRM_CONCURRENCY,
    async (r): Promise<ConfirmedAllowanceRecord> => {
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
    },
  );
}

// records whose on-chain read came back zero: spent through transfer_from (which
// emits no approve event) or already revoked. nothing to revoke there.
export function withoutConfirmedZero<T extends AllowanceRecord>(records: readonly T[]): T[] {
  return records.filter((r) => r.onChainAmount !== 0n);
}

// Soroban RPC only retains events for ~7 days, so a wider window is not just
// wasted work: it is dishonest, since anything older simply cannot be found via
// getEvents. NOTE: an allowance whose last approve is older than this window is
// not discoverable by event scan alone; the UI surfaces this ~7-day caveat so the
// empty/partial result isn't mistaken for "no allowances exist".
export const DEFAULT_SCAN_WINDOW_LEDGERS = EVENT_RETENTION_WINDOW_LEDGERS;

// human-facing description of the scan window, kept next to the constant so copy
// and behavior can't drift. update both together.
export const SCAN_WINDOW_DESCRIPTION = "about the last 7 days";

// the rpc reads at most 10,000 ledgers per getEvents call, so the window is cut
// into slices of that size and a few run at once instead of 13 in a row. the
// filter pins `from`, which keeps each slice cheap (about 0.1s on mainnet).
const SCAN_WINDOW_SLICE_LEDGERS = 10_000;
const SCAN_MIN_SLICE_LEDGERS = 625;
const SCAN_CONCURRENCY = 4;
// leaves room inside the caller's 30s discovery timeout
const SCAN_BUDGET_MS = 20_000;

export interface AllowanceScanOptions {
  // keep records whose live_until_ledger has passed (stamped expired: true)
  readonly includeExpired?: boolean;
  // keep records whose latest approve set the amount to zero (a revoke)
  readonly includeZero?: boolean;
  readonly budgetMs?: number;
}

export interface AllowanceScan {
  readonly records: AllowanceRecord[];
  // set when the scan did not cover the whole window; an allowance whose latest
  // approve falls in the uncovered part is missing or shows an older amount
  readonly incomplete: EventScanIncomplete | null;
}

// thrown by enumerateAllowances for a partial scan, carrying what was found
export class AllowanceScanIncompleteError extends Error {
  readonly partial: readonly AllowanceRecord[];
  readonly incomplete: EventScanIncomplete;
  constructor(partial: readonly AllowanceRecord[], incomplete: EventScanIncomplete) {
    super(
      `allowance scan incomplete (${incomplete.reason}): ledgers ${incomplete.rangeStartLedger}-${incomplete.coveredFromLedger - 1} not covered; ${incomplete.detail}`,
    );
    this.name = "AllowanceScanIncompleteError";
    this.partial = partial;
    this.incomplete = incomplete;
  }
}

// scan the user's sep-41 approve events and fold them into the latest allowance
// per (token, spender)
export async function scanAllowances(
  server: rpc.Server,
  userAddress: string,
  currentLedger: number,
  scanWindowLedgers: number = DEFAULT_SCAN_WINDOW_LEDGERS,
  options: AllowanceScanOptions = {},
): Promise<AllowanceScan> {
  if (currentLedger <= 0) {
    throw new RangeError(`scanAllowances: currentLedger must be > 0; got ${currentLedger}`);
  }
  if (scanWindowLedgers < 1) {
    throw new RangeError(
      `scanAllowances: scanWindowLedgers must be >= 1; got ${scanWindowLedgers}`,
    );
  }

  // rpc-level filter for sep-41 approve events
  const approveSymbolXdr = xdr.ScVal.scvSymbol("approve").toXdr("base64");
  const fromAddressXdr = new Address(userAddress).toScVal().toXdr("base64");
  const eventFilter3: rpc.Api.EventFilter = {
    type: "contract",
    topics: [[approveSymbolXdr, fromAddressXdr, "*"]],
  };
  const eventFilter4: rpc.Api.EventFilter = {
    type: "contract",
    topics: [[approveSymbolXdr, fromAddressXdr, "*", "*"]],
  };

  const scan = await scanEventWindows(server, [eventFilter3, eventFilter4], {
    lastLedger: currentLedger,
    lookbackLedgers: scanWindowLedgers,
    windowLedgers: SCAN_WINDOW_SLICE_LEDGERS,
    minWindowLedgers: SCAN_MIN_SLICE_LEDGERS,
    concurrency: SCAN_CONCURRENCY,
    budgetMs: options.budgetMs ?? SCAN_BUDGET_MS,
  });

  // the scan returns events in on-chain order (ledger, tx, op, event), so the
  // last approve seen for a key is the one in force, even two in one ledger
  const latest = new Map<string, AllowanceRecord>();
  for (const ev of scan.events) {
    const decoded = tryDecodeApproveEvent(ev, userAddress);
    if (decoded === null) continue;
    latest.set(`${decoded.contractId}|${decoded.spender}`, decoded);
  }

  // stamp each record with its expiry and filter by default
  const records: AllowanceRecord[] = [];
  for (const rec of latest.values()) {
    const expired = rec.live_until_ledger < currentLedger;
    if (expired && options.includeExpired !== true) continue;
    // approve(0) is how a revoke looks; it leaves nothing to show or revoke
    if (rec.amount === 0n && options.includeZero !== true) continue;
    records.push({ ...rec, expired });
  }
  return { records, incomplete: scan.incomplete };
}

// enumerate active sep-41 allowances the user granted. a scan that could not
// cover the whole window throws AllowanceScanIncompleteError (with the partial
// list) rather than returning a list that looks complete.
export async function enumerateAllowances(
  server: rpc.Server,
  userAddress: string,
  currentLedger: number,
  scanWindowLedgers: number = DEFAULT_SCAN_WINDOW_LEDGERS,
  options: AllowanceScanOptions = {},
): Promise<AllowanceRecord[]> {
  const scan = await scanAllowances(server, userAddress, currentLedger, scanWindowLedgers, options);
  if (scan.incomplete !== null) {
    throw new AllowanceScanIncompleteError(scan.records, scan.incomplete);
  }
  return scan.records;
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
  const kind = v.type;

  // primary path: tuple-as-vec (sep-41 reference encoding)
  if (kind === "scvVec") {
    const arr = v.vec;
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
    const entries = v.map;
    if (!entries) return null;
    let amount: bigint | undefined;
    let liveUntilLedger: number | undefined;
    for (const entry of entries) {
      const key = entry.key;
      if (key.type !== "scvSymbol") continue;
      const k = key.sym.toString();
      try {
        if (k === "amount") amount = fromScValI128(entry.val);
        else if (k === "live_until_ledger" || k === "expiration_ledger") {
          liveUntilLedger = fromScValU32(entry.val);
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
  sourceAccount: Horizon.AccountResponse | Account,
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
