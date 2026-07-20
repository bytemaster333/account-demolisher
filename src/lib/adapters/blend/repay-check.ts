import { Asset } from "@stellar/stellar-sdk";

import type { BlendPositionSummary } from "@/lib/adapters/positions/interface";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";

// Blend requires the BORROWED token on hand to repay a loan; there is no
// automatic swap. Closing the account must first repay every Blend liability in
// full (the repay drains the whole debt with i128::MAX), so if this account no
// longer holds enough of a borrowed token, the repay step fails mid-close and the
// position has to be cleared manually before the merge can proceed. This detects
// that shortfall from the audited balances so it can be surfaced at PREVIEW,
// rather than surprising the user with a failed step during execution.
//
// Returns a single warning string (or none): the action is identical no matter
// how many liabilities are short, so one clear message beats repeating it.
export function blendRepayShortfallWarnings(
  audit: AccountAudit,
  blend: readonly BlendPositionSummary[],
  network: NetworkConfig,
): string[] {
  if (blend.length === 0) return [];

  // total held per underlying-token contract id (the key Blend liabilities use).
  // A classic/native asset's SAC id is what a Blend reserve stores, so mapping
  // each held balance to its SAC id lets us compare against the liability keys.
  const heldByContract = new Map<string, bigint>();
  for (const b of audit.balances) {
    const contractId = contractIdFor(b.asset, network);
    if (contractId === null) continue;
    let held: bigint;
    try {
      held = decimalToStroops(b.amount);
    } catch {
      continue; // a malformed balance amount must not abort discovery
    }
    heldByContract.set(contractId, (heldByContract.get(contractId) ?? 0n) + held);
  }

  let short = false;
  for (const pool of blend) {
    for (const [assetContract, owed] of pool.liabilities) {
      if (owed <= 0n) continue;
      if ((heldByContract.get(assetContract) ?? 0n) < owed) {
        short = true;
        break;
      }
    }
    if (short) break;
  }
  if (!short) return [];

  return [
    "This account has a Blend loan that must be repaid before it can close, and repaying needs " +
      "the borrowed token on hand (Blend has no built-in swap). This account doesn't hold enough " +
      "of it, so the repay step would stop the close partway through. Top up that token in this " +
      "account, or unwind the Blend position yourself, before closing.",
  ];
}

// the SAC (Stellar Asset Contract) id for a classic/native asset, matching how a
// Blend reserve keys its liabilities. Pool-share balances can't be a liability.
function contractIdFor(asset: AssetIdentifier, network: NetworkConfig): string | null {
  try {
    if (asset.kind === "native") return Asset.native().contractId(network.passphrase);
    if (asset.kind === "credit") {
      return new Asset(asset.code, asset.issuer).contractId(network.passphrase);
    }
    return null;
  } catch {
    return null;
  }
}

function decimalToStroops(s: string): bigint {
  const trimmed = s.trim();
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [intPart = "0", fracPart = ""] = abs.split(".");
  const fracPadded = (fracPart + "0000000").slice(0, 7);
  const result = BigInt(intPart) * 10_000_000n + BigInt(fracPadded || "0");
  return negative ? -result : result;
}
