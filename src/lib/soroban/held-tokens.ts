// discover standalone SEP-41 token balances an account holds directly (custom
// tokens someone transferred or minted to it), which the defi-position and
// allowance paths do not surface.
//
// soroban has no native "list every token an address holds": balances live in
// each token contract's own storage. so we scan the rpc event log for SEP-41
// events crediting the address, collect the emitting token contracts, then probe
// balance(address) on each and keep the positive ones. the credit events, per
// SEP-41 (stellar-protocol ecosystem/sep-0041.md v0.5.2):
//   transfer  [Symbol("transfer"), Address from, Address to]
//   mint      [Symbol("mint"), Address to]
//   mint      [Symbol("mint"), Address admin, Address to]  (soroban-token-sdk up to v22)
// a topic filter matches only events with exactly that many topics, so the
// stellar asset contract's events (CAP-67: transfer carries a fourth topic, the
// asset name, and mint is [mint, to, asset]) never match. that is on purpose:
// SAC balances are classic trustline assets, which the classic close path handles.
// the same rule misses a token that adds topics of its own (SEP-41 v0.5.2 allows
// it); such a token is found only through the manual add.
//
// the public rpc only retains a rolling window of events (~7 days), so tokens
// received before that window are missed, and on mainnet the wildcard-sender
// filter is costly enough that the scan rarely covers the whole window inside
// its budget. the result says how much was covered; it is paired with a manual
// "enter a token contract" affordance, never treated as an exhaustive list.

import { Address, xdr, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { mapConcurrent } from "@/lib/soroban/concurrency";
import {
  describeIncompleteScan,
  scanEventWindows,
  type EventScanIncomplete,
} from "@/lib/soroban/event-scan";
import { balance } from "@/lib/soroban/sep41";
import { shortAddress } from "@/lib/safe-display";
import { withTimeout } from "@/lib/with-timeout";

export interface HeldToken {
  readonly contractId: string;
  readonly balance: bigint;
}

export interface HeldTokenScan {
  // token contracts crediting the account with a readable, positive balance
  readonly held: readonly HeldToken[];
  // token contracts that credited the account but whose balance() could not be
  // read (a hostile/broken token, or a reverting probe). surfaced rather than
  // silently dropped: the account may hold value we can't confirm or auto-move.
  readonly unreadable: readonly string[];
  // set when the event scan did not cover the whole retention window; tokens
  // credited only in the uncovered part are missing from held/unreadable
  readonly incomplete: EventScanIncomplete | null;
  // the ledger the partner index's holdings were read at, when it was asked and
  // answered
  readonly partnerAsOfLedger: number | null;
  // why the partner index could not be used, when it was asked
  readonly partnerError: string | null;
}

// the contract tokens a partner index says an address holds now, read at
// asOfLedger. candidates only: each is read on chain like a scanned one.
export interface PartnerHeldTokens {
  readonly contractIds: readonly string[];
  readonly asOfLedger: number;
}

export interface HeldTokenScanOptions {
  readonly lookbackLedgers?: number;
  readonly budgetMs?: number;
  readonly windowLedgers?: number;
  readonly concurrency?: number;
  readonly partner?: () => Promise<PartnerHeldTokens>;
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

// scan SEP-41 credit events to `toAddress` and return the distinct emitting
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

// discover the SEP-41 tokens the account currently holds a positive balance of.
// returns both the readable positive-balance tokens and the contracts whose
// balance could not be read, so a caller can surface the latter instead of
// pretending the account was fully accounted for.
export async function discoverHeldTokens(
  server: rpc.Server,
  userAddress: string,
  currentLedger: number,
  network: NetworkConfig,
  options: HeldTokenScanOptions = {},
): Promise<HeldTokenScan> {
  const [scan, partner] = await Promise.all([
    scanTokensCreditedTo(server, userAddress, currentLedger, options),
    readPartnerHoldings(options.partner),
  ]);
  const candidates = [...new Set([...scan.contractIds, ...(partner.held?.contractIds ?? [])])];
  // the partner's holdings stand for every token received up to their ledger, so
  // a scan that covered back to there leaves nothing unchecked
  const incomplete =
    scan.incomplete !== null &&
    partner.held !== null &&
    partner.held.asOfLedger + 1 >= scan.incomplete.coveredFromLedger
      ? null
      : scan.incomplete;

  // probe every candidate concurrently (bounded), each independently time-boxed.
  // balance() is a read-only simulation (no signed tx), so a hostile token can
  // only make it fail, never smuggle auth. a token that reverts or stalls is
  // recorded as unreadable (not silently dropped): it can't be auto-drained, but
  // the user should know it exists and can target it manually.
  const probed = await mapConcurrent(candidates, PROBE_CONCURRENCY, async (contractId) => {
    try {
      const bal = await withTimeout(
        `balance(${shortAddress(contractId, 6, 0)})`,
        balance(server, contractId, userAddress, userAddress, network),
        PROBE_TIMEOUT_MS,
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
  return {
    held,
    unreadable,
    incomplete,
    partnerAsOfLedger: partner.held?.asOfLedger ?? null,
    partnerError: partner.error,
  };
}

async function readPartnerHoldings(
  read: (() => Promise<PartnerHeldTokens>) | undefined,
): Promise<{ held: PartnerHeldTokens | null; error: string | null }> {
  if (read === undefined) return { held: null, error: null };
  try {
    return { held: await read(), error: null };
  } catch (e) {
    return { held: null, error: errorMessage(e) };
  }
}
