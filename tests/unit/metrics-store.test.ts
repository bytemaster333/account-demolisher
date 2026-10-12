import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// the module is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

import { MetricsStore, type VerifiedClose } from "@/server/metrics-store";

let dir: string;

// the hooks only touch the temp dir, but on a heavily loaded runner that alone
// has run past the default 10s hook timeout, so they get their own
const FS_HOOK_TIMEOUT_MS = 60_000;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-store-"));
}, FS_HOOK_TIMEOUT_MS);
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
}, FS_HOOK_TIMEOUT_MS);

function close(txHash: string, network: VerifiedClose["network"], stroops: string): VerifiedClose {
  return {
    txHash,
    network,
    ledger: 100,
    closedAt: 1_700_000_000,
    reclaimedStroops: stroops,
    ops: {
      total: 3,
      accountMerge: 1,
      changeTrust: 1,
      revokeSponsorship: 0,
      invokeHostFunction: 1,
      other: 0,
    },
    recordedAt: 1_700_000_001_000,
  };
}

describe("MetricsStore", () => {
  it("records visits and funnel steps and aggregates them", async () => {
    const store = new MetricsStore(dir);
    await store.recordVisit("landing", undefined, Date.parse("2026-07-30T00:00:00Z"));
    await store.recordVisit("demolish", "mainnet", Date.parse("2026-07-30T00:00:00Z"));
    await store.recordVisit("demolish", "mainnet", Date.parse("2026-07-31T00:00:00Z"));
    await store.recordFunnel("mainnet", "wallet_connected");
    await store.recordFunnel("mainnet", "close_started");

    const snap = await store.snapshot();
    expect(snap.visits.total).toBe(3);
    expect(snap.visits.byPage.landing).toBe(1);
    expect(snap.visits.byPage.demolish).toBe(2);
    expect(snap.visits.byDay["2026-07-30"]).toBe(2);
    expect(snap.visits.byDay["2026-07-31"]).toBe(1);
    expect(snap.funnel["mainnet|wallet_connected"]).toBe(1);
    expect(snap.funnel["mainnet|close_started"]).toBe(1);
  });

  it("records verified closes and aggregates counts, reclaimed XLM, and ops", async () => {
    const store = new MetricsStore(dir);
    expect((await store.recordClose(close("a".repeat(64), "mainnet", "10000000"))).added).toBe(
      true,
    );
    expect((await store.recordClose(close("b".repeat(64), "testnet", "5000000"))).added).toBe(true);

    const snap = await store.snapshot();
    expect(snap.closes.total).toBe(2);
    expect(snap.closes.byNetwork.mainnet).toBe(1);
    expect(snap.closes.byNetwork.testnet).toBe(1);
    expect(snap.closes.reclaimedStroops.total).toBe("15000000");
    expect(snap.closes.reclaimedStroops.byNetwork.mainnet).toBe("10000000");
    expect(snap.closes.ops.accountMerge).toBe(2);
    expect(snap.closes.ops.invokeHostFunction).toBe(2);
    expect(snap.closes.recent).toHaveLength(2);
  });

  it("is idempotent on tx hash, a duplicate close is not double counted", async () => {
    const store = new MetricsStore(dir);
    expect((await store.recordClose(close("c".repeat(64), "mainnet", "7"))).added).toBe(true);
    expect((await store.recordClose(close("c".repeat(64), "mainnet", "7"))).added).toBe(false);
    expect(await store.hasClose("c".repeat(64))).toBe(true);
    const snap = await store.snapshot();
    expect(snap.closes.total).toBe(1);
  });

  it("persists across a restart (fresh instance, same dir)", async () => {
    const first = new MetricsStore(dir);
    await first.recordVisit("demolish", "mainnet", Date.parse("2026-07-30T00:00:00Z"));
    await first.recordClose(close("d".repeat(64), "mainnet", "42"));

    const second = new MetricsStore(dir);
    const snap = await second.snapshot();
    expect(snap.closes.total).toBe(1);
    expect(snap.closes.reclaimedStroops.total).toBe("42");
    expect(snap.visits.total).toBe(1);
    // dedupe survives reload: re-recording the persisted hash is a no-op
    expect((await second.recordClose(close("d".repeat(64), "mainnet", "42"))).added).toBe(false);
  });

  it("serializes concurrent writes without losing any (mutex)", async () => {
    const store = new MetricsStore(dir);
    const closes = Array.from({ length: 25 }, (_, i) =>
      store.recordClose(close(i.toString(16).padStart(64, "0"), "mainnet", "1")),
    );
    const visits = Array.from({ length: 25 }, () =>
      store.recordVisit("demolish", "mainnet", Date.parse("2026-07-30T00:00:00Z")),
    );
    await Promise.all([...closes, ...visits]);

    // a fresh instance proves everything was durably written, not just in memory
    const reloaded = new MetricsStore(dir);
    const snap = await reloaded.snapshot();
    expect(snap.closes.total).toBe(25);
    expect(snap.visits.total).toBe(25);
  });
});

