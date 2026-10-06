// helpers shared by the two SoroswapRouter call builders (lp.ts, swap.ts)

import { Asset } from "@stellar/stellar-sdk";

import { getAllowlistForNetwork, type AllowedContract } from "@/lib/config/contracts";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AssetIdentifier } from "@/lib/types/account";

// look up the SoroswapRouter contract id from the network's allow-list
export function getSoroswapRouterId(network: NetworkConfig): string {
  const entry = getAllowlistForNetwork(network).find(
    (c: AllowedContract) => c.protocol === "soroswap" && c.name === "SoroswapRouter",
  );
  if (!entry) {
    throw new Error(`SoroswapRouter not found in the ${network.id} allow-list`);
  }
  return entry.id;
}

// the soroban contract id of an asset the router can trade. `caller` prefixes
// the error so it names the builder that refused
export function resolveAssetAddress(
  asset: AssetIdentifier,
  network: NetworkConfig,
  caller: string,
): string {
  switch (asset.kind) {
    case "native":
      return Asset.native().contractId(network.passphrase);
    case "credit":
      return new Asset(asset.code, asset.issuer).contractId(network.passphrase);
    case "liquidity_pool_shares":
      throw new TypeError(
        `${caller}: liquidity_pool_shares is not a token; remove liquidity first and use the two underlying assets`,
      );
    case "contract":
      return asset.contractId;
  }
}

// amounts travel as decimal strings so an i128 never passes through a float
export function validateIntegerAmount(caller: string, label: string, v: string): void {
  if (!/^\d+$/.test(v)) {
    throw new TypeError(
      `${caller}: ${label} must be a non-negative decimal-integer string; got "${v}"`,
    );
  }
}

// unix seconds; the router compares it with env.ledger().timestamp()
export function validateDeadline(caller: string, deadline: number): void {
  if (!Number.isFinite(deadline) || !Number.isInteger(deadline) || deadline <= 0) {
    throw new RangeError(`${caller}: deadline must be a positive integer; got ${deadline}`);
  }
  if (deadline > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${caller}: deadline exceeds MAX_SAFE_INTEGER; got ${deadline}`);
  }
}
