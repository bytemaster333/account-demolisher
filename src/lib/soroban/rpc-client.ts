import { rpc, type FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";

import { parseRetentionFloor } from "./event-retention";

// memoized soroban rpc client per primary rpc url. the client fails over across
// the network's vetted endpoints when the current one rate-limits or faults, so
// heavy discovery (Soroswap pair walks, allowance event scans, per-pool Blend
// loads) doesn't dead-end on a single overloaded public RPC.
const cache = new Map<string, rpc.Server>();

// per http request: a request on a half-open connection would otherwise never
// settle, never fail over, and hold whatever waits on it (the revoke gate, the
// merge-time reprobe) open until a reload
export const RPC_REQUEST_TIMEOUT_MS = 20_000;

export function getRpc(network: NetworkConfig): rpc.Server {
  let server = cache.get(network.rpc);
  if (!server) {
    const urls = [network.rpc, ...(network.rpcFallbacks ?? [])];
    server = buildFailoverServer(urls.map((u) => createRpcServer(u)));
    cache.set(network.rpc, server);
  }
  return server;
}

// rpc.Server ignores a timeout constructor option (it only forwards headers to
// its http client), so the deadline goes on the client's defaults, which every
// request merges in; the sdk documents mutating httpClient.defaults this way
export function createRpcServer(
  url: string,
  opts: { readonly timeoutMs?: number; readonly allowHttp?: boolean } = {},
): rpc.Server {
  const server = new rpc.Server(url, { allowHttp: opts.allowHttp ?? false });
  server.httpClient.defaults.timeout = opts.timeoutMs ?? RPC_REQUEST_TIMEOUT_MS;
  return server;
}

// stellar-rpc's json-rpc code for "request exceeded processing limit threshold":
// a per-host load limit, so another host may still serve the request
const JSONRPC_PROCESSING_LIMIT = -32001;

// which thrown errors justify switching endpoints. only host-specific faults are
// worth retrying elsewhere: rate limits (429), upstream 5xx, the processing-limit
// throttle, network/timeout errors, and a getEvents range below what this host
// holds (hosts keep different history; see scanStartFromHealth). a deterministic
// 4xx or json-rpc error is the same on every host, so failing over just
// multiplies load. the sdk throws a json-rpc error as the plain {code, message}
// object from the response body, and an http failure as an axios-style error
// carrying response.status.
export function isFailoverError(err: unknown): boolean {
  if (parseRetentionFloor(err) !== null) return true;
  const status = extractHttpStatus(err);
  if (status !== null) {
    return status === 429 || (status >= 500 && status < 600);
  }
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "number") return code === JSONRPC_PROCESSING_LIMIT;
  // no status, no json-rpc code: a transport error. only named transport
  // conditions count; a bare number inside a message is not an http status
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
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

// true for the rpc's "request exceeded processing limit threshold" answer: the
// request was too expensive for this host, so a narrower request may still pass
export function isProcessingLimitError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === JSONRPC_PROCESSING_LIMIT;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const m = (err as { message?: unknown } | null | undefined)?.message;
  return typeof m === "string" ? m : String(err);
}

// the sdk http clients' own wording for a non-2xx answer. an error rethrown as a
// plain Error somewhere along the way keeps only this message, so the status is
// read from it too, but only when the whole message is exactly that phrase
const HTTP_STATUS_MESSAGE = /^Request failed with status code (\d{3})$/;

function extractHttpStatus(err: unknown): number | null {
  const e = err as { response?: { status?: unknown }; status?: unknown; statusCode?: unknown };
  for (const candidate of [e?.response?.status, e?.status, e?.statusCode]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  const m = HTTP_STATUS_MESSAGE.exec(errorMessage(err));
  return m ? Number(m[1]) : null;
}

function isBadSeq(res: rpc.Api.SendTransactionResponse): boolean {
  return res.status === "ERROR" && res.errorResult?.result.type === "txBadSeq";
}

// wraps an ordered list of rpc.Server instances so every method call tries the
// current host and, on a failover-worthy error, advances to the next host and
// retries the identical call. sticky: once a host works we stay on it, shedding
// load off the faulted one until it faults too. a single server is returned as-is
// (no proxy overhead).
//
// sendTransaction is the one call where a retry is not idempotent from the
// caller's view: Soroban dedups a re-sent envelope (DUPLICATE) only while it is
// still pending on the receiving node. if host A's core accepted the tx and the
// gateway then failed, host B answers txBadSeq once the tx has applied. so after a
// failed-over send that comes back txBadSeq, the hash is looked up on every host,
// and a tx any host knows is reported as DUPLICATE for the caller to poll.
export function buildFailoverServer(servers: readonly rpc.Server[]): rpc.Server {
  if (servers.length === 0) {
    throw new Error("buildFailoverServer: at least one server is required");
  }
  if (servers.length === 1) return servers[0]!;

  // sticky index into `servers`; mutated as hosts fault and recover
  let current = 0;

  const invoke = async (
    method: string | symbol,
    args: unknown[],
  ): Promise<{ result: unknown; failedOver: boolean }> => {
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
        return { result, failedOver: hop > 0 };
      } catch (err) {
        lastErr = err;
        // last host, or a non-transport error: nothing better to try, propagate
        if (hop === servers.length - 1 || !isFailoverError(err)) throw err;
      }
    }
    throw lastErr;
  };

  const sendTransaction = async (
    tx: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.SendTransactionResponse> => {
    const { result, failedOver } = await invoke("sendTransaction", [tx]);
    const res = result as rpc.Api.SendTransactionResponse;
    if (!failedOver || !isBadSeq(res)) return res;
    const hash = Buffer.from(tx.hash()).toString("hex");
    for (const server of servers) {
      try {
        const found = await server.getTransaction(hash);
        if (found.status !== "NOT_FOUND") return { ...res, status: "DUPLICATE", hash };
      } catch {
        // an unreachable host cannot vouch for the tx; ask the next one
      }
    }
    return res;
  };

  // route method calls through invoke(); read non-function properties straight
  // from the primary (they're informational, e.g. serverURL). method lookup uses
  // Reflect so prototype methods resolve.
  return new Proxy(servers[0]!, {
    get(target, prop, receiver) {
      if (prop === "sendTransaction") return sendTransaction;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (...args: unknown[]) => invoke(prop, args).then((r) => r.result);
      }
      return value;
    },
  }) as rpc.Server;
}
