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
  // the amount read directly from the token contract (allowance(from, spender)),
  // when it has been confirmed. `amount` above is event-derived and a hostile
  // contract can emit a fabricated approve event, so this on-chain read is the
  // accuracy check: undefined = not confirmed, null = the confirm read failed, a
  // bigint = the real current allowance. see confirmAllowancesOnChain.
  readonly onChainAmount?: bigint | null;
}

// a record whose on-chain amount is defined (confirmed or failed), i.e. the
// result of confirmAllowancesOnChain.
export interface ConfirmedAllowanceRecord extends AllowanceRecord {
  readonly onChainAmount: bigint | null;
}

// true when a confirmed record's event-derived amount disagrees with the on-chain
// amount: the event was fabricated or is stale, so the displayed limit is a lie.
export function allowanceAmountMismatch(r: AllowanceRecord): boolean {
  return typeof r.onChainAmount === "bigint" && r.onChainAmount !== r.amount;
}

// confirm each event-derived allowance against on-chain state by calling the
// token's allowance(from, spender). best-effort and read-only: a failed read
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

// soroban rpc only retains events for ~7 days, so a wider window is not just
// wasted work: it is dishonest, since anything older simply cannot be found via
// getEvents. an allowance whose last approve is older than this window is not
// discoverable by event scan alone; the ui surfaces this ~7-day caveat so the
// empty/partial result isn't mistaken for "no allowances exist".
export const DEFAULT_SCAN_WINDOW_LEDGERS = EVENT_RETENTION_WINDOW_LEDGERS;

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

// any contract can emit approve(user, spender) events for spenders of its own
// choosing, and its allowance() is its own code too, so it can answer non-zero
// for every one of them: neither the event decoding nor the on-chain confirm
// filters a fabricated row. an honest token approved for this many spenders
// within the scan window is not a real use, so a contract's rows are cut to the
// most recent ones here, which bounds the confirm reads, the revokes a close
// plans and the rows the page renders. the cut is reported, never hidden. a
// stellar asset contract is not cut: it runs no token code, so every approve
// event it emitted is an approval the user signed.
export const MAX_SPENDERS_PER_CONTRACT = 20;

// a contract whose live approvals were cut to MAX_SPENDERS_PER_CONTRACT
export interface AllowanceOverflow {
  readonly contractId: string;
  // distinct spenders that passed the scan's filters (by default: live and
  // non-zero)
  readonly spenders: number;
  readonly kept: number;
}

export interface AllowanceScan {
  readonly records: AllowanceRecord[];
  // set when the scan did not cover the whole window; an allowance whose latest
  // approve falls in the uncovered part is missing or shows an older amount
  readonly incomplete: EventScanIncomplete | null;
  // contracts whose rows were cut; empty when nothing was
  readonly overflow: readonly AllowanceOverflow[];
}

// thrown by enumerateAllowances for a partial scan, carrying what was found
export class AllowanceScanIncompleteError extends Error {
  readonly partial: readonly AllowanceRecord[];
  readonly incomplete: EventScanIncomplete;
  // contracts whose rows were also cut, if any
  readonly overflow: readonly AllowanceOverflow[];
  constructor(
    partial: readonly AllowanceRecord[],
    incomplete: EventScanIncomplete,
    overflow: readonly AllowanceOverflow[] = [],
  ) {
    super(
      `allowance scan incomplete (${incomplete.reason}): ledgers ${incomplete.rangeStartLedger}-${incomplete.coveredFromLedger - 1} not covered; ${incomplete.detail}`,
    );
    this.name = "AllowanceScanIncompleteError";
    this.partial = partial;
    this.incomplete = incomplete;
    this.overflow = overflow;
  }
}

// thrown by enumerateAllowances when the scan covered the window but some
// contract's rows were cut, carrying the rows that were kept
export class AllowanceScanOverflowError extends Error {
  readonly partial: readonly AllowanceRecord[];
  readonly overflow: readonly AllowanceOverflow[];
  // always null: a scan that is also incomplete throws AllowanceScanIncompleteError
  readonly incomplete: null = null;
  constructor(partial: readonly AllowanceRecord[], overflow: readonly AllowanceOverflow[]) {
    super(describeAllowanceOverflow(overflow));
    this.name = "AllowanceScanOverflowError";
    this.partial = partial;
    this.overflow = overflow;
  }
}

