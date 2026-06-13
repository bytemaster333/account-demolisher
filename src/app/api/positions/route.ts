// typed proxy to orion / OctoPos position APIs

import { getServerEnv } from "@/server/server-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

// strip the API key out of a string in case an upstream echoes it back
function sanitizeMessage(message: string, apiKey: string): string {
  if (apiKey.length === 0) return message;
  return message.split(apiKey).join("[redacted]");
}

type Provider = "orion" | "octopos";
type Op = "health" | "getPositions";

const ALLOWED_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(["orion", "octopos"]);
const ALLOWED_OPS: ReadonlySet<Op> = new Set<Op>(["health", "getPositions"]);

interface ParsedRequest {
  provider: Provider;
  op: Op;
  userAddress?: string;
  network?: string;
}

function parseBody(raw: unknown): ParsedRequest | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: "Request body must be a JSON object." };
  }
  const obj = raw as Record<string, unknown>;

  const provider = obj["provider"];
  if (typeof provider !== "string" || !ALLOWED_PROVIDERS.has(provider as Provider)) {
    return {
      error: `\`provider\` must be one of: ${[...ALLOWED_PROVIDERS].join(", ")}.`,
    };
  }

  const op = obj["op"];
  if (typeof op !== "string" || !ALLOWED_OPS.has(op as Op)) {
    return {
      error: `\`op\` must be one of: ${[...ALLOWED_OPS].join(", ")}.`,
    };
  }

  if ((op as Op) === "getPositions") {
    const userAddress = obj["userAddress"];
    if (typeof userAddress !== "string" || userAddress.length === 0) {
      return { error: "`userAddress` must be a non-empty string." };
    }
    const network = obj["network"];
    if (network !== undefined && typeof network !== "string") {
      return { error: "`network` must be a string when provided." };
    }
    return {
      provider: provider as Provider,
      op: op as Op,
      userAddress,
      ...(typeof network === "string" ? { network } : {}),
    };
  }

  return { provider: provider as Provider, op: op as Op };
}

interface ProviderConfig {
  url: string;
  apiKey: string;
}

// returns null when URL or key is unset — treated as "provider unavailable",
// not a 5xx, so the orchestrator can fall over cleanly
function getProviderConfig(provider: Provider): ProviderConfig | null {
  const env = getServerEnv();
  if (provider === "orion") {
    if (
      env.ORION_API_URL === undefined ||
      env.ORION_API_URL.length === 0 ||
      env.ORION_API_KEY === undefined ||
      env.ORION_API_KEY.length === 0
    ) {
      return null;
    }
    return { url: env.ORION_API_URL, apiKey: env.ORION_API_KEY };
  }
  // octopos
  if (
    env.OCTOPOS_API_URL === undefined ||
    env.OCTOPOS_API_URL.length === 0 ||
    env.OCTOPOS_API_KEY === undefined ||
    env.OCTOPOS_API_KEY.length === 0
  ) {
    return null;
  }
  return { url: env.OCTOPOS_API_URL, apiKey: env.OCTOPOS_API_KEY };
}

// drop a single trailing slash
function normalizeBase(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// health op — returns { available: bool } and never throws
async function handleHealth(provider: Provider): Promise<Response> {
  const cfg = getProviderConfig(provider);
  if (cfg === null) {
    return jsonResponse(
      { available: false, reason: `${provider} is not configured (URL or API key missing).` },
      200,
    );
  }
  const base = normalizeBase(cfg.url);
  const healthUrl = `${base}/health`;
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
    });
    if (response.ok) {
      return jsonResponse({ available: true }, 200);
    }
    return jsonResponse(
      {
        available: false,
        reason: `upstream returned ${response.status} on /health`,
      },
      200,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : "upstream unreachable";
    return jsonResponse({ available: false, reason: sanitizeMessage(reason, cfg.apiKey) }, 200);
  }
}

// getPositions op — forwards to ${url}/positions?address=... and echoes the upstream body
async function handleGetPositions(
  provider: Provider,
  userAddress: string,
  network: string | undefined,
): Promise<Response> {
  const cfg = getProviderConfig(provider);
  if (cfg === null) {
    return jsonResponse(
      {
        ok: false,
        code: "PROVIDER_NOT_CONFIGURED",
        reason: `${provider} is not configured (URL or API key missing).`,
      },
      503,
    );
  }
  const base = normalizeBase(cfg.url);
  const params = new URLSearchParams();
  params.set("address", userAddress);
  if (network !== undefined && network.length > 0) {
    params.set("network", network);
  }
  const upstreamUrl = `${base}/positions?${params.toString()}`;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Upstream request failed.";
    return jsonResponse(
      {
        ok: false,
        code: "UPSTREAM_UNREACHABLE",
        reason: sanitizeMessage(raw, cfg.apiKey),
      },
      502,
    );
  }

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
      message = `${provider} upstream returned ${upstreamResponse.status}.`;
    }
    return jsonResponse(
      {
        ok: false,
        code: "UPSTREAM_ERROR",
        status: upstreamResponse.status,
        reason: sanitizeMessage(message, cfg.apiKey),
      },
      upstreamResponse.status,
    );
  }

  // only content-type on the response — never echo upstream auth headers
  return new Response(JSON.stringify(parsedBody), {
    status: upstreamResponse.status,
    headers: { "content-type": "application/json" },
  });
}

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

  const req = parseBody(parsed);
  if ("error" in req) {
    return jsonResponse({ ok: false, code: "BAD_REQUEST", reason: req.error }, 400);
  }

  if (req.op === "health") {
    return handleHealth(req.provider);
  }

  if (req.userAddress === undefined) {
    // parseBody guarantees this is set for getPositions
    return jsonResponse(
      { ok: false, code: "BAD_REQUEST", reason: "`userAddress` is required." },
      400,
    );
  }
  return handleGetPositions(req.provider, req.userAddress, req.network);
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
