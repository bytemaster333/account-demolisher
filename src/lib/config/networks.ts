// network constants for stellar mainnet and testnet, the only supported targets

import { Networks } from "@stellar/stellar-sdk";

export type StellarNetwork = "mainnet" | "testnet";

export interface NetworkConfig {
  readonly id: StellarNetwork;
  readonly horizon: string;
  // primary Soroban RPC endpoint
  readonly rpc: string;
  // additional CORS-enabled RPC endpoints, in preference order, that getRpc()
  // fails over to when the primary rate-limits or faults. each was verified to
  // (a) reflect a CORS header for browser use and (b) track the same ledger as
  // the primary, so a failover doesn't read a stale chain state. omitted where
  // no second endpoint is vetted.
  readonly rpcFallbacks?: readonly string[];
  readonly passphrase: string;
  readonly friendbot: string | null;
}

export const MAINNET: NetworkConfig = {
  id: "mainnet",
  horizon: "https://horizon.stellar.org",
  rpc: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  rpcFallbacks: ["https://mainnet.sorobanrpc.com", "https://stellar.api.onfinality.io/public"],
  passphrase: Networks.PUBLIC,
  friendbot: null,
};

export const TESTNET: NetworkConfig = {
  id: "testnet",
  horizon: "https://horizon-testnet.stellar.org",
  rpc: "https://soroban-testnet.stellar.org",
  rpcFallbacks: ["https://soroban-rpc.testnet.stellar.gateway.fm"],
  passphrase: Networks.TESTNET,
  friendbot: "https://friendbot.stellar.org",
};

export const NETWORKS: Readonly<Record<StellarNetwork, NetworkConfig>> = {
  mainnet: MAINNET,
  testnet: TESTNET,
};

// the network for a known id, or null. never guesses: a persisted record or a
// request naming a network we do not know must be rejected by the caller, not
// silently resumed or signed on another network.
export function parseNetworkId(id: string | null | undefined): NetworkConfig | null {
  if (id === "mainnet" || id === "testnet") return NETWORKS[id];
  return null;
}

export function requireNetwork(id: string | null | undefined): NetworkConfig {
  const network = parseNetworkId(id);
  if (network === null) throw new Error(`unknown Stellar network id "${String(id)}"`);
  return network;
}

// the default branch of a switch over network.id. the type system rules it out;
// at run time it can only be reached through an unchecked cast or stale data,
// which must fail rather than fall through to undefined
export function unsupportedNetwork(id: never): never {
  throw new Error(`unsupported Stellar network id "${String(id)}"`);
}

// lenient: an unknown id (a dropped "futurenet" among them) becomes testnet.
// kept only until its remaining callers, which live in other modules, move to
// parseNetworkId / requireNetwork; signing-relay's createPlan still relies on
// the fallback to answer BAD_NETWORK. new code must not use it.
/** @deprecated use parseNetworkId or requireNetwork */
export function resolveNetwork(id: string | undefined): NetworkConfig {
  return parseNetworkId(id) ?? TESTNET;
}
