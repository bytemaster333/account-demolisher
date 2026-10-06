// typed proxy to the soroswap aggregator REST API

import { Resolver } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

import { getSoroswapConfig } from "@/server/server-env";
import { createLimiter, rateLimitByIp } from "@/server/rate-limit";
import { readJsonCapped, MAX_JSON_BODY_BYTES, BodyTooLargeError } from "@/server/read-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// some local DNS resolvers (pi-hole, AdGuard, NextDNS finance-category blocks)
let publicDnsAgent: Agent | null = null;
function getPublicDnsAgent(): Agent {
  if (publicDnsAgent) return publicDnsAgent;
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  publicDnsAgent = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        resolver.resolve4(hostname, (err, addresses) => {
          if (err) return callback(err as NodeJS.ErrnoException, "", 4);
          const usable = (addresses ?? []).filter((a) => a !== "0.0.0.0");
          if (usable.length === 0) {
            return callback(
              new Error(`no usable A record for ${hostname}`) as NodeJS.ErrnoException,
              "",
              4,
            );
          }
          // undici supports both callback shapes; the `all` option flips between them
          if ((options as { all?: boolean })?.all) {
            (
              callback as unknown as (
                err: NodeJS.ErrnoException | null,
                addrs: { address: string; family: 4 }[],
              ) => void
            )(
              null,
              usable.map((a) => ({ address: a, family: 4 })),
            );
            return;
          }
          callback(null, usable[0]!, 4);
        });
      },
    },
  });
  return publicDnsAgent;
}

// 5 requests per 60s per IP, via the shared bounded limiter (TRUSTED_PROXY_HOPS
// aware, evicts idle keys) so a forged-XFF flood can't bypass it or exhaust memory
const limiter = createLimiter(5, 60_000);

export function __resetRateLimiterForTests(): void {
  limiter.reset();
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// an upstream that has not answered (headers and body) by then is abandoned, so a
// slow host cannot pin handler connections for undici's 300s defaults
export const UPSTREAM_TIMEOUT_MS = 15_000;
// quote and build answers are a few KB; anything far past that is not one
export const UPSTREAM_MAX_BODY_BYTES = 1_000_000;

// JSON.parse that keeps every integer exactly. quote/build answers carry stroop
// amounts (amountOut, otherAmountThreshold, rawTrade.amountOutMin / amountInMax,
// platformFee.feeAmount, ...) that the soroswap sdk types as bigint and that can
// exceed 2^53; a plain parse would round them before we re-serialize. any integer
// literal outside the safe range comes back as its exact digit string, whatever
// field it is in. relies on the reviver's source-text argument (node 21+).
// no code in the app calls this proxy any more: the testnet demo, its last
// caller, now swaps through the pinned router. nothing compares a quote with a
// built transaction either, so this keeps the numbers exact but is not a
// slippage guard.
export function parseUpstreamJson(rawText: string): unknown {
  return JSON.parse(rawText, (_key, value: unknown, context?: { source?: string }) => {
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      typeof context?.source === "string" &&
      /^-?\d+$/.test(context.source)
    ) {
      return context.source;
    }
    return value;
  });
}

class UpstreamTooLargeError extends Error {}
class UpstreamTimeoutError extends Error {}

// read the body as a stream and stop past the cap instead of buffering it whole
async function readCappedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > UPSTREAM_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new UpstreamTooLargeError();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

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

// allowed ops: anything else returns 400 so this never becomes an open relay.
// quote and build are what the soroswap client exposes; relaying signed
// transactions (send) or listing protocols would only spend the server's api
// quota for others
type Op = "quote" | "build";

const ALLOWED_OPS: ReadonlySet<Op> = new Set<Op>(["quote", "build"]);

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

// map an op + payload to an upstream HTTP call. minimal shape validation only
function planUpstreamCall(req: OpRequest): UpstreamCall | { error: string } {
  switch (req.op) {
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
  }
}

// local dev servers; never consulted in a production build, where a page on a
// visitor's own localhost could otherwise drive this proxy
const DEV_ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
]);

// same-origin / CSRF control for this unauthenticated proxy. The app's own
// browser client is same-origin and posts to a relative URL, so browsers always
// attach an Origin header on these requests; a cross-origin site trying to drive
// the user's browser into spending our Soroswap API quota is rejected. A request
// with no Origin at all (non-browser caller) is also rejected: the only
// legitimate traffic is the browser client, which always sends one. A determined
// non-browser attacker can still forge the header, but they're bounded by the
// per-IP rate limit; a fully closed control would need request auth this proxy
// intentionally does not have.
function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  try {
    if (new URL(request.url).host === originHost) return true;
  } catch {
    // request.url should always parse; fall through to the allow-list
  }
  return process.env.NODE_ENV !== "production" && DEV_ALLOWED_ORIGINS.has(origin);
}