describe("MetricsStore durability (L-96)", () => {
  it("retries a failed load instead of caching the failure", async () => {
    // a file where the data directory should be makes mkdir fail
    const blocked = path.join(dir, "data");
    await fs.writeFile(blocked, "not a directory");
    const store = new MetricsStore(blocked);
    await expect(store.snapshot()).rejects.toThrow();
    await fs.rm(blocked);
    const snap = await store.snapshot();
    expect(snap.closes.total).toBe(0);
    await store.recordVisit("landing");
    expect((await store.snapshot()).visits.total).toBe(1);
  });

  it("moves an unreadable counters.json aside and keeps the closes ledger", async () => {
    const first = new MetricsStore(dir);
    await first.recordClose(close("e".repeat(64), "mainnet", "9"));
    await fs.writeFile(path.join(dir, "counters.json"), "{ not json");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const second = new MetricsStore(dir);
    const snap = await second.snapshot();
    expect(snap.closes.total).toBe(1);
    expect(snap.visits.total).toBe(0);
    expect(err).toHaveBeenCalled();
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith("counters.json.corrupt-"))).toBe(true);
    await second.recordVisit("landing");
    expect((await new MetricsStore(dir).snapshot()).visits.total).toBe(1);
    err.mockRestore();
  });

  it("treats an empty counters.json (power loss before the data hit disk) the same way", async () => {
    await fs.writeFile(path.join(dir, "counters.json"), "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new MetricsStore(dir);
    await expect(store.snapshot()).resolves.toMatchObject({ visits: { total: 0 } });
    err.mockRestore();
  });

  it("keeps the close appended after a torn ledger line", async () => {
    const torn = JSON.stringify(close("f".repeat(64), "mainnet", "1")).slice(0, 40);
    await fs.writeFile(path.join(dir, "closes.jsonl"), torn);
    const store = new MetricsStore(dir);
    expect((await store.recordClose(close("1".repeat(64), "mainnet", "5"))).added).toBe(true);

    const reloaded = new MetricsStore(dir);
    const snap = await reloaded.snapshot();
    expect(snap.closes.total).toBe(1);
    expect(await reloaded.hasClose("1".repeat(64))).toBe(true);
  });

  it("does not count a close whose append failed", async () => {
    const store = new MetricsStore(dir);
    await store.snapshot();
    // a directory where the ledger file should be makes the append fail
    await fs.mkdir(path.join(dir, "closes.jsonl"));
    await expect(store.recordClose(close("2".repeat(64), "mainnet", "5"))).rejects.toThrow();
    expect(await store.hasClose("2".repeat(64))).toBe(false);
    expect((await store.snapshot()).closes.total).toBe(0);
  });
});

