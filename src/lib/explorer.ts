// stellar.expert explorer URL helpers, shared across the demo flow, the plan
// status widget, and the resolve/acknowledge cards (so a user can look up any
// address or transaction with one click).

import type { NetworkConfig } from "@/lib/config/networks";

// stellar.expert serves only the public network and testnet, which are also the
// only supported targets; any other id is a configuration error, not a link
function slugFor(network: NetworkConfig): string {
  switch (network.id) {
    case "mainnet":
      return "public";
    case "testnet":
      return "testnet";
    default:
      throw new Error(`stellar.expert has no explorer for network "${String(network.id)}"`);
  }
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
