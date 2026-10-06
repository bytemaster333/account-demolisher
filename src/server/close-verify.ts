import "server-only";

import type { NetworkConfig } from "@/lib/config/networks";
import { CLOSE_MARKER_NAME, CLOSE_MARKER_VALUE } from "@/lib/metrics/close-marker";
import { decimalToStroops } from "@/lib/stellar/amount";
import type { CloseOpCounts, VerifiedClose } from "@/server/metrics-store";

// check a claimed close against Horizon before it is counted. the browser sends
// only a transaction hash; the server confirms that the transaction succeeded,
// that it is shaped like a close this app builds (one account merge whose source
// is the transaction source, only operation types the close builder emits, all
// from the closing account) and that it carries the on-chain close marker
// (close-marker.ts). the reclaimed XLM is read from the merge operation's own
// effects.
//
// what this proves: the hash is a real, successful merge that carried the
// marker. the marker is public, so anyone can put it in their own merge; the
// count means "merges that carried the marker", and per-day caps in the store
// bound what such copying can add.
//
// fails closed: if Horizon is unreachable the result is retryable and nothing is
// recorded.

export type VerifyResult =
  | { readonly ok: true; readonly close: Omit<VerifiedClose, "recordedAt"> }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface VerifyDeps {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 200;
// a transaction has at most 100 operations, so one page always holds them all;
// the cap only guards against a misbehaving server
const MAX_PAGES = 3;

// operation types the close builder emits in the final classic transaction
const CLOSE_OP_TYPES = new Set([
  "account_merge",
  "change_trust",
  "manage_sell_offer",
  "claim_claimable_balance",
  "path_payment_strict_send",
  "payment",
  "manage_data",
  "set_options",
  "liquidity_pool_withdraw",
  "create_account",
]);

const MARKER_VALUE_B64 = Buffer.from(CLOSE_MARKER_VALUE, "utf8").toString("base64");

interface HorizonTx {
  successful?: boolean;
  ledger?: number;
  created_at?: string;
  source_account?: string;
}

interface HorizonOp {
  id?: string;
  type?: string;
  source_account?: string;
  account?: string; // account_merge: the merged account
  into?: string; // account_merge destination
  name?: string; // manage_data
  value?: string; // manage_data, base64; "" when the entry is deleted
}

interface HorizonEffect {
  type?: string;
  account?: string;
  asset_type?: string;
  amount?: string;
}

interface Page<T> {
  _embedded?: { records?: T[] };
  _links?: { next?: { href?: string } };
}

// convert a Horizon decimal XLM amount ("12.3456789") to stroops (1e7). Horizon
// always sends a non-negative amount with up to 7 decimals; anything else throws
// rather than being counted as some other number.
export function xlmToStroops(amount: string): bigint {
  const stroops = decimalToStroops(amount);
  if (stroops < 0n) throw new Error(`close-verify: negative credited amount "${amount}"`);
  return stroops;
}

function countOps(ops: readonly HorizonOp[]): CloseOpCounts {
  const counts = {
    total: ops.length,
    accountMerge: 0,
    changeTrust: 0,
    revokeSponsorship: 0,
    invokeHostFunction: 0,
    other: 0,
  };
  for (const op of ops) {
    switch (op.type) {
      case "account_merge":
        counts.accountMerge += 1;
        break;
      case "change_trust":
        counts.changeTrust += 1;
        break;
      case "revoke_sponsorship":
        counts.revokeSponsorship += 1;
        break;
      case "invoke_host_function":
        counts.invokeHostFunction += 1;
        break;
      default:
        counts.other += 1;
    }
  }
  return counts;
}

class HorizonUnavailable extends Error {}

// why a transaction is not a close this app built, or null when it is one
function shapeProblem(tx: HorizonTx, ops: readonly HorizonOp[]): string | null {
  const merges = ops.filter((o) => o.type === "account_merge");
  if (merges.length !== 1) {
    return merges.length === 0
      ? "transaction contains no account_merge"
      : "transaction contains more than one account_merge";
  }
  const closing = tx.source_account;
  const merge = merges[0]!;
  if (typeof closing !== "string" || merge.account !== closing) {
    return "the merged account is not the transaction source";
  }
  for (const op of ops) {
    if (op.type === undefined || !CLOSE_OP_TYPES.has(op.type)) {
      return `transaction contains a ${op.type ?? "unknown"} operation, which a close never has`;
    }
    if (op.source_account !== closing) {
      return "an operation acts on an account other than the one being closed";
    }
  }
  const setAt = ops.findIndex(
    (o) => o.type === "manage_data" && o.name === CLOSE_MARKER_NAME && o.value === MARKER_VALUE_B64,
  );
  const deleteAt = ops.findIndex(
    (o, i) =>
      i > setAt &&
      o.type === "manage_data" &&
      o.name === CLOSE_MARKER_NAME &&
      (o.value === undefined || o.value === ""),
  );
  if (setAt < 0 || deleteAt < 0) return "transaction does not carry the close marker";
  return null;
}

export async function verifyCloseTx(
  network: NetworkConfig,
  txHash: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const horizonOrigin = new URL(network.horizon).origin;
  const base = `${network.horizon}/transactions/${txHash}`;

  const get = async <T>(url: string): Promise<{ status: number; body: T | null }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) return { status: res.status, body: null };
      return { status: res.status, body: (await res.json()) as T };
    } finally {
      clearTimeout(timer);
    }
  };

  // read every record of a paged Horizon collection
  const getAll = async <T>(url: string): Promise<T[]> => {
    const out: T[] = [];
    let next: string | undefined = url;
    for (let page = 0; next !== undefined; page++) {
      if (page >= MAX_PAGES) throw new HorizonUnavailable("too many result pages");
      const res: { status: number; body: Page<T> | null } = await get<Page<T>>(next);
      if (res.body === null) throw new HorizonUnavailable(`status ${res.status}`);
      const records = res.body._embedded?.records ?? [];
      out.push(...records);
      // Horizon always sends a next link; only a full page can have more after it
      const href = res.body._links?.next?.href;
      next =
        records.length === PAGE_LIMIT &&
        href !== undefined &&
        new URL(href).origin === horizonOrigin
          ? href
          : undefined;
    }
    return out;
  };

  let tx: { status: number; body: HorizonTx | null };
  let ops: HorizonOp[];
  try {
    tx = await get<HorizonTx>(base);
    if (tx.status === 404) {
      return { ok: false, reason: "transaction not found on this network", retryable: false };
    }
    if (tx.body === null) {
      return { ok: false, reason: `Horizon unavailable (status ${tx.status})`, retryable: true };
    }
    // a failed tx is a definitive rejection and shouldn't cost more round-trips
    if (tx.body.successful !== true) {
      return { ok: false, reason: "transaction did not succeed", retryable: false };
    }
    ops = await getAll<HorizonOp>(`${base}/operations?limit=${PAGE_LIMIT}`);
  } catch (e) {
    const detail = e instanceof HorizonUnavailable ? `: ${e.message}` : "";
    return { ok: false, reason: `verification request failed${detail}`, retryable: true };
  }

  const problem = shapeProblem(tx.body, ops);
  if (problem !== null) return { ok: false, reason: problem, retryable: false };

  // the reclaimed XLM is the merge operation's own credit to its destination
  const merge = ops.find((o) => o.type === "account_merge")!;
  let effects: HorizonEffect[];
  try {
    effects = await getAll<HorizonEffect>(
      `${network.horizon}/operations/${merge.id}/effects?limit=${PAGE_LIMIT}`,
    );
  } catch (e) {
    const detail = e instanceof HorizonUnavailable ? `: ${e.message}` : "";
    return { ok: false, reason: `could not read the merge effects${detail}`, retryable: true };
  }
  let reclaimed = 0n;
  for (const eff of effects) {
    if (
      eff.type === "account_credited" &&
      eff.asset_type === "native" &&
      eff.account === merge.into &&
      typeof eff.amount === "string"
    ) {
      try {
        reclaimed += xlmToStroops(eff.amount);
      } catch (e) {
        console.error(`close-verify: ${txHash}`, e);
        return { ok: false, reason: "the merge amount could not be read", retryable: false };
      }
    }
  }

  const closedAt = tx.body.created_at ? Math.floor(Date.parse(tx.body.created_at) / 1000) : 0;

  return {
    ok: true,
    close: {
      txHash,
      network: network.id,
      ledger: tx.body.ledger ?? 0,
      closedAt: Number.isFinite(closedAt) ? closedAt : 0,
      reclaimedStroops: reclaimed.toString(),
      ops: countOps(ops),
    },
  };
}
