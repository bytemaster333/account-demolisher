import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import type { FunnelStep, MetricNetwork, MetricPage } from "@/lib/metrics/events";
import { appendLineDurably, syncDir } from "@/server/durable-append";

// durable, dependency-free metrics store for a single-instance deployment.
//
// two files on disk:
//   closes.jsonl   append-only, one verified close per line. every row is an
//                  on-chain transaction that passed close-verify.ts (a merge
//                  carrying the close marker), so the totals can be re-derived
//                  and spot-checked against a block explorer.
//   counters.json  visit and funnel tallies (no on-chain equivalent), rewritten
//                  atomically and fsynced on change.
//
// writes are serialized through an in-process promise-chain mutex: correct for
// the one `next start` process this app runs as.

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
    readonly reclaimedStroops: {
      readonly total: string;
      readonly byNetwork: Record<string, string>;
    };
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
// closes accepted per network per day (by the day they were recorded). the
// close marker is public, so anyone can put it in their own merges; these caps
// bound how much such copying can add per day. testnet accounts are free, so
// testnet (and any other free network) gets a smaller cap than mainnet.
const DAILY_CLOSE_CAP: Readonly<Record<string, number>> = { mainnet: 1_000 };
const DEFAULT_DAILY_CLOSE_CAP = 200;

export type RecordCloseResult =
  { readonly added: true } | { readonly added: false; readonly reason: "duplicate" | "daily_cap" };

function dailyCap(network: string): number {
  return DAILY_CLOSE_CAP[network] ?? DEFAULT_DAILY_CLOSE_CAP;
}

function dayOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export class MetricsStore {
  private readonly dir: string;
  private closes: VerifiedClose[] = [];
  private hashes = new Set<string>();
  // closes recorded per `${network}|${day}`, for the daily caps
  private perDay = new Map<string, number>();
  private counters: Counters = { visits: {}, funnel: {} };
  private loadPromise: Promise<void> | null = null;
  // serializes mutations so concurrent requests never interleave a read-modify-write
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  // a failed load is not cached: the next call retries, so one transient fs
  // error doesn't disable the store until restart
  private async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.load().catch((e: unknown) => {
        this.loadPromise = null;
        throw e;
      });
    }
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    // start clean so a retried load is idempotent
    this.closes = [];
    this.hashes = new Set();
    this.perDay = new Map();
    this.counters = { visits: {}, funnel: {} };

    await fs.mkdir(this.dir, { recursive: true });

    const closesPath = path.join(this.dir, CLOSES_FILE);
    let raw = "";
    try {
      raw = await fs.readFile(closesPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: VerifiedClose;
      try {
        rec = JSON.parse(trimmed) as VerifiedClose;
      } catch {
        // a torn line (an append cut short by a crash or a full disk) is
        // skipped; the append after it starts on a line of its own
        continue;
      }
      if (rec && typeof rec.txHash === "string" && !this.hashes.has(rec.txHash)) {
        this.remember(rec);
      }
    }

    const countersPath = path.join(this.dir, COUNTERS_FILE);
    let counterText: string | null = null;
    try {
      counterText = await fs.readFile(countersPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (counterText !== null) {
      try {
        const parsed = JSON.parse(counterText) as Partial<Counters>;
        this.counters = { visits: parsed.visits ?? {}, funnel: parsed.funnel ?? {} };
      } catch (e) {
        // keep the unreadable file for inspection and start the tallies over,
        // rather than letting it block the closes ledger on every start
        const aside = `${countersPath}.corrupt-${Date.now()}`;
        await fs.rename(countersPath, aside);
        console.error(
          `metrics store: ${COUNTERS_FILE} was unreadable (${(e as Error).message}); moved to ${aside} and starting from zero`,
        );
      }
    }
  }

  private remember(close: VerifiedClose): void {
    this.closes.push(close);
    this.hashes.add(close.txHash);
    const key = `${close.network}|${dayOf(close.recordedAt)}`;
    this.perDay.set(key, (this.perDay.get(key) ?? 0) + 1);
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

  // write to a temp file, fsync it, rename over the old one, then fsync the
  // directory so the rename itself survives a power loss
  private async flushCounters(): Promise<void> {
    const tmp = path.join(this.dir, `${COUNTERS_FILE}.tmp`);
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(this.counters), "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, path.join(this.dir, COUNTERS_FILE));
    await syncDir(this.dir);
  }

  async recordVisit(
    page: MetricPage,
    network?: MetricNetwork,
    nowMs: number = Date.now(),
  ): Promise<void> {
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

  // append a verified close. idempotent on the hash (safe under retries and
  // double beacons). the close is counted in memory only after it is on disk,
  // so a failed write leaves nothing half-recorded and a retry can succeed.
  async recordClose(close: VerifiedClose): Promise<RecordCloseResult> {
    await this.ensureLoaded();
    return this.enqueue(async (): Promise<RecordCloseResult> => {
      if (this.hashes.has(close.txHash)) return { added: false, reason: "duplicate" };
      const day = dayOf(close.recordedAt);
      const cap = dailyCap(close.network);
      if ((this.perDay.get(`${close.network}|${day}`) ?? 0) >= cap) {
        console.error(
          `metrics store: daily close cap of ${cap} reached for ${close.network} on ${day}; not recording ${close.txHash}`,
        );
        return { added: false, reason: "daily_cap" };
      }
      await appendLineDurably(path.join(this.dir, CLOSES_FILE), JSON.stringify(close));
      this.remember(close);
      return { added: true };
    });
  }

  async snapshot(recentLimit: number = DEFAULT_RECENT): Promise<MetricsSnapshot> {
    await this.ensureLoaded();

    const byNetwork: Record<string, number> = {};
    const reclaimedByNetwork: Record<string, bigint> = {};
    let reclaimedTotal = 0n;
    const ops = {
      total: 0,
      accountMerge: 0,
      changeTrust: 0,
      revokeSponsorship: 0,
      invokeHostFunction: 0,
    };

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
    for (const [k, v] of Object.entries(reclaimedByNetwork))
      reclaimedByNetworkStr[k] = v.toString();

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
