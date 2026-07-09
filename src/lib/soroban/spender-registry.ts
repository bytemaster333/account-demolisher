// curated registry of well-known soroban spender contract ids, used to label a
// spender as a recognized protocol instead of an unrecognized address.
//
// this is network-aware: the curated allow-list differs per network (a contract
// id well-known on mainnet is a different, unrelated contract on testnet), so a
// lookup MUST be scoped to the network the allowance was read on. Keying only on
// the mainnet list — as this module used to — mislabels every testnet spender as
// "unknown", which is the app's default network.

import { getAllowlistForNetwork } from "@/lib/config/contracts";
import type { NetworkConfig, StellarNetwork } from "@/lib/config/networks";

export interface SpenderInfo {
  readonly name: string;
  readonly protocol: string;
}

// one id -> info map per network, built lazily on first lookup for that network
// and memoized. mirrors the old "built once at module load" property without
// hardcoding a single network.
const registries = new Map<StellarNetwork, ReadonlyMap<string, SpenderInfo>>();

function registryFor(network: NetworkConfig): ReadonlyMap<string, SpenderInfo> {
  const cached = registries.get(network.id);
  if (cached !== undefined) return cached;
  const built = new Map<string, SpenderInfo>(
    getAllowlistForNetwork(network).map((c) => [c.id, { name: c.name, protocol: c.protocol }]),
  );
  registries.set(network.id, built);
  return built;
}

// returns the registry entry for the given network, or null if the contract is
// not curated on that network
export function lookupSpender(contractId: string, network: NetworkConfig): SpenderInfo | null {
  return registryFor(network).get(contractId) ?? null;
}
