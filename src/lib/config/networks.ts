// network constants for stellar mainnet/testnet/futurenet

import { Networks } from "@stellar/stellar-sdk";

export type StellarNetwork = "mainnet" | "testnet" | "futurenet";

export interface NetworkConfig {
  readonly id: StellarNetwork;
  readonly horizon: string;
  readonly rpc: string;
  readonly passphrase: string;
  readonly friendbot: string | null;
}

export const MAINNET: NetworkConfig = {
  id: "mainnet",
  horizon: "https://horizon.stellar.org",
  rpc: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  passphrase: Networks.PUBLIC,
  friendbot: null,
};

export const TESTNET: NetworkConfig = {
  id: "testnet",
  horizon: "https://horizon-testnet.stellar.org",
  rpc: "https://soroban-testnet.stellar.org",
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
