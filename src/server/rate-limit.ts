// Shared per-IP token-bucket rate limiter for API routes. In-process, like the
// relay store: correct for a single instance, per-instance under fan-out. The
// bucket map is bounded so a rotating-key flood can't exhaust memory.

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface Limiter {
  take(ip: string, now?: number): boolean;
  reset(): void;
}

// hard cap on distinct keys held at once. A bucket idle for a full window has
// refilled to capacity, so it is indistinguishable from a fresh one and safe to
// evict; we sweep those before admitting a new key past the cap.
const MAX_BUCKETS = 20_000;

export function createLimiter(capacity: number, windowMs: number): Limiter {
  const buckets = new Map<string, Bucket>();

  const sweepRefilled = (now: number): void => {
    for (const [key, b] of buckets) {
      if (now - b.lastRefill >= windowMs) buckets.delete(key);
    }
  };

  return {
    take(ip: string, now: number = Date.now()): boolean {
      const existing = buckets.get(ip);
      if (existing === undefined) {
        if (buckets.size >= MAX_BUCKETS) {
          sweepRefilled(now);
          // still full of active keys: drop the request rather than grow the map
          if (buckets.size >= MAX_BUCKETS) return false;
        }
        buckets.set(ip, { tokens: capacity - 1, lastRefill: now });
        return true;
      }
      const elapsed = now - existing.lastRefill;
      if (elapsed > 0) {
        existing.tokens = Math.min(capacity, existing.tokens + (elapsed / windowMs) * capacity);
        existing.lastRefill = now;
      }
      if (existing.tokens >= 1) {
        existing.tokens -= 1;
        return true;
      }
      return false;
    },
    reset(): void {
      buckets.clear();
    },
  };
}

// how many reverse-proxy hops append to X-Forwarded-For in front of the app. The
// real client is the (len - hops)-th entry; a client can forge everything to the
// LEFT of the hops the trusted proxies added, so we never trust the raw rightmost
// value blindly. Default 1 (a single trusted proxy, e.g. Caddy). Set to 0 when
// the app is reached directly, so XFF is ignored entirely.
function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

// Resolve the client IP. With N trusted proxy hops the real peer is the entry N
// from the right of X-Forwarded-For; with 0 hops XFF is untrusted and ignored.
export function getRemoteIp(request: Request): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const xff = request.headers.get("x-forwarded-for");
    if (xff !== null && xff.length > 0) {
      const parts = xff
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const idx = parts.length - hops;
      const picked = idx >= 0 ? parts[idx] : parts[0];
      if (picked !== undefined && picked.length > 0) return picked;
    }
    const xRealIp = request.headers.get("x-real-ip");
    if (xRealIp !== null && xRealIp.length > 0) return xRealIp;
  }
  try {
    return new URL(request.url).host || "unknown";
  } catch {
    return "unknown";
  }
}
