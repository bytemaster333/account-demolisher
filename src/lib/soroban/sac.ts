// helpers for stellar asset contracts (sacs) vs classical assets.

import { Asset } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";

// derive the sac contract address for a classical asset on the given network.
export function getSACContractId(asset: Asset, network: NetworkConfig): string {
  return asset.contractId(network.passphrase);
}

// returns the matching asset if contractId is the sac for any of them, else null.
export function isSACContract(
  contractId: string,
  knownAssets: readonly Asset[],
  network: NetworkConfig,
): Asset | null {
  for (const asset of knownAssets) {
    if (getSACContractId(asset, network) === contractId) {
      return asset;
    }
  }
  return null;
}
