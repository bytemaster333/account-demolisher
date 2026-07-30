import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import type { FunnelStep, MetricNetwork, MetricPage } from "@/lib/metrics/events";

// Durable, dependency-free metrics store for a single-instance deployment.
//
// Two artifacts on disk:
//   closes.jsonl  — append-only, ONE verified close per line. This file is the
//                   auditable close ledger: every row is a real on-chain tx hash
//                   (verified before it was written), so the totals can always be
//                   re-derived and spot-checked against a block explorer.
//   counters.json — aggregate visit + funnel counters (no on-chain equivalent,
//                   so these are plain tallies, rewritten atomically on change).
//
// Writes are serialized through an in-process promise-chain mutex: correct for
// the one `next start` process this app runs as. (A multi-process deployment
// would need a real database; that is not this deployment, and the store is
// encapsulated so it can be swapped without touching callers.)

export interface VerifiedClose {
  readonly txHash: string;
  readonly network: MetricNetwork;
  readonly ledger: number;
  readonly closedAt: number; // ledger close time, unix seconds
  readonly reclaimedStroops: string; // bigint as string (native XLM reclaimed by the merge)
  readonly ops: CloseOpCounts;
  readonly recordedAt: number; // when we recorded it, unix ms
}

export interface CloseOpCounts {
  readonly total: number;
  readonly accountMerge: number;
  readonly changeTrust: number;
  readonly revokeSponsorship: number;
  readonly invokeHostFunction: number;
  readonly other: number;
}

interface Counters {
  // key: `${day}|${page}|${network ?? "-"}`
  visits: Record<string, number>;
  // key: `${network}|${step}`
  funnel: Record<string, number>;
}

export interface MetricsSnapshot {
  readonly generatedAt: number;
  readonly closes: {
    readonly total: number;
    readonly byNetwork: Record<string, number>;
    readonly reclaimedStroops: { readonly total: string; readonly byNetwork: Record<string, string> };
    readonly ops: Omit<CloseOpCounts, "other">;
    readonly recent: readonly VerifiedClose[];
  };
  readonly visits: {
    readonly total: number;
    readonly byDay: Record<string, number>;
    readonly byPage: Record<string, number>;
  };
  readonly funnel: Record<string, number>;
}

const CLOSES_FILE = "closes.jsonl";
const COUNTERS_FILE = "counters.json";
const DEFAULT_RECENT = 50;

function dayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export class MetricsStore {
  private readonly dir: string;
  private closes: VerifiedClose[] = [];
  private hashes = new Set<string>();
  private counters: Counters = { visits: {}, funnel: {} };
  private loadPromise: Promise<void> | null = null;
  // serializes mutations so concurrent requests never interleave a read-modify-write
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });

    try {
      const raw = await fs.readFile(path.join(this.dir, CLOSES_FILE), "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as VerifiedClose;
          if (rec && typeof rec.txHash === "string" && !this.hashes.has(rec.txHash)) {
            this.closes.push(rec);
            this.hashes.add(rec.txHash);
          }
        } catch {
          // a torn final line (crash mid-append) is skipped rather than fatal;
          // the ledger is append-only so at most the last line can be partial.
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    try {
      const raw = await fs.readFile(path.join(this.dir, COUNTERS_FILE), "utf8");
      const parsed = JSON.parse(raw) as Partial<Counters>;
      this.counters = { visits: parsed.visits ?? {}, funnel: parsed.funnel ?? {} };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  // chain a mutation onto the queue; the returned promise resolves with its result.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // keep the chain alive even if this task rejects, but don't swallow the caller's error
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flushCounters(): Promise<void> {
    const tmp = path.join(this.dir, `${COUNTERS_FILE}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(this.counters), "utf8");
    await fs.rename(tmp, path.join(this.dir, COUNTERS_FILE));
  }

  async recordVisit(page: MetricPage, network?: MetricNetwork, nowMs: number = Date.now()): Promise<void> {
    await this.ensureLoaded();
    await this.enqueue(async () => {
      const key = `${dayOf(nowMs)}|${page}|${network ?? "-"}`;
      this.counters.visits[key] = (this.counters.visits[key] ?? 0) + 1;
      await this.flushCounters();
    });
  }

  async recordFunnel(network: MetricNetwork, step: FunnelStep): Promise<void> {
    await this.ensureLoaded();
    await this.enqueue(async () => {
      const key = `${network}|${step}`;
      this.counters.funnel[key] = (this.counters.funnel[key] ?? 0) + 1;
      await this.flushCounters();
    });
  }

  async hasClose(txHash: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.hashes.has(txHash);
  }

  // Append a verified close. Idempotent: a hash already recorded returns
  // {added:false} and writes nothing (safe under retries / double beacons).
  async recordClose(close: VerifiedClose): Promise<{ added: boolean }> {
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.hashes.has(close.txHash)) return { added: false };
      this.hashes.add(close.txHash);
      this.closes.push(close);
      await fs.appendFile(path.join(this.dir, CLOSES_FILE), JSON.stringify(close) + "\n", "utf8");
      return { added: true };
    });
  }

  async snapshot(recentLimit: number = DEFAULT_RECENT): Promise<MetricsSnapshot> {
    await this.ensureLoaded();

    const byNetwork: Record<string, number> = {};
    const reclaimedByNetwork: Record<string, bigint> = {};
    let reclaimedTotal = 0n;
    const ops = { total: 0, accountMerge: 0, changeTrust: 0, revokeSponsorship: 0, invokeHostFunction: 0 };

    for (const c of this.closes) {
      byNetwork[c.network] = (byNetwork[c.network] ?? 0) + 1;
      const amt = BigInt(c.reclaimedStroops);
      reclaimedByNetwork[c.network] = (reclaimedByNetwork[c.network] ?? 0n) + amt;
      reclaimedTotal += amt;
      ops.total += c.ops.total;
      ops.accountMerge += c.ops.accountMerge;
      ops.changeTrust += c.ops.changeTrust;
      ops.revokeSponsorship += c.ops.revokeSponsorship;
      ops.invokeHostFunction += c.ops.invokeHostFunction;
    }

    const reclaimedByNetworkStr: Record<string, string> = {};
    for (const [k, v] of Object.entries(reclaimedByNetwork)) reclaimedByNetworkStr[k] = v.toString();

    const byDay: Record<string, number> = {};
    const byPage: Record<string, number> = {};
    let visitTotal = 0;
    for (const [key, n] of Object.entries(this.counters.visits)) {
      const [day, page] = key.split("|");
      byDay[day!] = (byDay[day!] ?? 0) + n;
      byPage[page!] = (byPage[page!] ?? 0) + n;
      visitTotal += n;
    }

    const recent = [...this.closes].sort((a, b) => b.closedAt - a.closedAt).slice(0, recentLimit);

    return {
      generatedAt: Date.now(),
      closes: {
        total: this.closes.length,
        byNetwork,
        reclaimedStroops: { total: reclaimedTotal.toString(), byNetwork: reclaimedByNetworkStr },
        ops,
        recent,
      },
      visits: { total: visitTotal, byDay, byPage },
      funnel: { ...this.counters.funnel },
    };
  }
}

let singleton: MetricsStore | null = null;

// default under the process cwd (/opt/account-demolisher in prod → data/ there),
// overridable via METRICS_DB_DIR.
export function getMetricsStore(): MetricsStore {
  if (!singleton) {
    const dir = process.env.METRICS_DB_DIR || path.join(process.cwd(), "data");
    singleton = new MetricsStore(dir);
  }
  return singleton;
}

// test seam: reset the process singleton so a fresh temp dir can be used.
export function __resetMetricsStoreForTests(): void {
  singleton = null;
}
