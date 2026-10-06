import { Asset } from "@stellar/stellar-sdk";

import type { BlendPositionSummary } from "@/lib/adapters/positions/interface";
import type { NetworkConfig } from "@/lib/config/networks";
import { decimalToStroops } from "@/lib/stellar/amount";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";

import { nativeMinimumBalance } from "./spendable";

// the close pays a Soroban fee for every exit step before it reaches a native
// repay, so the XLM check keeps this much back on top of the reserve. a margin
// for the preview warning only; the repay builder uses the real fee.
const NATIVE_FEE_ALLOWANCE_STROOPS = 1_0000000n;

// blend requires the borrowed token on hand to repay a loan; there is no
// automatic swap. closing the account must first repay every blend liability in
// full, so if this account cannot spend enough of a borrowed token, the repay
// step fails mid-close and the position has to be cleared manually before the
// merge can proceed. this detects that shortfall from the audited balances so it
// can be surfaced at preview, rather than surprising the user with a failed step
// during execution.
//
// liabilities arrive in underlying units (discovery converts dTokens with the
// reserve's dRate). the debt is summed per asset across pools, and compared
// with what the account can actually spend: balance minus selling liabilities,
// and for XLM also minus the minimum reserve and a fee allowance.
//
// returns a single warning string (or none): the action is identical no matter
// how many liabilities are short, so one clear message beats repeating it.
export function blendRepayShortfallWarnings(
  audit: AccountAudit,
  blend: readonly BlendPositionSummary[],
  network: NetworkConfig,
): string[] {
  if (blend.length === 0) return [];

  const owedByContract = new Map<string, bigint>();
  for (const pool of blend) {
    for (const [assetContract, owed] of pool.liabilities) {
      if (owed <= 0n) continue;
      owedByContract.set(assetContract, (owedByContract.get(assetContract) ?? 0n) + owed);
    }
  }
  if (owedByContract.size === 0) return [];

  const nativeContract = Asset.native().contractId(network.passphrase);
  const spendableByContract = new Map<string, bigint>();
  for (const b of audit.balances) {
    const contractId = contractIdFor(b.asset, network);
    if (contractId === null) continue;
    // horizon always sends 7-place decimals, so anything else is corrupt data
    // and throws rather than being counted as nothing spendable
    let free = decimalToStroops(b.amount) - decimalToStroops(b.sellingLiabilities);
    if (contractId === nativeContract) {
      free -=
        nativeMinimumBalance(
          audit.subentryCount,
          audit.sponsorship.numSponsoring,
          audit.sponsorship.numSponsored,
        ) + NATIVE_FEE_ALLOWANCE_STROOPS;
    }
    spendableByContract.set(contractId, (spendableByContract.get(contractId) ?? 0n) + free);
  }

  let short = false;
  for (const [assetContract, owed] of owedByContract) {
    if ((spendableByContract.get(assetContract) ?? 0n) < owed) {
      short = true;
      break;
    }
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
// blend reserve keys its liabilities. pool-share balances cannot be a liability.
// an invalid code or issuer throws: the audit came from horizon, so that is
// corrupt data, not a balance to leave out of the count.
function contractIdFor(asset: AssetIdentifier, network: NetworkConfig): string | null {
  if (asset.kind === "native") return Asset.native().contractId(network.passphrase);
  if (asset.kind === "credit") {
    return new Asset(asset.code, asset.issuer).contractId(network.passphrase);
  }
  return null;
}