// one sentence per cut contract, for the page and the close plan
export function describeAllowanceOverflow(overflow: readonly AllowanceOverflow[]): string {
  return overflow
    .map(
      (o) =>
        `Token contract ${o.contractId} is not a verified Stellar asset contract and reports ` +
        `approvals for ${o.spenders} different spenders, so only the ${o.kept} most recent are ` +
        `listed. Its own code emits these events and can fabricate them, and no real use needs ` +
        `that many, so treat this token as hostile.`,
    )
    .join(" ");
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
  const latest = new Map<string, { readonly rec: AllowanceRecord; readonly order: number }>();
  scan.events.forEach((ev, order) => {
    const decoded = tryDecodeApproveEvent(ev, userAddress);
    if (decoded === null) return;
    latest.set(`${decoded.contractId}|${decoded.spender}`, { rec: decoded, order });
  });

  // stamp each record with its expiry and filter by default
  const byContract = new Map<string, { readonly rec: AllowanceRecord; readonly order: number }[]>();
  for (const { rec, order } of latest.values()) {
    const expired = rec.live_until_ledger < currentLedger;
    if (expired && options.includeExpired !== true) continue;
    // approve(0) is how a revoke looks; it leaves nothing to show or revoke
    if (rec.amount === 0n && options.includeZero !== true) continue;
    const rows = byContract.get(rec.contractId) ?? [];
    rows.push({ rec: { ...rec, expired }, order });
    byContract.set(rec.contractId, rows);
  }

  // the cap counts every row that would be returned, so expired rows kept on
  // request cannot flood the list either
  const over = [...byContract].filter(([, rows]) => rows.length > MAX_SPENDERS_PER_CONTRACT);
  const sacs = await stellarAssetContracts(
    server,
    over.map(([id]) => id),
  );
  const records: AllowanceRecord[] = [];
  const overflow: AllowanceOverflow[] = [];
  for (const [contractId, rows] of byContract) {
    if (rows.length <= MAX_SPENDERS_PER_CONTRACT || sacs.has(contractId)) {
      for (const r of rows) records.push(r.rec);
      continue;
    }
    const kept = [...rows].sort((a, b) => b.order - a.order).slice(0, MAX_SPENDERS_PER_CONTRACT);
    kept.sort((a, b) => a.order - b.order);
    for (const r of kept) records.push(r.rec);
    overflow.push({ contractId, spenders: rows.length, kept: kept.length });
  }
  return { records, incomplete: scan.incomplete, overflow };
}

// the ids among these whose instance runs the built-in stellar asset contract.
// a SAC runs no token code, so its approve events are the user's own approvals
// and are never cut. an instance the rpc does not return can't be shown to be
// one and stays capped.
const INSTANCE_BATCH = 190;

async function stellarAssetContracts(
  server: rpc.Server,
  contractIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < contractIds.length; i += INSTANCE_BATCH) {
    const resp = await server.getLedgerEntries(
      ...contractIds.slice(i, i + INSTANCE_BATCH).map((id) =>
        xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: new Address(id).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent,
          }),
        ),
      ),
    );
    for (const entry of resp.entries) {
      const cd = xdr.expectUnionVariant(entry.val, "contractData").contractData;
      const instance = xdr.expectUnionVariant(cd.val, "scvContractInstance").instance;
      if (instance.executable.type === "contractExecutableStellarAsset") {
        out.add(Address.fromScAddress(cd.contract).toString());
      }
    }
  }
  return out;
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
    throw new AllowanceScanIncompleteError(scan.records, scan.incomplete, scan.overflow);
  }
  if (scan.overflow.length > 0) {
    throw new AllowanceScanOverflowError(scan.records, scan.overflow);
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

// builds a revoke by calling approve(from, spender, 0, currentLedger). the tx
// expires five minutes after ledgerCloseTime, the latest ledger's close time
export async function buildRevoke(
  server: rpc.Server,
  contractId: string,
  userAddress: string,
  spender: string,
  currentLedger: number,
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse | Account,
  ledgerCloseTime: number,
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
    ledgerCloseTime,
  );
}
