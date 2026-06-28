// strict 2-op merge-payment co-signing endpoint

import { getPublicEnv } from "@/lib/config/env";
import { resolveNetwork } from "@/lib/config/networks";
import { validateMediatorForwardEnvelope } from "@/lib/mediator/validator";
import { resolveMediatorFlow, startMediatorFlow } from "@/server/mediator-secret";

// node runtime: the flow-key derivation (node:crypto) and the validator pull in
// stellar-sdk / node crypto, which aren't edge-compatible
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 5 requests per 60s per IP
const RATE_LIMIT_CAPACITY = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

// token-bucket throttle keyed by remote IP. returns true when a token is consumed
// in-process map, so multi-instance deployments throttle per instance
function consumeToken(ip: string, now: number = Date.now()): boolean {
  const existing = buckets.get(ip);
  if (existing === undefined) {
    buckets.set(ip, { tokens: RATE_LIMIT_CAPACITY - 1, lastRefill: now });
    return true;
  }
  const elapsed = now - existing.lastRefill;
  if (elapsed > 0) {
    const refill = (elapsed / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_CAPACITY;
    existing.tokens = Math.min(RATE_LIMIT_CAPACITY, existing.tokens + refill);
    existing.lastRefill = now;
  }
  if (existing.tokens >= 1) {
    existing.tokens -= 1;
    return true;
  }
  return false;
}

// test-only: reset the per-IP buckets
export function __resetRateLimiterForTests(): void {
  buckets.clear();
}

const DEV_ALLOWED_ORIGINS = new Set<string>(["http://localhost:3000", "http://localhost:3001"]);

// build CORS headers for an origin. prod only allows origins in MEDIATOR_ALLOWED_ORIGIN (csv)
// when unset, no CORS headers (effectively same-origin)
function buildCorsHeaders(origin: string | null): Record<string, string> {
  if (origin === null) return {};

  const isProduction = process.env.NODE_ENV === "production";
  let allowed: Set<string>;

  if (isProduction) {
    const raw = process.env.MEDIATOR_ALLOWED_ORIGIN;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return {};
    }
    allowed = new Set(
      raw
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    );
  } else {
    allowed = DEV_ALLOWED_ORIGINS;
  }

  if (!allowed.has(origin)) return {};

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

function getRemoteIp(request: Request): string {
  // Behind a single trusted reverse proxy (Caddy), a client can spoof the LEFT
  // side of X-Forwarded-For, but the proxy appends the real peer IP as the
  // RIGHTMOST entry — so trust the last hop, not the client-controlled first.
  const xff = request.headers.get("x-forwarded-for");
  if (xff !== null && xff.length > 0) {
    const hops = xff
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const last = hops[hops.length - 1];
    if (last !== undefined && last.length > 0) return last;
  }
  const xRealIp = request.headers.get("x-real-ip");
  if (xRealIp !== null && xRealIp.length > 0) return xRealIp;
  try {
    return new URL(request.url).host || "unknown";
  } catch {
    return "unknown";
  }
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

// preflight: 204 + CORS when allow-listed, else bare 204
export function OPTIONS(request: Request): Response {
  const origin = request.headers.get("origin");
  const cors = buildCorsHeaders(origin);
  return new Response(null, { status: 204, headers: cors });
}

// rate-limit, parse body, validate envelope shape, then co-sign and return base64 xdr
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  const cors = buildCorsHeaders(origin);
  const ip = getRemoteIp(request);

  if (!consumeToken(ip)) {
    return jsonResponse(
      {
        ok: false,
        code: "RATE_LIMITED",
        reason: "Too many requests; try again shortly.",
      },
      429,
      { ...cors, "retry-after": "60" },
    );
  }

  let envelopeXdr: string;
  let flowToken: string;
  try {
    const raw = (await request.json()) as unknown;
    if (typeof raw !== "object" || raw === null) {
      return badRequest("Request body must be a JSON object.", cors);
    }
    const rec = raw as Record<string, unknown>;
    if (typeof rec.envelopeXdr !== "string" || rec.envelopeXdr.length === 0) {
      return badRequest("`envelopeXdr` must be a non-empty base64 string.", cors);
    }
    if (typeof rec.flowToken !== "string" || rec.flowToken.length === 0) {
      return badRequest(
        "`flowToken` must be a non-empty string; call GET to start a flow first.",
        cors,
      );
    }
    envelopeXdr = rec.envelopeXdr;
    flowToken = rec.flowToken;
  } catch {
    return badRequest("Request body is not valid JSON.", cors);
  }

  // resolve THIS flow's ephemeral keypair from the token. A forged/expired token
  // resolves to null and unlocks nothing; a thrown error means the master seed
  // is unset/malformed (scrubbed so no config detail leaks to the client).
  let flowKeypair: ReturnType<typeof resolveMediatorFlow>;
  try {
    flowKeypair = resolveMediatorFlow(flowToken);
  } catch {
    return jsonResponse(
      { ok: false, code: "MEDIATOR_NOT_CONFIGURED", reason: "Mediator is not configured." },
      500,
      cors,
    );
  }
  if (flowKeypair === null) {
    return jsonResponse(
      { ok: false, code: "INVALID_FLOW_TOKEN", reason: "Flow token is invalid or expired." },
      400,
      cors,
    );
  }

  const networkPassphrase = resolveNetwork(getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK).passphrase;

  // the mediator only co-signs the forward envelope: a native payout + an
  // accountMerge, both sourced by and drawn from THIS flow's ephemeral account.
  // Because the account is per-flow and only ever holds this user's funds, a
  // co-signed drain can never reach anyone else's balance.
  const result = validateMediatorForwardEnvelope(
    envelopeXdr,
    networkPassphrase,
    flowKeypair.publicKey(),
  );
  if (!result.ok) {
    return jsonResponse({ ok: false, code: result.code, reason: result.reason }, 400, cors);
  }

  try {
    const tx = result.tx;
    tx.sign(flowKeypair);
    const signedXdr = tx.toEnvelope().toXDR("base64");
    return jsonResponse({ ok: true, signedXdr }, 200, cors);
  } catch {
    return jsonResponse(
      { ok: false, code: "SIGNING_FAILED", reason: "Failed to sign envelope." },
      500,
      cors,
    );
  }
}

function badRequest(reason: string, cors: Record<string, string>): Response {
  return jsonResponse({ ok: false, code: "BAD_REQUEST", reason }, 400, cors);
}

function methodNotAllowed(): Response {
  return jsonResponse(
    { ok: false, code: "METHOD_NOT_ALLOWED", reason: "Only POST and GET are supported." },
    405,
    { allow: "POST, GET, OPTIONS" },
  );
}

// starts a fresh mediator flow: mints a one-time flow token and the ephemeral
// public key the browser orchestrator funds + merges into. The token must be
// echoed back at POST time to unlock signing for THIS flow's key only.
export function GET(): Response {
  try {
    const flow = startMediatorFlow();
    return jsonResponse(
      { flowToken: flow.flowToken, mediatorPublicKey: flow.mediatorPublicKey },
      200,
    );
  } catch {
    return jsonResponse(
      { ok: false, code: "MEDIATOR_NOT_CONFIGURED", reason: "Mediator is not configured." },
      500,
    );
  }
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const HEAD = methodNotAllowed;
