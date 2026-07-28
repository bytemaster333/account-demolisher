// Discover standalone SEP-41 token balances an account holds DIRECTLY (custom
// tokens someone transferred to it, and SAC balances held in contract storage),
// which the DeFi-position and allowance paths do not surface.
//
// Soroban has no native "list every token an address holds" — balances live in
// each token contract's own storage. So we scan the RPC event log for `transfer`
// events crediting the address (topic[2] = `to`), collect the emitting token
// contracts, then probe balance(address) on each and keep the positive ones.
//
// LIMITATION (documented for callers): the public RPC only retains a rolling
// window of events (~7 days), so tokens received before that window are missed.
// This is intended to be paired with a manual "enter a token contract" affordance
// for completeness — not treated as an exhaustive enumeration.

import { Address, xdr, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { balance } from "@/lib/soroban/sep41";

export interface HeldToken {
  readonly contractId: string;
  readonly balance: bigint;
}

export interface HeldTokenScan {
  // token contracts crediting the account with a readable, positive balance
  readonly held: readonly HeldToken[];
  // token contracts that credited the account but whose balance() could not be
  // read (a hostile/broken token, or a reverting probe). Surfaced rather than
  // silently dropped: the account may hold value we can't confirm or auto-move.
  readonly unreadable: readonly string[];
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 50;
// ~7 days at 5s/ledger — the practical RPC retention window
const DEFAULT_SCAN_WINDOW_LEDGERS = 120_000;
const RETENTION_RETRY_MARGIN_LEDGERS = 60;
// balance() probes run concurrently (bounded) so a token-heavy account doesn't
// serialize into the discovery timeout; each probe is independently time-boxed so
// one slow/stalling contract can't consume the whole budget.
const PROBE_CONCURRENCY = 6;
const PROBE_TIMEOUT_MS = 8_000;

// reject if `p` doesn't settle within `ms`; always clears its timer
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// getEvents that rides out a transient blip (network / 5xx / slow) with a short
// backoff. A retention-range error ("ledger range: N - M") is NOT retried here —
// it's rethrown so the caller can re-clamp startLedger and retry deliberately.
async function getEventsWithRetry(
  server: rpc.Server,
  request: rpc.Api.GetEventsRequest,
  attempts = 3,
): Promise<rpc.Api.GetEventsResponse> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await server.getEvents(request);
    } catch (err) {
      if (parseRetentionFloor(err) !== null) throw err;
      lastErr = err;
      if (i < attempts - 1) await delay(300 * (i + 1));
    }
  }
  throw lastErr;
}

// run `fn` over `items` with at most `limit` in flight, preserving input order
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Scan `transfer` events crediting `toAddress` and return the distinct emitting
// token contract ids (candidates to probe for a balance).
export async function scanTokensCreditedTo(
  server: rpc.Server,
  toAddress: string,
  currentLedger: number,
  scanWindowLedgers: number = DEFAULT_SCAN_WINDOW_LEDGERS,
): Promise<string[]> {
  if (currentLedger <= 0) {
    throw new RangeError(`scanTokensCreditedTo: currentLedger must be > 0; got ${currentLedger}`);
  }
  let startLedger = Math.max(1, currentLedger - scanWindowLedgers);

  // sep-41 transfer topics: [symbol("transfer"), address(from), address(to)]
  const transferSymbolXdr = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
  const toAddressXdr = new Address(toAddress).toScVal().toXDR("base64");
  const filter: rpc.Api.EventFilter = {
    type: "contract",
    topics: [[transferSymbolXdr, "*", toAddressXdr]],
  };

  const contractIds = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const request: rpc.Api.GetEventsRequest =
      cursor === undefined
        ? { startLedger, filters: [filter], limit: PAGE_LIMIT }
        : { cursor, filters: [filter], limit: PAGE_LIMIT };

    let resp: rpc.Api.GetEventsResponse;
    try {
      resp = await getEventsWithRetry(server, request);
    } catch (err) {
      // retention-range clamp (mirrors the allowance scanner): if startLedger is
      // before the retained range the rpc reports "ledger range: N - M"
      const floor = page === 0 ? parseRetentionFloor(err) : null;
      if (floor === null || floor <= startLedger) throw err;
      startLedger = Math.min(currentLedger, floor + RETENTION_RETRY_MARGIN_LEDGERS);
      resp = await getEventsWithRetry(server, {
        startLedger,
        filters: [filter],
        limit: PAGE_LIMIT,
      });
    }

    for (const ev of resp.events ?? []) {
      if (ev.contractId !== undefined) contractIds.add(ev.contractId.contractId());
    }
    // end-of-results when there's no forward cursor (or it didn't advance)
    if (!resp.cursor || resp.cursor === cursor) break;
    cursor = resp.cursor;
  }

  return [...contractIds];
}

// Discover the SEP-41 tokens the account currently holds a positive balance of.
// Returns BOTH the readable positive-balance tokens AND the contracts whose
// balance could not be read, so a caller can surface the latter instead of
// pretending the account was fully accounted for.
export async function discoverHeldTokens(
  server: rpc.Server,
  userAddress: string,
  currentLedger: number,
  network: NetworkConfig,
  scanWindowLedgers?: number,
): Promise<HeldTokenScan> {
  const candidates = await scanTokensCreditedTo(
    server,
    userAddress,
    currentLedger,
    scanWindowLedgers,
  );

  // probe every candidate concurrently (bounded), each independently time-boxed.
  // balance() is a read-only simulation (no signed tx), so a hostile token can
  // only make it fail — never smuggle auth. A token that reverts or stalls is
  // recorded as UNREADABLE (not silently dropped): it can't be auto-drained, but
  // the user should know it exists and can target it manually.
  const probed = await mapConcurrent(candidates, PROBE_CONCURRENCY, async (contractId) => {
    try {
      const bal = await withTimeout(
        balance(server, contractId, userAddress, userAddress, network),
        PROBE_TIMEOUT_MS,
        `balance(${contractId.slice(0, 6)}…)`,
      );
      return { contractId, bal };
    } catch {
      return { contractId, bal: null };
    }
  });

  const held: HeldToken[] = [];
  const unreadable: string[] = [];
  for (const p of probed) {
    if (p.bal === null) unreadable.push(p.contractId);
    else if (p.bal > 0n) held.push({ contractId: p.contractId, balance: p.bal });
    // p.bal === 0n: the account holds none of it — nothing to sweep, drop it
  }
  return { held, unreadable };
}

function parseRetentionFloor(err: unknown): number | null {
  const direct =
    typeof (err as { message?: unknown } | undefined)?.message === "string"
      ? (err as { message: string }).message
      : "";
  const cause =
    typeof (err as { cause?: { message?: unknown } } | undefined)?.cause?.message === "string"
      ? (err as { cause: { message: string } }).cause.message
      : "";
  const match = `${direct} ${cause}`.match(/ledger range:\s*(\d+)\s*-\s*(\d+)/);
  if (!match) return null;
  const floor = Number.parseInt(match[1]!, 10);
  return Number.isFinite(floor) ? floor : null;
}
