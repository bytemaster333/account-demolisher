import { rpc } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";

// memoized soroban rpc client per primary rpc url. The client fails over across
// the network's vetted endpoints when the current one rate-limits or faults, so
// heavy discovery (Soroswap pair walks, allowance event scans, per-pool Blend
// loads) doesn't dead-end on a single overloaded public RPC.
const cache = new Map<string, rpc.Server>();

export function getRpc(network: NetworkConfig): rpc.Server {
  let server = cache.get(network.rpc);
  if (!server) {
    const urls = [network.rpc, ...(network.rpcFallbacks ?? [])];
    server = buildFailoverServer(urls.map((u) => new rpc.Server(u, { allowHttp: false })));
    cache.set(network.rpc, server);
  }
  return server;
}

// Which THROWN errors justify switching endpoints. Only transport-level faults
// are host-specific and worth retrying elsewhere: rate limits (429), upstream
// 5xx, and network/timeout errors. A deterministic 4xx (bad request) or a normal
// JSON-RPC error *response* (which the sdk returns, not throws) is the same on
// every host, so failing over just multiplies load — those propagate unchanged.
export function isFailoverError(err: unknown): boolean {
  const status = extractHttpStatus(err);
  if (status !== null) {
    return status === 429 || (status >= 500 && status < 600);
  }
  // No HTTP status => transport/network error (fetch failed, reset, timeout).
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("failed to fetch") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up")
  );
}

function extractHttpStatus(err: unknown): number | null {
  const e = err as { response?: { status?: unknown }; status?: unknown; statusCode?: unknown };
  for (const candidate of [e?.response?.status, e?.status, e?.statusCode]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

// Wraps an ordered list of rpc.Server instances so every method call tries the
// current host and, on a failover-worthy error, advances to the next host and
// retries the identical call. Sticky: once a host works we stay on it, shedding
// load off the faulted one until IT faults too. A single server is returned as-is
// (no proxy overhead). Submit calls are safe to retry: Soroban dedups by tx hash,
// so a re-send of the identical signed envelope returns DUPLICATE rather than
// double-applying.
export function buildFailoverServer(servers: readonly rpc.Server[]): rpc.Server {
  if (servers.length === 0) {
    throw new Error("buildFailoverServer: at least one server is required");
  }
  if (servers.length === 1) return servers[0]!;

  // sticky index into `servers`; mutated as hosts fault and recover
  let current = 0;

  const invoke = async (method: string | symbol, args: unknown[]): Promise<unknown> => {
    let lastErr: unknown;
    for (let hop = 0; hop < servers.length; hop++) {
      const idx = (current + hop) % servers.length;
      const server = servers[idx]!;
      const fn = (server as unknown as Record<string | symbol, unknown>)[method];
      if (typeof fn !== "function") {
        throw new TypeError(`rpc failover: '${String(method)}' is not a method on the rpc server`);
      }
      try {
        const result = await (fn as (...a: unknown[]) => Promise<unknown>).apply(server, args);
        current = idx; // stick to the host that just succeeded
        return result;
      } catch (err) {
        lastErr = err;
        // last host, or a non-transport error: nothing better to try, propagate
        if (hop === servers.length - 1 || !isFailoverError(err)) throw err;
      }
    }
    throw lastErr;
  };

  // Route method calls through invoke(); read non-function properties straight
  // from the primary (they're informational, e.g. serverURL). Method lookup uses
  // Reflect so prototype methods resolve.
  return new Proxy(servers[0]!, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => invoke(prop, args);
      }
      return value;
    },
  }) as rpc.Server;
}
