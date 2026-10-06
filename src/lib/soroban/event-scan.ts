// windowed getEvents scanning across the rpc's retention range.
//
// a getEvents call that pages by cursor walks the range one 10,000-ledger slice
// after another, and a filter with a wildcard segment (a transfer to the user
// from anyone) is costly enough that public mainnet hosts answer -32001 "request
// exceeded processing limit threshold" after about 10s. so the range is cut into
// explicit [startLedger, endLedger) windows, newest first, a few in flight at a
// time and under a time budget. a window the host refuses as too costly is
// halved and retried; a window whose page fills is halved too, because a cursor
// cannot carry an endLedger. what the scan did not cover is reported, never
// passed off as a complete result.

import type { rpc } from "@stellar/stellar-sdk";

import {
  EVENT_RETENTION_WINDOW_LEDGERS,
  MAX_RETENTION_RETRIES,
  RETENTION_RETRY_MARGIN_LEDGERS,
  parseRetentionFloor,
} from "./event-retention";
import { isProcessingLimitError } from "./rpc-client";

export type EventScanStopReason = "budget" | "processing-limit" | "rpc-error" | "page-cap";

export interface EventScanIncomplete {
  readonly reason: EventScanStopReason;
  // ledgers coveredFromLedger..lastLedger were all scanned; older ledgers of the
  // range (rangeStartLedger and up) may not have been
  readonly coveredFromLedger: number;
  readonly rangeStartLedger: number;
  readonly lastLedger: number;
  readonly detail: string;
}

export interface EventScanResult {
  // deduplicated and ascending by event id, the rpc's paging token, which orders
  // by ledger, transaction, operation and event index
  readonly events: readonly rpc.Api.EventResponse[];
  readonly incomplete: EventScanIncomplete | null;
}

export interface EventScanOptions {
  // newest ledger to include
  readonly lastLedger: number;
  readonly lookbackLedgers?: number;
  readonly windowLedgers: number;
  // a refused window is halved down to this size before it is given up on
  readonly minWindowLedgers: number;
  readonly concurrency: number;
  readonly budgetMs: number;
  readonly pageLimit?: number;
}

// stellar-rpc's hard cap on getEvents pagination.limit
export const RPC_EVENTS_MAX_LIMIT = 10_000;

interface Window {
  readonly start: number;
  // exclusive, as getEvents reads endLedger
  readonly end: number;
  readonly retentionRetries: number;
}

type WindowOutcome =
  | { readonly kind: "ok"; readonly events: readonly rpc.Api.EventResponse[] }
  | { readonly kind: "split" }
  | { readonly kind: "floor"; readonly floor: number }
  | { readonly kind: "fail"; readonly reason: EventScanStopReason; readonly detail: string };

