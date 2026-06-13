// strict 2-op merge-payment co-signing endpoint

import { getPublicEnv } from "@/lib/config/env";
import { resolveNetwork } from "@/lib/config/networks";
import { validateMediatorForwardEnvelope, validateMergeEnvelope } from "@/lib/mediator/validator";
import { getMediatorKeypair } from "@/server/mediator-secret";

// node runtime: getMediatorKeypair() and the validator pull in stellar-sdk, which isn't edge-compatible
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
  const xff = request.headers.get("x-forwarded-for");
  if (xff !== null && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
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
  let kind: "merge" | "forward" = "merge";
  try {
    const raw = (await request.json()) as unknown;
    if (typeof raw !== "object" || raw === null || !("envelopeXdr" in raw)) {
      return jsonResponse(
        {
          ok: false,
          code: "BAD_REQUEST",
          reason: "Request body must be a JSON object with an `envelopeXdr` string field.",
        },
        400,
        cors,
      );
    }
    const candidate = (raw as { envelopeXdr: unknown }).envelopeXdr;
    if (typeof candidate !== "string" || candidate.length === 0) {
      return jsonResponse(
        {
          ok: false,
          code: "BAD_REQUEST",
          reason: "`envelopeXdr` must be a non-empty base64 string.",
        },
        400,
        cors,
      );
    }
    envelopeXdr = candidate;
    const rawKind = (raw as { kind?: unknown }).kind;
    if (rawKind === "merge" || rawKind === "forward") {
      kind = rawKind;
    } else if (rawKind !== undefined) {
      return jsonResponse(
        {
          ok: false,
          code: "BAD_REQUEST",
          reason: '`kind` must be either "merge" or "forward" when supplied.',
        },
        400,
        cors,
      );
    }
  } catch {
    return jsonResponse(
      { ok: false, code: "BAD_REQUEST", reason: "Request body is not valid JSON." },
      400,
      cors,
    );
  }

  let networkPassphrase: string;
  let mediatorPublicKey: string;
  try {
    const network = resolveNetwork(getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK);
    networkPassphrase = network.passphrase;
    mediatorPublicKey = getMediatorKeypair().publicKey();
  } catch (err) {
    // don't leak details that might include the seed
    return jsonResponse(
      {
        ok: false,
        code: "MEDIATOR_NOT_CONFIGURED",
        reason: err instanceof Error ? err.message : "Mediator is not configured.",
      },
      500,
      cors,
    );
  }

  // forward = mediator-source payment + accountMerge envelope; everything else uses the user-side merge shape
  const result =
    kind === "forward"
      ? validateMediatorForwardEnvelope(envelopeXdr, networkPassphrase, mediatorPublicKey)
      : validateMergeEnvelope(envelopeXdr, networkPassphrase, mediatorPublicKey);
  if (!result.ok) {
    return jsonResponse({ ok: false, code: result.code, reason: result.reason }, 400, cors);
  }

  try {
    const tx = result.tx;
    tx.sign(getMediatorKeypair());
    const signedXdr = tx.toEnvelope().toXDR("base64");
    return jsonResponse({ ok: true, signedXdr }, 200, cors);
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        code: "SIGNING_FAILED",
        reason: err instanceof Error ? err.message : "Failed to sign envelope.",
      },
      500,
      cors,
    );
  }
}

function methodNotAllowed(): Response {
  return jsonResponse(
    { ok: false, code: "METHOD_NOT_ALLOWED", reason: "Only POST and GET are supported." },
    405,
    { allow: "POST, GET, OPTIONS" },
  );
}

// returns the mediator's public key so the browser orchestrator can build the merge op
// only used by the reference (server-held) deployment; self-hosted mode generates its own keypair
export function GET(): Response {
  try {
    const publicKey = getMediatorKeypair().publicKey();
    return jsonResponse({ mediatorPublicKey: publicKey }, 200);
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        code: "MEDIATOR_NOT_CONFIGURED",
        reason: err instanceof Error ? err.message : "Mediator is not configured.",
      },
      500,
    );
  }
}

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const HEAD = methodNotAllowed;