describe("MetricsStore torn append in a running process (NP5-61)", () => {
  it("keeps a close appended after an earlier append failed part way", async () => {
    const store = new MetricsStore(dir);
    await store.snapshot();
    const ledger = path.join(dir, "closes.jsonl");
    const realOpen = fs.open.bind(fs);
    // the first append to the ledger writes half its line, then the disk fills
    let failed = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const fh = await realOpen(file, flags, mode);
      if (failed || file !== ledger) return fh;
      failed = true;
      const tornWrite = async (text: string): Promise<never> => {
        await fh.write(text.slice(0, Math.floor(text.length / 2)));
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
          code: "ENOSPC",
        });
      };
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === "writeFile") return tornWrite;
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      await expect(store.recordClose(close("3".repeat(64), "mainnet", "5"))).rejects.toThrow(
        /ENOSPC/,
      );
      expect(failed).toBe(true);
      expect((await store.recordClose(close("4".repeat(64), "mainnet", "7"))).added).toBe(true);
    } finally {
      open.mockRestore();
    }

    // the torn fragment, then the next close on a line of its own
    const lines = (await fs.readFile(ledger, "utf8")).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[1]!)).toMatchObject({ txHash: "4".repeat(64) });

    const reloaded = new MetricsStore(dir);
    expect(await reloaded.hasClose("4".repeat(64))).toBe(true);
    expect(await reloaded.hasClose("3".repeat(64))).toBe(false);
    expect((await reloaded.snapshot()).closes.reclaimedStroops.total).toBe("7");
  });
});

describe("MetricsStore ledger creation is durable (NPF-39)", () => {
  // records every fsync, the ledger's and the data directory's, in order
  function watchSyncs(ledger: string) {
    const realOpen = fs.open.bind(fs);
    const syncs: string[] = [];
    const open = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const fh = await realOpen(file, flags, mode);
      const name = file === ledger ? "ledger" : file === dir ? "dir" : null;
      if (name === null) return fh;
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === "sync") {
            return async () => {
              await target.sync();
              syncs.push(name);
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    return { syncs, open };
  }

  it("fsyncs the directory after the append that creates closes.jsonl", async () => {
    const store = new MetricsStore(dir);
    await store.snapshot();
    const ledger = path.join(dir, "closes.jsonl");
    const { syncs, open } = watchSyncs(ledger);
    try {
      expect((await store.recordClose(close("5".repeat(64), "mainnet", "5"))).added).toBe(true);
    } finally {
      open.mockRestore();
    }
    expect(syncs).toEqual(["ledger", "dir"]);
  });

  it("does not fsync the directory again once the ledger holds a line", async () => {
    const store = new MetricsStore(dir);
    expect((await store.recordClose(close("6".repeat(64), "mainnet", "5"))).added).toBe(true);
    const { syncs, open } = watchSyncs(path.join(dir, "closes.jsonl"));
    try {
      expect((await store.recordClose(close("7".repeat(64), "mainnet", "5"))).added).toBe(true);
    } finally {
      open.mockRestore();
    }
    expect(syncs).toEqual(["ledger"]);
  });
});

describe("MetricsStore daily close caps (M-52)", () => {
  it("stops counting a network's closes for the day at its cap and logs it", async () => {
    // 199 closes already on disk from before a restart (written directly: 199
    // durable appends take seconds on a busy disk), then the 200th live
    const ledger = Array.from(
      { length: 199 },
      (_, i) => JSON.stringify(close(i.toString(16).padStart(64, "0"), "testnet", "1")) + "\n",
    ).join("");
    await fs.writeFile(path.join(dir, "closes.jsonl"), ledger);
    const store = new MetricsStore(dir);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await store.recordClose(close("e".repeat(64), "testnet", "1"))).added).toBe(true);
    const over = await store.recordClose(close("f".repeat(64), "testnet", "1"));
    expect(over).toEqual({ added: false, reason: "daily_cap" });
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/daily close cap of 200/));

    // mainnet has its own budget, and the next day starts over
    expect((await store.recordClose(close("9".repeat(64), "mainnet", "1"))).added).toBe(true);
    const tomorrow = { ...close("8".repeat(64), "testnet", "1"), recordedAt: 1_700_100_000_000 };
    expect((await store.recordClose(tomorrow)).added).toBe(true);
    err.mockRestore();
  });

  it("reports a duplicate distinctly from a cap", async () => {
    const store = new MetricsStore(dir);
    await store.recordClose(close("3".repeat(64), "mainnet", "1"));
    expect(await store.recordClose(close("3".repeat(64), "mainnet", "1"))).toEqual({
      added: false,
      reason: "duplicate",
    });
  });
});
