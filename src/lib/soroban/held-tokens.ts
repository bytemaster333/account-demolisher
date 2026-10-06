// Discover standalone SEP-41 token balances an account holds directly (custom
// tokens someone transferred or minted to it), which the DeFi-position and
// allowance paths do not surface.
//
// Soroban has no native "list every token an address holds": balances live in
// each token contract's own storage. So we scan the RPC event log for SEP-41
// events crediting the address, collect the emitting token contracts, then probe
// balance(address) on each and keep the positive ones. The credit events, per
// SEP-41 (stellar-protocol ecosystem/sep-0041.md v0.5.2):
//   transfer  [Symbol("transfer"), Address from, Address to]
//   mint      [Symbol("mint"), Address to]
//   mint      [Symbol("mint"), Address admin, Address to]  (soroban-token-sdk up to v22)
// A topic filter matches only events with exactly that many topics, so the
// stellar asset contract's events (CAP-67: transfer carries a fourth topic, the
// asset name, and mint is [mint, to, asset]) never match. That is on purpose:
// SAC balances are classic trustline assets, which the classic close path handles.
// The same rule misses a token that adds topics of its own (SEP-41 v0.5.2 allows
// it); such a token is found only through the manual add.
//
// The public RPC only retains a rolling window of events (~7 days), so tokens
// received before that window are missed, and on mainnet the wildcard-sender
// filter is costly enough that the scan rarely covers the whole window inside
// its budget. The result says how much was covered; it is paired with a manual
// "enter a token contract" affordance, never treated as an exhaustive list.

import { Address, xdr, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { mapConcurrent } from "@/lib/soroban/concurrency";
import {
  describeIncompleteScan,
  scanEventWindows,
  type EventScanIncomplete,
} from "@/lib/soroban/event-scan";
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
  // set when the event scan did not cover the whole retention window; tokens
  // credited only in the uncovered part are missing from held/unreadable
  readonly incomplete: EventScanIncomplete | null;
}

export interface HeldTokenScanOptions {
  readonly lookbackLedgers?: number;
  readonly budgetMs?: number;
  readonly windowLedgers?: number;
  readonly concurrency?: number;
}

// measured against the public mainnet rpcs on 2026-10-06 with this filter: 1,000
// ledgers answer in about 0.4s (4s at worst) one request at a time, while four
// concurrent 2,000-ledger requests mostly come back -32001 after 10s. so small
// windows, two at a time; a refused window is halved down to 125 ledgers.
const SCAN_WINDOW_LEDGERS = 1_000;
const SCAN_MIN_WINDOW_LEDGERS = 125;
const SCAN_CONCURRENCY = 2;
// leaves room for the balance probes inside the caller's 30s discovery timeout
const SCAN_BUDGET_MS = 15_000;
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

export function heldTokenCreditFilter(toAddress: string): rpc.Api.EventFilter {
  const sym = (s: string) => xdr.ScVal.scvSymbol(s).toXdr("base64");
  const to = new Address(toAddress).toScVal().toXdr("base64");
  return {
    type: "contract",
    topics: [
      [sym("transfer"), "*", to],
      [sym("mint"), to],
      [sym("mint"), "*", to],
    ],
  };
}

// Scan SEP-41 credit events to `toAddress` and return the distinct emitting
// token contract ids (candidates to probe for a balance), with how much of the
// retention window the scan covered.
export async function scanTokensCreditedTo(
  server: rpc.Server,
  toAddress: string,
  currentLedger: number,
  options: HeldTokenScanOptions = {},
): Promise<{ contractIds: string[]; incomplete: EventScanIncomplete | null }> {
  if (currentLedger <= 0) {
    throw new RangeError(`scanTokensCreditedTo: currentLedger must be > 0; got ${currentLedger}`);
  }
  const scan = await scanEventWindows(server, [heldTokenCreditFilter(toAddress)], {
    lastLedger: currentLedger,
    ...(options.lookbackLedgers !== undefined ? { lookbackLedgers: options.lookbackLedgers } : {}),
    windowLedgers: options.windowLedgers ?? SCAN_WINDOW_LEDGERS,
    minWindowLedgers: SCAN_MIN_WINDOW_LEDGERS,
    concurrency: options.concurrency ?? SCAN_CONCURRENCY,
    budgetMs: options.budgetMs ?? SCAN_BUDGET_MS,
  });
  const contractIds = new Set<string>();
  for (const ev of scan.events) {
    if (ev.contractId !== undefined) contractIds.add(ev.contractId.contractId());
  }
  return { contractIds: [...contractIds], incomplete: scan.incomplete };
}

// user-facing note for a held-token scan that did not cover the whole window
export function heldTokenScanWarning(incomplete: EventScanIncomplete): string {
  return (
    `${describeIncompleteScan(incomplete, "standalone (custom SEP-41) tokens")} ` +
    "A token received before that may be missing from this plan. If you hold one, add it by its contract address to include it in the close."
  );
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
  options: HeldTokenScanOptions = {},
): Promise<HeldTokenScan> {
  const { contractIds: candidates, incomplete } = await scanTokensCreditedTo(
    server,
    userAddress,
    currentLedger,
    options,
  );

  // probe every candidate concurrently (bounded), each independently time-boxed.
  // balance() is a read-only simulation (no signed tx), so a hostile token can
  // only make it fail, never smuggle auth. A token that reverts or stalls is
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
    // p.bal === 0n: the account holds none of it; nothing to sweep, drop it
  }
  return { held, unreadable, incomplete };
}
