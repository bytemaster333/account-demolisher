// blend constants pinned outside the SDK
import type { NetworkConfig } from "@/lib/config/networks";
import {
  BLEND_MAINNET_INFRASTRUCTURE,
  BLEND_TESTNET_INFRASTRUCTURE,
  type BlendInfrastructureEntry,
} from "./pools";

// v2 backstop withdrawal queue duration in seconds (17 days)
export const BACKSTOP_QUEUE_DURATION_SECONDS: number = 17 * 24 * 60 * 60;

// the v2 backstop contract id from an infrastructure registry, resolved at module
// load so a missing snapshot fails fast rather than at first backstop read.
function resolveBackstopFrom(
  infra: readonly BlendInfrastructureEntry[],
  networkLabel: string,
): string {
  const entry = infra.find((e) => e.name === "backstopV2");
  if (!entry) {
    throw new Error(
      `blend/constants: BLEND_${networkLabel}_INFRASTRUCTURE missing 'backstopV2' entry. ` +
        `Re-snapshot upstream ${networkLabel.toLowerCase()}.contracts.json before proceeding.`,
    );
  }
  return entry.id;
}

export const BLEND_BACKSTOP_MAINNET_ID: string = resolveBackstopFrom(
  BLEND_MAINNET_INFRASTRUCTURE,
  "MAINNET",
);
export const BLEND_BACKSTOP_TESTNET_ID: string = resolveBackstopFrom(
  BLEND_TESTNET_INFRASTRUCTURE,
  "TESTNET",
);

// Backstop contract id for a network, or null when none is deployed/snapshotted.
// Mainnet and testnet both have a pinned v2 backstop; futurenet has none, so it
// returns null and callers skip backstop handling instead of pointing at a
// foreign-network contract.
export function resolveBackstopId(network: NetworkConfig): string | null {
  switch (network.id) {
    case "mainnet":
      return BLEND_BACKSTOP_MAINNET_ID;
    case "testnet":
      return BLEND_BACKSTOP_TESTNET_ID;
    default:
      return null;
  }
}

// i128 max, used as the "drain all" sentinel for repay/withdraw
export const I128_MAX: bigint = (1n << 127n) - 1n;

// five-minute soroban tx timeout
export const MAX_TIMEOUT_SECONDS: number = 300;
