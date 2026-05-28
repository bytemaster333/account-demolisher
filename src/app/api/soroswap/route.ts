// typed proxy to the Soroswap aggregator REST API. keeps SOROSWAP_API_KEY server-side.
//
// the browser-side client posts { op, payload }; we route the supported op
// to the matching upstream endpoint and forward the response verbatim
// (Authorization header injected here, stripped from outbound responses).
//
// the API key must never appear in the response body, response headers, or any log line.
// this route is a pure proxy — slippage/allowlist/route-plan checks happen in the aggregator layer.

import { getServerEnv, requireServerEnv } from "@/server/server-env";

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

export function __resetRateLimiterForTests(): void {
  buckets.clear();
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

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// preserve upstream status. only content-type on the response — never echo auth headers
function forwardUpstream(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// strip the API key out of an upstream message
function sanitizeMessage(message: string, apiKey: string): string {
  if (apiKey.length === 0) return message;
  return message.split(apiKey).join("[redacted]");
}

// allowed ops — anything else returns 400 so this never becomes an open relay
type Op = "getProtocols" | "quote" | "build" | "send";

const ALLOWED_OPS: ReadonlySet<Op> = new Set<Op>(["getProtocols", "quote", "build", "send"]);

interface OpRequest {
  op: Op;
  payload: unknown;
}

function parseOpRequest(raw: unknown): OpRequest | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "Request body must be a JSON object." };
  }
  const obj = raw as Record<string, unknown>;
  const op = obj["op"];
  if (typeof op !== "string") {
    return { error: "`op` must be a string." };
  }
  if (!ALLOWED_OPS.has(op as Op)) {
    return { error: `Unknown op "${op}". Allowed: ${[...ALLOWED_OPS].join(", ")}.` };
  }
  const payload = "payload" in obj ? obj["payload"] : undefined;
  return { op: op as Op, payload };
}

interface UpstreamCall {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

// map an op + payload to an upstream HTTP call. minimal shape validation only.
function planUpstreamCall(req: OpRequest): UpstreamCall | { error: string } {
  switch (req.op) {
    case "getProtocols": {
      const payload = (req.payload ?? {}) as Record<string, unknown>;
      const network = payload["network"];
      if (typeof network !== "string" || network.length === 0) {
        return { error: "`payload.network` must be a non-empty string." };
      }
      return { method: "GET", path: `/protocols?network=${encodeURIComponent(network)}` };
    }
    case "quote": {
      if (typeof req.payload !== "object" || req.payload === null) {
        return { error: "`payload` must be an object for `quote`." };
      }
      const payload = req.payload as Record<string, unknown>;
      const network =
        typeof payload["network"] === "string" ? (payload["network"] as string) : null;
      const path =
        network !== null && network.length > 0
          ? `/quote?network=${encodeURIComponent(network)}`
          : "/quote";
      // network lives in the query string upstream, not the body
      const body = { ...payload };
      delete body["network"];
      return { method: "POST", path, body };
    }
    case "build": {
      if (typeof req.payload !== "object" || req.payload === null) {
        return { error: "`payload` must be an object for `build`." };
      }
      const payload = req.payload as Record<string, unknown>;
      const network =
        typeof payload["network"] === "string" ? (payload["network"] as string) : null;
      const path =
        network !== null && network.length > 0
          ? `/quote/build?network=${encodeURIComponent(network)}`
          : "/quote/build";
      const body = { ...payload };
      delete body["network"];
      return { method: "POST", path, body };
    }
    case "send": {
      if (typeof req.payload !== "object" || req.payload === null) {
        return { error: "`payload` must be an object for `send`." };
      }
      const payload = req.payload as Record<string, unknown>;
      const xdr = payload["xdr"];
      if (typeof xdr !== "string" || xdr.length === 0) {
        return { error: "`payload.xdr` must be a non-empty base64 string." };
      }
      const network =
        typeof payload["network"] === "string" ? (payload["network"] as string) : null;
      const path =
        network !== null && network.length > 0
          ? `/send?network=${encodeURIComponent(network)}`
          : "/send";
      return { method: "POST", path, body: { xdr } };
    }
  }
}

// rate-limit, parse op envelope, plan the upstream call, attach Authorization, forward verbatim
export async function POST(request: Request): Promise<Response> {
  const ip = getRemoteIp(request);

  if (!consumeToken(ip)) {
    return jsonResponse(
      { ok: false, code: "RATE_LIMITED", reason: "Too many requests; try again shortly." },
      429,
    );
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonResponse(
      { ok: false, code: "BAD_REQUEST", reason: "Request body is not valid JSON." },
      400,
    );
  }

  const opReq = parseOpRequest(parsed);
  if ("error" in opReq) {
    return jsonResponse({ ok: false, code: "BAD_REQUEST", reason: opReq.error }, 400);
  }

  const plan = planUpstreamCall(opReq);
  if ("error" in plan) {
    return jsonResponse({ ok: false, code: "BAD_REQUEST", reason: plan.error }, 400);
  }

  let baseUrl: string;
  let apiKey: string;
  try {
    baseUrl = getServerEnv().SOROSWAP_API_URL;
    apiKey = requireServerEnv("SOROSWAP_API_KEY");
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        code: "SOROSWAP_NOT_CONFIGURED",
        reason: err instanceof Error ? err.message : "Soroswap is not configured.",
      },
      500,
    );
  }

  // drop a single trailing slash so we get exactly one separator
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const upstreamUrl = `${normalizedBase}${plan.path}`;

  let upstreamResponse: Response;
  try {
    const init: RequestInit = {
      method: plan.method,
      headers: {
        accept: "application/json",
        // Soroswap SDK 0.4.0's HttpClient uses Authorization: Bearer
        authorization: `Bearer ${apiKey}`,
        ...(plan.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(plan.body !== undefined ? { body: JSON.stringify(plan.body) } : {}),
    };
    upstreamResponse = await fetch(upstreamUrl, init);
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Upstream request failed.";
    return jsonResponse(
      {
        ok: false,
        code: "UPSTREAM_UNREACHABLE",
        reason: sanitizeMessage(raw, apiKey),
      },
      502,
    );
  }

  // read body as text first so we can fall back when upstream returns non-JSON (e.g. an HTML error page)
  const rawText = await upstreamResponse.text();
  let parsedBody: unknown;
  try {
    parsedBody = rawText.length === 0 ? null : JSON.parse(rawText);
  } catch {
    parsedBody = { message: rawText };
  }

  if (!upstreamResponse.ok) {
    let message: string;
    if (
      parsedBody !== null &&
      typeof parsedBody === "object" &&
      "message" in (parsedBody as Record<string, unknown>) &&
      typeof (parsedBody as Record<string, unknown>)["message"] === "string"
    ) {
      message = (parsedBody as Record<string, unknown>)["message"] as string;
    } else {
      message = `Soroswap upstream returned ${upstreamResponse.status}.`;
    }
    return jsonResponse(
      {
        ok: false,
        code: "UPSTREAM_ERROR",
        status: upstreamResponse.status,
        reason: sanitizeMessage(message, apiKey),
      },
      upstreamResponse.status,
    );
  }

  return forwardUpstream(upstreamResponse.status, parsedBody);
}

function methodNotAllowed(): Response {
  return jsonResponse(
    { ok: false, code: "METHOD_NOT_ALLOWED", reason: "Only POST is supported." },
    405,
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
