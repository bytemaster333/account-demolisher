import "server-only";

import type { NetworkConfig } from "@/lib/config/networks";
import type { MetricNetwork } from "@/lib/metrics/events";
import type { CloseOpCounts, VerifiedClose } from "@/server/metrics-store";

// Independently verify that a claimed close really happened on-chain before it is
// counted. This is what makes the close ledger trustworthy rather than
// self-reported: the browser sends only a tx hash, and the server confirms
// against Horizon that the transaction (a) succeeded and (b) contains an
// account_merge, then derives the reclaimed XLM and op breakdown from the public
// ledger. A hash that doesn't check out is never recorded, so the counter cannot
// be inflated with fabricated or replayed hashes.
//
// Fail CLOSED: if Horizon is unreachable we return a retryable failure and record
// nothing, rather than counting an unverified close.

export type VerifyResult =
  | { readonly ok: true; readonly close: Omit<VerifiedClose, "recordedAt"> }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface VerifyDeps {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface HorizonTx {
  successful?: boolean;
  ledger?: number;
  created_at?: string;
}

interface HorizonOp {
  type?: string;
  into?: string; // account_merge destination
}

interface HorizonEffect {
  type?: string;
  account?: string;
  asset_type?: string;
  amount?: string;
}

interface Embedded<T> {
  _embedded?: { records?: T[] };
}

// Convert a Horizon decimal XLM amount ("12.3456789") to stroops (1e7). Robust to
// missing/extra fractional digits; ignores anything unparseable (returns 0n).
export function xlmToStroops(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,7}))?\d*$/.exec(amount.trim());
  if (!m) return 0n;
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").padEnd(7, "0");
  return whole * 10_000_000n + BigInt(frac || "0");
}

function countOps(ops: HorizonOp[]): CloseOpCounts {
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

export async function verifyCloseTx(
  network: NetworkConfig,
  txHash: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = `${network.horizon}/transactions/${txHash}`;

  const get = async <T>(url: string): Promise<{ status: number; body: T | null }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (res.status === 404) return { status: 404, body: null };
      if (!res.ok) return { status: res.status, body: null };
      return { status: res.status, body: (await res.json()) as T };
    } finally {
      clearTimeout(timer);
    }
  };

  let tx: { status: number; body: HorizonTx | null };
  let opsResp: { status: number; body: Embedded<HorizonOp> | null };
  let effResp: { status: number; body: Embedded<HorizonEffect> | null };
  try {
    tx = await get<HorizonTx>(base);
    if (tx.status === 404) {
      return { ok: false, reason: "transaction not found on this network", retryable: false };
    }
    if (tx.status >= 500 || tx.body === null) {
      return { ok: false, reason: `Horizon unavailable (status ${tx.status})`, retryable: true };
    }
    // check success BEFORE fetching ops/effects: a failed tx is a definitive
    // rejection and shouldn't cost two more round-trips.
    if (tx.body.successful !== true) {
      return { ok: false, reason: "transaction did not succeed", retryable: false };
    }
    [opsResp, effResp] = await Promise.all([
      get<Embedded<HorizonOp>>(`${base}/operations?limit=200`),
      get<Embedded<HorizonEffect>>(`${base}/effects?limit=200`),
    ]);
  } catch {
    // network error / timeout / abort → retryable, count nothing
    return { ok: false, reason: "verification request failed", retryable: true };
  }

  if (opsResp.body === null || effResp.body === null) {
    return { ok: false, reason: "could not read transaction operations", retryable: true };
  }

  const ops = opsResp.body._embedded?.records ?? [];
  const opCounts = countOps(ops);
  if (opCounts.accountMerge < 1) {
    return { ok: false, reason: "transaction contains no account_merge", retryable: false };
  }

  // reclaimed native XLM = credits to the merge destination(s) in this tx.
  const destinations = new Set(
    ops.filter((o) => o.type === "account_merge" && typeof o.into === "string").map((o) => o.into!),
  );
  const effects = effResp.body._embedded?.records ?? [];
  let reclaimed = 0n;
  for (const eff of effects) {
    if (
      eff.type === "account_credited" &&
      eff.asset_type === "native" &&
      typeof eff.account === "string" &&
      destinations.has(eff.account) &&
      typeof eff.amount === "string"
    ) {
      reclaimed += xlmToStroops(eff.amount);
    }
  }

  const closedAt = tx.body.created_at ? Math.floor(Date.parse(tx.body.created_at) / 1000) : 0;

  return {
    ok: true,
    close: {
      txHash,
      network: network.id as MetricNetwork,
      ledger: tx.body.ledger ?? 0,
      closedAt: Number.isFinite(closedAt) ? closedAt : 0,
      reclaimedStroops: reclaimed.toString(),
      ops: opCounts,
    },
  };
}
