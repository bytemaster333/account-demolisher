import { Horizon } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";

// memoized horizon client per server url.
const cache = new Map<string, Horizon.Server>();

export function getHorizon(network: NetworkConfig): Horizon.Server {
  let server = cache.get(network.horizon);
  if (!server) {
    server = new Horizon.Server(network.horizon, { allowHttp: false });
    cache.set(network.horizon, server);
  }
  return server;
}

// test-only: clear the cached clients.
export function _resetHorizonCacheForTests(): void {
  cache.clear();
}
