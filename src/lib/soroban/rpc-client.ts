import { rpc } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";

// memoized soroban rpc client per rpc url.
const cache = new Map<string, rpc.Server>();

export function getRpc(network: NetworkConfig): rpc.Server {
  let server = cache.get(network.rpc);
  if (!server) {
    server = new rpc.Server(network.rpc, { allowHttp: false });
    cache.set(network.rpc, server);
  }
  return server;
}

// test-only: clear the cached clients.
export function _resetRpcCacheForTests(): void {
  cache.clear();
}
