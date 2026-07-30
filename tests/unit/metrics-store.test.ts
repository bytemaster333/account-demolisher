import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// the module is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

import { MetricsStore, type VerifiedClose } from "@/server/metrics-store";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-store-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function close(txHash: string, network: VerifiedClose["network"], stroops: string): VerifiedClose {
  return {
    txHash,
    network,
    ledger: 100,
    closedAt: 1_700_000_000,
    reclaimedStroops: stroops,
    ops: { total: 3, accountMerge: 1, changeTrust: 1, revokeSponsorship: 0, invokeHostFunction: 1, other: 0 },
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
    expect((await store.recordClose(close("a".repeat(64), "mainnet", "10000000"))).added).toBe(true);
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

  it("is idempotent on tx hash — a duplicate close is not double counted", async () => {
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
