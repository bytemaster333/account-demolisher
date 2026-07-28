// strict 2-op merge-payment co-signing endpoint

import { StrKey } from "@stellar/stellar-sdk";

import { getPublicEnv } from "@/lib/config/env";
import { resolveNetwork } from "@/lib/config/networks";
import { validateMediatorForwardEnvelope } from "@/lib/mediator/validator";
import { resolveMediatorFlow, startMediatorFlow } from "@/server/mediator-secret";
import { createLimiter, getRemoteIp } from "@/server/rate-limit";

// node runtime: the flow-key derivation (node:crypto) and the validator pull in
// stellar-sdk / node crypto, which aren't edge-compatible
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 5 requests per 60s per IP. The shared limiter is bounded (evicts idle keys) and
// keys on TRUSTED_PROXY_HOPS-aware getRemoteIp, so a forged-XFF flood can't
// exhaust memory or mint fresh buckets per request.
const limiter = createLimiter(5, 60_000);

// test-only: reset the per-IP buckets
export function __resetRateLimiterForTests(): void {
  limiter.reset();
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

  if (!limiter.take(ip)) {
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
  let networkId: string | undefined;
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
    // Optional: the network the client built the envelope on. Lets one deployment
    // serve both testnet and mainnet closes. When absent (older clients, or a
    // single-network deployment) it falls back to the deployment default below.
    if (rec.network !== undefined) {
      if (rec.network !== "mainnet" && rec.network !== "testnet" && rec.network !== "futurenet") {
        return badRequest("`network` must be one of mainnet | testnet | futurenet.", cors);
      }
      networkId = rec.network;
    }
    envelopeXdr = rec.envelopeXdr;
    flowToken = rec.flowToken;
  } catch {
    return badRequest("Request body is not valid JSON.", cors);
  }

  // resolve THIS flow's ephemeral keypair from the token. A forged/expired token
  // resolves to null and unlocks nothing; a thrown error means the master seed
  // is unset/malformed (scrubbed so no config detail leaks to the client).
  let flow: ReturnType<typeof resolveMediatorFlow>;
  try {
    flow = resolveMediatorFlow(flowToken);
  } catch {
    return jsonResponse(
      { ok: false, code: "MEDIATOR_NOT_CONFIGURED", reason: "Mediator is not configured." },
      500,
      cors,
    );
  }
  if (flow === null) {
    return jsonResponse(
      { ok: false, code: "INVALID_FLOW_TOKEN", reason: "Flow token is invalid or expired." },
      400,
      cors,
    );
  }

  // per-request network (falls back to the deployment default) so a single
  // deployment can co-sign forwards for whichever network the client is on
  const networkPassphrase = resolveNetwork(
    networkId ?? getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK,
  ).passphrase;

  // the mediator only co-signs the forward envelope: a native payout + an
  // accountMerge, both sourced by and drawn from THIS flow's ephemeral account.
  // Because the account is per-flow and only ever holds this user's funds, a
  // co-signed drain can never reach anyone else's balance.
  const result = validateMediatorForwardEnvelope(
    envelopeXdr,
    networkPassphrase,
    flow.keypair.publicKey(),
    flow.destination,
  );
  if (!result.ok) {
    return jsonResponse({ ok: false, code: result.code, reason: result.reason }, 400, cors);
  }

  try {
    const tx = result.tx;
    tx.sign(flow.keypair);
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
export function GET(request: Request): Response {
  // the destination is committed into the flow token so the co-signer at POST
  // time is bound to it (a leaked token can't redirect the funds elsewhere)
  const destination = new URL(request.url).searchParams.get("destination");
  if (destination === null || !StrKey.isValidEd25519PublicKey(destination)) {
    return jsonResponse(
      {
        ok: false,
        code: "INVALID_DESTINATION",
        reason: "A valid `destination` (G...) query parameter is required to start a flow.",
      },
      400,
    );
  }
  try {
    const flow = startMediatorFlow(destination);
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