// rate-limit, parse op envelope, plan the upstream call, attach authorization, forward verbatim
export async function POST(request: Request): Promise<Response> {
  if (!isAllowedOrigin(request)) {
    return jsonResponse(
      { ok: false, code: "FORBIDDEN_ORIGIN", reason: "Cross-origin requests are not accepted." },
      403,
    );
  }

  // answers 429 over the limit, and 500 when the proxy setup cannot name the
  // client (an unidentified request must not share one bucket with the rest)
  const limited = rateLimitByIp(limiter, request);
  if (limited !== null) return limited;

  let parsed: unknown;
  try {
    parsed = await readJsonCapped(request, MAX_JSON_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return jsonResponse(
        { ok: false, code: "BAD_REQUEST", reason: "Request body too large." },
        413,
      );
    }
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

  // only the soroswap variables are read, so a bad value elsewhere (a malformed
  // MEDIATOR_SECRET, say) cannot take this route down with it
  let baseUrl: string;
  let apiKey: string;
  try {
    const config = getSoroswapConfig();
    if (config.apiKey === undefined) throw new Error("SOROSWAP_API_KEY is not set");
    baseUrl = config.apiUrl;
    apiKey = config.apiKey;
  } catch (err) {
    // the detail (which variable failed validation) is for the operator's log,
    // not for whoever sent the request
    console.error("[soroswap] server environment is not usable:", err);
    return jsonResponse(
      { ok: false, code: "SOROSWAP_NOT_CONFIGURED", reason: "Soroswap is not configured." },
      500,
    );
  }

  // drop a single trailing slash so we get exactly one separator
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const upstreamUrl = `${normalizedBase}${plan.path}`;

  let upstreamResponse: Awaited<ReturnType<typeof undiciFetch>>;
  let rawText: string;
  const abort = new AbortController();
  const deadline = setTimeout(
    () => abort.abort(new UpstreamTimeoutError(`no answer within ${UPSTREAM_TIMEOUT_MS} ms`)),
    UPSTREAM_TIMEOUT_MS,
  );
  try {
    // undici fetch with a custom dispatcher that uses public DNS: bypasses
    // local DNS sinkholes that block finance-category domains
    upstreamResponse = await undiciFetch(upstreamUrl, {
      method: plan.method,
      headers: {
        accept: "application/json",
        // soroswap SDK 0.4.0's HttpClient uses authorization: bearer
        authorization: `Bearer ${apiKey}`,
        ...(plan.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(plan.body !== undefined ? { body: JSON.stringify(plan.body) } : {}),
      dispatcher: getPublicDnsAgent(),
      signal: abort.signal,
    });
    // read body as text first so we can fall back when upstream returns non-JSON
    // (e.g. an HTML error page); the abort signal above bounds this read too
    rawText = await readCappedText(upstreamResponse.body as ReadableStream<Uint8Array> | null);
  } catch (err) {
    if (err instanceof UpstreamTooLargeError) {
      return jsonResponse(
        {
          ok: false,
          code: "UPSTREAM_TOO_LARGE",
          reason: `Soroswap upstream answered with more than ${UPSTREAM_MAX_BODY_BYTES} bytes.`,
        },
        502,
      );
    }
    if (err instanceof UpstreamTimeoutError || abort.signal.aborted) {
      return jsonResponse(
        {
          ok: false,
          code: "UPSTREAM_TIMEOUT",
          reason: `Soroswap upstream did not answer within ${UPSTREAM_TIMEOUT_MS} ms.`,
        },
        504,
      );
    }
    const raw = err instanceof Error ? err.message : "Upstream request failed.";
    return jsonResponse(
      {
        ok: false,
        code: "UPSTREAM_UNREACHABLE",
        reason: sanitizeMessage(raw, apiKey),
      },
      502,
    );
  } finally {
    clearTimeout(deadline);
  }

  let parsedBody: unknown;
  try {
    parsedBody = rawText.length === 0 ? null : parseUpstreamJson(rawText);
  } catch {
    parsedBody = { message: rawText };
  }

  if (!upstreamResponse.ok) {
    const pb = parsedBody as Record<string, unknown> | null;
    const readStr = (k: string): string | null =>
      pb !== null && typeof pb[k] === "string" ? (pb[k] as string) : null;
    // upstream uses different shapes per endpoint: `message`, `title`, `detail`, `error`
    const message =
      readStr("message") ??
      readStr("title") ??
      readStr("detail") ??
      readStr("error") ??
      `Soroswap upstream returned ${upstreamResponse.status}.`;
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
