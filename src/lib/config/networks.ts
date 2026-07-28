// network constants for stellar mainnet/testnet/futurenet

import { Networks } from "@stellar/stellar-sdk";

export type StellarNetwork = "mainnet" | "testnet" | "futurenet";

export interface NetworkConfig {
  readonly id: StellarNetwork;
  readonly horizon: string;
  // primary Soroban RPC endpoint
  readonly rpc: string;
  // additional CORS-enabled RPC endpoints, in preference order, that getRpc()
  // fails over to when the primary rate-limits or faults. Each was verified to
  // (a) reflect a CORS header for browser use and (b) track the same ledger as
  // the primary, so a failover doesn't read a stale chain state. Omitted where
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

export const FUTURENET: NetworkConfig = {
  id: "futurenet",
  horizon: "https://horizon-futurenet.stellar.org",
  rpc: "https://rpc-futurenet.stellar.org",
  passphrase: Networks.FUTURENET,
  friendbot: "https://friendbot-futurenet.stellar.org",
};

export const NETWORKS: Record<StellarNetwork, NetworkConfig> = {
  mainnet: MAINNET,
  testnet: TESTNET,
  futurenet: FUTURENET,
};

export function resolveNetwork(id: string | undefined): NetworkConfig {
  if (id === "mainnet" || id === "testnet" || id === "futurenet") {
    return NETWORKS[id];
  }
  return TESTNET;
}