export async function scanEventWindows(
  server: rpc.Server,
  filters: rpc.Api.EventFilter[],
  opts: EventScanOptions,
): Promise<EventScanResult> {
  const lookback = opts.lookbackLedgers ?? EVENT_RETENTION_WINDOW_LEDGERS;
  const pageLimit = opts.pageLimit ?? RPC_EVENTS_MAX_LIMIT;
  if (!Number.isInteger(opts.lastLedger) || opts.lastLedger <= 0) {
    throw new RangeError(`scanEventWindows: lastLedger must be > 0; got ${opts.lastLedger}`);
  }
  if (lookback < 1 || opts.windowLedgers < 1 || opts.minWindowLedgers < 1) {
    throw new RangeError("scanEventWindows: lookback and window sizes must be >= 1");
  }
  if (opts.concurrency < 1 || pageLimit < 1 || pageLimit > RPC_EVENTS_MAX_LIMIT) {
    throw new RangeError("scanEventWindows: concurrency and pageLimit out of range");
  }

  // start at the host's reported floor instead of sending a request that is
  // bound to fail below it. the margin covers the floor advancing while the
  // newer windows run first.
  const health = await server.getHealth();
  const lastLedger = Math.min(opts.lastLedger, health.latestLedger);
  let rangeStart = Math.max(
    1,
    lastLedger - lookback + 1,
    health.oldestLedger + RETENTION_RETRY_MARGIN_LEDGERS,
  );

  const queue: Window[] = [];
  for (let end = lastLedger + 1; end > rangeStart; end -= opts.windowLedgers) {
    queue.push({ start: Math.max(rangeStart, end - opts.windowLedgers), end, retentionRetries: 0 });
  }

  const byId = new Map<string, rpc.Api.EventResponse>();
  const covered: Window[] = [];
  let failure: { reason: EventScanStopReason; detail: string } | null = null;
  let stopPulling = false;

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetHit = new Promise<"budget">((resolve) => {
    budgetTimer = setTimeout(() => resolve("budget"), opts.budgetMs);
  });
  let budgetSpent = false;

  const runWindow = async (w: Window): Promise<WindowOutcome> => {
    try {
      const resp = await server.getEvents({
        startLedger: w.start,
        endLedger: w.end,
        filters,
        limit: pageLimit,
      });
      if (resp.events.length >= pageLimit) {
        if (w.end - w.start > 1) return { kind: "split" };
        return {
          kind: "fail",
          reason: "page-cap",
          detail: `ledger ${w.start} alone holds ${pageLimit} or more matching events`,
        };
      }
      return { kind: "ok", events: resp.events };
    } catch (err) {
      const floor = parseRetentionFloor(err);
      if (floor !== null && floor > w.start) return { kind: "floor", floor };
      if (isProcessingLimitError(err)) {
        if (w.end - w.start > opts.minWindowLedgers) return { kind: "split" };
        return {
          kind: "fail",
          reason: "processing-limit",
          detail: `the RPC refused ledgers ${w.start}-${w.end - 1} as too costly even ${w.end - w.start} ledgers at a time`,
        };
      }
      return { kind: "fail", reason: "rpc-error", detail: errorText(err) };
    }
  };

  const worker = async (): Promise<void> => {
    while (!stopPulling && !budgetSpent) {
      const w = queue.shift();
      if (w === undefined) return;
      const outcome = await Promise.race([runWindow(w), budgetHit]);
      if (outcome === "budget") {
        budgetSpent = true;
        return;
      }
      switch (outcome.kind) {
        case "ok":
          for (const ev of outcome.events) byId.set(ev.id, ev);
          covered.push(w);
          break;
        case "split": {
          const mid = w.start + Math.floor((w.end - w.start) / 2);
          // newer half first, so coverage keeps growing back from the tip
          queue.unshift(
            { start: mid, end: w.end, retentionRetries: w.retentionRetries },
            { start: w.start, end: mid, retentionRetries: w.retentionRetries },
          );
          break;
        }
        case "floor": {
          const clamped = outcome.floor + RETENTION_RETRY_MARGIN_LEDGERS;
          rangeStart = Math.max(rangeStart, Math.min(clamped, w.end));
          // the whole window aged out of retention: nothing left there to scan
          if (clamped >= w.end) break;
          if (w.retentionRetries >= MAX_RETENTION_RETRIES) {
            failure ??= {
              reason: "rpc-error",
              detail: `the RPC's retention floor kept moving past ledger ${w.start}`,
            };
            break;
          }
          queue.unshift({ start: clamped, end: w.end, retentionRetries: w.retentionRetries + 1 });
          break;
        }
        case "fail":
          failure ??= { reason: outcome.reason, detail: outcome.detail };
          // the failover client already tried every host, so another window
          // would most likely hit the same error; a refused window says nothing
          // about the cheaper ones still queued
          if (outcome.reason === "rpc-error") stopPulling = true;
          break;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: opts.concurrency }, worker));
  } finally {
    clearTimeout(budgetTimer);
  }

  const coveredFrom = contiguousCoverageStart(covered, lastLedger + 1);
  const events = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (coveredFrom <= rangeStart) return { events, incomplete: null };

  const stop =
    failure ??
    (budgetSpent
      ? { reason: "budget" as const, detail: `the ${opts.budgetMs} ms scan budget ran out` }
      : null);
  if (stop === null) {
    // every exit from the worker loop above records why it stopped early
    throw new Error("scanEventWindows: scan ended with uncovered ledgers and no recorded cause");
  }
  return {
    events,
    incomplete: {
      reason: stop.reason,
      coveredFromLedger: coveredFrom,
      rangeStartLedger: rangeStart,
      lastLedger,
      detail: stop.detail,
    },
  };
}

// the lowest ledger L such that every ledger from L up to (exclusive) `top` lies
// in a covered window. windows never overlap: they come from splitting disjoint
// ranges.
function contiguousCoverageStart(covered: readonly Window[], top: number): number {
  const sorted = [...covered].sort((a, b) => b.end - a.end);
  let from = top;
  for (const w of sorted) {
    if (w.end === from) from = w.start;
    else if (w.end < from) break;
  }
  return from;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  const m = (err as { message?: unknown } | null | undefined)?.message;
  return typeof m === "string" ? m : String(err);
}

// about how long `ledgers` ledgers take to close at 5s each, for user copy
export function describeLedgerSpan(ledgers: number): string {
  const hours = (ledgers * 5) / 3600;
  if (hours < 1) return `about ${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

const STOP_REASON_TEXT: Readonly<Record<EventScanStopReason, string>> = {
  budget: "it ran out of time",
  "processing-limit": "the RPC refused part of it as too costly (its processing limit)",
  "rpc-error": "the RPC returned an error",
  "page-cap": "the RPC returned more matching events than one request can hold",
};

// one sentence on what an incomplete scan did and did not check
export function describeIncompleteScan(incomplete: EventScanIncomplete, what: string): string {
  const coveredLedgers = incomplete.lastLedger - incomplete.coveredFromLedger + 1;
  const span =
    coveredLedgers > 0
      ? `only the most recent ${describeLedgerSpan(coveredLedgers)} of history`
      : "none of the history";
  const detail = incomplete.reason === "rpc-error" ? ` (${incomplete.detail})` : "";
  return `The scan for ${what} checked ${span} because ${STOP_REASON_TEXT[incomplete.reason]}${detail}.`;
}
