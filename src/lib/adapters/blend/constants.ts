// blend constants pinned outside the SDK
import { BLEND_MAINNET_INFRASTRUCTURE } from "./pools";

// v2 backstop withdrawal queue duration in seconds (17 days)
export const BACKSTOP_QUEUE_DURATION_SECONDS: number = 17 * 24 * 60 * 60;

// mainnet v2 backstop contract id, resolved from the infrastructure registry at module load
function resolveBackstopMainnetId(): string {
  const entry = BLEND_MAINNET_INFRASTRUCTURE.find((e) => e.name === "backstopV2");
  if (!entry) {
    throw new Error(
      "blend/constants: BLEND_MAINNET_INFRASTRUCTURE missing 'backstopV2' entry. " +
        "Re-snapshot upstream mainnet.contracts.json before proceeding.",
    );
  }
  return entry.id;
}

export const BLEND_BACKSTOP_MAINNET_ID: string = resolveBackstopMainnetId();

// i128 max — used as the "drain all" sentinel for repay/withdraw
export const I128_MAX: bigint = (1n << 127n) - 1n;

// five-minute soroban tx timeout
export const MAX_TIMEOUT_SECONDS: number = 300;
