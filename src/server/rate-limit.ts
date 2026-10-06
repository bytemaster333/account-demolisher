// shared per-client token-bucket rate limiter for the API routes. in-process,
// like the relay store: correct for a single instance, per instance under
// fan-out. the bucket map is bounded and evicts the least recently used key, so
// a rotating-key flood can neither exhaust memory nor lock out new clients.
//
// the app only runs behind a reverse proxy (TRUSTED_PROXY_HOPS >= 1). a route
// handler's Request carries no peer address, so the client is read from the
// X-Forwarded-For entry the trusted proxy appended. when that can't be done the
// limited routes fail with a logged configuration error; they never fall back to
// a shared key like the Host header, which would put every client in one bucket.

import { isIP } from "node:net";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface Limiter {
  take(key: string, now?: number): boolean;
  // ms until the key has a whole token again; 0 when it has one now
  retryAfterMs(key: string, now?: number): number;
  size(): number;
  reset(): void;
}

// hard cap on distinct keys held at once
const MAX_BUCKETS = 20_000;

export function createLimiter(
  capacity: number,
  windowMs: number,
  maxKeys: number = MAX_BUCKETS,
): Limiter {
  // Map iteration follows insertion order; every access re-inserts its key, so
  // the first key is always the least recently used one
  const buckets = new Map<string, Bucket>();

  const refill = (b: Bucket, now: number): void => {
    const elapsed = now - b.lastRefill;
    if (elapsed > 0) {
      b.tokens = Math.min(capacity, b.tokens + (elapsed / windowMs) * capacity);
      b.lastRefill = now;
    }
  };

  return {
    take(key: string, now: number = Date.now()): boolean {
      const existing = buckets.get(key);
      if (existing === undefined) {
        if (buckets.size >= maxKeys) {
          const oldest = buckets.keys().next();
          if (!oldest.done) buckets.delete(oldest.value);
        }
        buckets.set(key, { tokens: capacity - 1, lastRefill: now });
        return true;
      }
      buckets.delete(key);
      buckets.set(key, existing);
      refill(existing, now);
      if (existing.tokens >= 1) {
        existing.tokens -= 1;
        return true;
      }
      return false;
    },
    retryAfterMs(key: string, now: number = Date.now()): number {
      const b = buckets.get(key);
      if (b === undefined) return 0;
      const elapsed = Math.max(0, now - b.lastRefill);
      const tokens = Math.min(capacity, b.tokens + (elapsed / windowMs) * capacity);
      if (tokens >= 1) return 0;
      return Math.ceil(((1 - tokens) * windowMs) / capacity);
    },
    size(): number {
      return buckets.size;
    },
    reset(): void {
      buckets.clear();
    },
  };
}

export class ClientIpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientIpUnavailableError";
  }
}

// how many reverse-proxy hops append to X-Forwarded-For in front of the app. the
// real client is the entry that many places from the right; everything to its
// left is client-controlled. unset means the single proxy compose ships with.
function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 1;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ClientIpUnavailableError(
      `TRUSTED_PROXY_HOPS must be a whole number of at least 1, got "${raw}".`,
    );
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (n < 1) {
    throw new ClientIpUnavailableError(
      "TRUSTED_PROXY_HOPS is 0, but the app only runs behind a reverse proxy that sets " +
        "X-Forwarded-For. Set it to the number of trusted proxies in front of the app (at least 1).",
    );
  }
  return n;
}

// call at server start so a bad proxy setting stops the process instead of
// failing every rate-limited request later
export function assertTrustedProxyConfig(): void {
  trustedProxyHops();
}

// expand an IPv6 address (already validated by isIP) into its 8 16-bit groups
function ipv6Groups(addr: string): number[] {
  let text = addr;
  const tail: number[] = [];
  // an embedded IPv4 tail (::ffff:1.2.3.4) fills the last two groups
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const o = last.split(".").map((p) => Number.parseInt(p, 10));
    tail.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
    text = text.slice(0, lastColon + 1) + "0";
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const parse = (s: string): number[] =>
    s.length === 0 ? [] : s.split(":").map((g) => Number.parseInt(g, 16));
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  if (tail.length > 0) {
    // drop the placeholder group that stood in for the IPv4 tail
    if (right.length > 0) right.pop();
    else left.pop();
  }
  const fill = 8 - tail.length - left.length - right.length;
  return [...left, ...new Array<number>(Math.max(0, fill)).fill(0), ...right, ...tail];
}

// the rate-limit key for one client address: the full IPv4 address, or the /64
// prefix for IPv6 (one host usually controls a whole /64). null when the value
// is not an IP address.
export function canonicalClientKey(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end < 0) return null;
    s = s.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
    s = s.slice(0, s.lastIndexOf(":"));
  }
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);

  const family = isIP(s);
  if (family === 4) return s;
  if (family !== 6) return null;

  const g = ipv6Groups(s.toLowerCase());
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (mapped) {
    return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

// the rate-limit key for the client behind the trusted proxies. throws
// ClientIpUnavailableError when the deployment can't identify the client.
export function getRemoteIp(request: Request): string {
  const hops = trustedProxyHops();
  const xff = request.headers.get("x-forwarded-for");
  const parts = (xff ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const idx = parts.length - hops;
  if (idx < 0) {
    throw new ClientIpUnavailableError(
      `X-Forwarded-For has ${parts.length} entr${parts.length === 1 ? "y" : "ies"} but ` +
        `TRUSTED_PROXY_HOPS is ${hops}; the request did not come through the configured proxies.`,
    );
  }
  const key = canonicalClientKey(parts[idx]!);
  if (key === null) {
    throw new ClientIpUnavailableError(
      "The trusted X-Forwarded-For entry is not an IP address; check TRUSTED_PROXY_HOPS and the proxy config.",
    );
  }
  return key;
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  extra?: HeadersInit,
): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

// take one token for the calling client. returns null when the request may
// proceed, or the response to send: 429 with Retry-After, or 500 when the
// proxy setup can't identify the client (logged, never a shared bucket).
export function rateLimitByIp(limiter: Limiter, request: Request): Response | null {
  let key: string;
  try {
    key = getRemoteIp(request);
  } catch (e) {
    if (!(e instanceof ClientIpUnavailableError)) throw e;
    console.error(`rate limit: ${e.message}`);
    return jsonResponse(
      {
        ok: false,
        code: "PROXY_MISCONFIGURED",
        reason: "The server can't identify clients behind its proxy. This is a deployment error.",
      },
      500,
    );
  }
  return rateLimitByKey(limiter, key);
}

// same as rateLimitByIp for a caller-chosen key (for example an authenticated
// flow id), so routes can limit per flow instead of per address
export function rateLimitByKey(limiter: Limiter, key: string): Response | null {
  const now = Date.now();
  if (limiter.take(key, now)) return null;
  const seconds = Math.max(1, Math.ceil(limiter.retryAfterMs(key, now) / 1000));
  return jsonResponse({ ok: false, code: "RATE_LIMITED", reason: "Too many requests." }, 429, {
    "retry-after": String(seconds),
  });
}
