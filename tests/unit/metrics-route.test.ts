import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// the store/route modules are server-only; stub the guard for vitest's node env
vi.mock("server-only", () => ({}));
// stub on-chain verification so the route test never touches the network
vi.mock("@/server/close-verify", () => ({ verifyCloseTx: vi.fn() }));

import { verifyCloseTx } from "@/server/close-verify";
import { __resetMetricsStoreForTests } from "@/server/metrics-store";
import { GET, POST } from "@/app/api/metrics/route";

const TOKEN = "unit-test-admin-token-000";
const HASH = "a".repeat(64);
let ipCounter = 0;

beforeAll(() => {
  process.env.METRICS_ADMIN_TOKEN = TOKEN;
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-route-"));
  process.env.METRICS_DB_DIR = dir;
  __resetMetricsStoreForTests();
  vi.mocked(verifyCloseTx).mockReset();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  ipCounter += 1;
  return POST(
    new Request("http://x/api/metrics", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${ipCounter}` },
    }),
  );
}

async function snapshot(): Promise<Record<string, unknown>> {
  const res = await GET(
    new Request("http://x/api/metrics", { headers: { authorization: `Bearer ${TOKEN}` } }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const okClose = {
  ok: true as const,
  close: {
    txHash: HASH,
    network: "testnet" as const,
    ledger: 10,
    closedAt: 1_700_000_000,
    reclaimedStroops: "5000000",
    ops: { total: 1, accountMerge: 1, changeTrust: 0, revokeSponsorship: 0, invokeHostFunction: 0, other: 0 },
  },
};

describe("POST /api/metrics", () => {
  it("records a visit (204) and reflects it in the snapshot", async () => {
    expect((await post({ type: "visit", page: "landing" })).status).toBe(204);
    const snap = await snapshot();
    expect((snap.visits as { total: number }).total).toBe(1);
  });

  it("records a funnel step (204)", async () => {
    expect((await post({ type: "funnel", step: "close_started", network: "mainnet" })).status).toBe(204);
    const snap = await snapshot();
    expect((snap.funnel as Record<string, number>)["mainnet|close_started"]).toBe(1);
  });

  it("verifies and records a close (201), then dedupes a repeat (200)", async () => {
    vi.mocked(verifyCloseTx).mockResolvedValue(okClose);
    const first = await post({ type: "close", network: "testnet", txHash: HASH });
    expect(first.status).toBe(201);

    const dup = await post({ type: "close", network: "testnet", txHash: HASH });
    expect(dup.status).toBe(200);
    expect((await dup.json()).duplicate).toBe(true);
    // verification only ran once — the dedupe short-circuits before re-verifying
    expect(vi.mocked(verifyCloseTx)).toHaveBeenCalledTimes(1);

    const snap = await snapshot();
    expect((snap.closes as { total: number }).total).toBe(1);
  });

  it("returns 422 for an unverifiable close and records nothing", async () => {
    vi.mocked(verifyCloseTx).mockResolvedValue({ ok: false, reason: "no account_merge", retryable: false });
    const res = await post({ type: "close", network: "testnet", txHash: HASH });
    expect(res.status).toBe(422);
    expect((await snapshot()).closes).toMatchObject({ total: 0 });
  });

  it("returns 503 (retryable) when verification is unavailable", async () => {
    vi.mocked(verifyCloseTx).mockResolvedValue({ ok: false, reason: "Horizon unavailable", retryable: true });
    expect((await post({ type: "close", network: "testnet", txHash: HASH })).status).toBe(503);
  });

  it("rejects malformed bodies (400) and oversized bodies (413)", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ type: "visit", page: "evil" })).status).toBe(400);
    expect((await post("x".repeat(4096))).status).toBe(413);
  });

  it("rate-limits a single client after the bucket empties (429)", async () => {
    const ip = "203.0.113.7";
    const hit = (): Promise<Response> =>
      POST(
        new Request("http://x/api/metrics", {
          method: "POST",
          body: JSON.stringify({ type: "visit", page: "landing" }),
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
        }),
      );
    let sawLimit = false;
    for (let i = 0; i < 130; i += 1) {
      if ((await hit()).status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});

describe("GET /api/metrics (admin)", () => {
  it("401s without a valid bearer token", async () => {
    expect((await GET(new Request("http://x/api/metrics"))).status).toBe(401);
    expect(
      (await GET(new Request("http://x/api/metrics", { headers: { authorization: "Bearer wrong" } })))
        .status,
    ).toBe(401);
  });

  it("returns the aggregate snapshot with the right token", async () => {
    const snap = await snapshot();
    expect(snap).toHaveProperty("closes");
    expect(snap).toHaveProperty("visits");
    expect(snap).toHaveProperty("funnel");
  });
});
