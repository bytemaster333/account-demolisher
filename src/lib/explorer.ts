// stellar.expert explorer URL helpers, shared across the demo flow, the plan
// status widget, and the resolve/acknowledge cards (so a user can look up any
// address or transaction with one click).

import type { NetworkConfig } from "@/lib/config/networks";

function slugFor(network: NetworkConfig): string {
  return network.id === "mainnet" ? "public" : network.id;
}

export function explorerAccountUrl(network: NetworkConfig, publicKey: string): string {
  return `https://stellar.expert/explorer/${slugFor(network)}/account/${publicKey}`;
}

export function explorerTxUrl(network: NetworkConfig, txHash: string): string {
  return `https://stellar.expert/explorer/${slugFor(network)}/tx/${txHash}`;
}

export function explorerContractUrl(network: NetworkConfig, contractId: string): string {
  return `https://stellar.expert/explorer/${slugFor(network)}/contract/${contractId}`;
}
