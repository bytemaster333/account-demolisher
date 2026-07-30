// Aggregate usage metrics. POST records a visit / funnel step / verified close;
// GET returns the aggregate snapshot behind an admin bearer token.
//
// A `close` is counted only after verifyCloseTx confirms it on-chain, so the
// ledger cannot be inflated with fabricated hashes. No addresses or personal data
// are accepted — a close carries only its public tx hash.

import { createHash, timingSafeEqual } from "node:crypto";

import { createLimiter, getRemoteIp } from "@/server/rate-limit";
import { getMetricsStore } from "@/server/metrics-store";
import { verifyCloseTx } from "@/server/close-verify";
import { metricEventSchema } from "@/lib/metrics/events";
import { resolveNetwork } from "@/lib/config/networks";

// node runtime: filesystem store + Horizon verification aren't edge-compatible
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// generous: visits + funnel steps are frequent and cheap; closes are rare.
const limiter = createLimiter(120, 60_000);
const MAX_BODY_BYTES = 2_048;

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!limiter.take(getRemoteIp(request))) {
    return json({ ok: false, code: "RATE_LIMITED" }, 429);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, reason: "Body too large." }, 413);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return json({ ok: false, reason: "Body is not valid JSON." }, 400);
  }

  const parsed = metricEventSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return json({ ok: false, reason: "Invalid metric event." }, 400);
  }
  const event = parsed.data;
  const store = getMetricsStore();

  try {
    if (event.type === "visit") {
      await store.recordVisit(event.page, event.network);
      return new Response(null, { status: 204 });
    }
    if (event.type === "funnel") {
      await store.recordFunnel(event.network, event.step);
      return new Response(null, { status: 204 });
    }

    // close: verify on-chain before counting; idempotent on tx hash.
    if (await store.hasClose(event.txHash)) {
      return json({ ok: true, duplicate: true }, 200);
    }
    const result = await verifyCloseTx(resolveNetwork(event.network), event.txHash);
    if (!result.ok) {
      return json({ ok: false, reason: result.reason }, result.retryable ? 503 : 422);
    }
    const { added } = await store.recordClose({ ...result.close, recordedAt: Date.now() });
    return json({ ok: true, added }, added ? 201 : 200);
  } catch {
    // never surface internals; a storage hiccup must not break the client flow.
    return json({ ok: false, reason: "Could not record metric." }, 500);
  }
}

// constant-time token check via fixed-length digests (avoids length leak).
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  // read the token directly from the environment rather than through
  // getServerEnv(): that validates the WHOLE server-env schema (incl.
  // MEDIATOR_SECRET), so an unrelated misconfigured var must not take the
  // metrics reader down with it. Recording never touches this path at all.
  const expected = process.env.METRICS_ADMIN_TOKEN;
  if (!expected || expected.length < 16) {
    return json({ ok: false, reason: "Metrics reads are not configured." }, 503);
  }
  const auth = request.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!provided || !tokenMatches(provided, expected)) {
    return json({ ok: false, reason: "Unauthorized." }, 401);
  }

  const snapshot = await getMetricsStore().snapshot();
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
