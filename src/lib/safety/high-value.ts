// high-value safety gate: a close that moves a large value needs an explicit
// acknowledgement, so a big irreversible merge is never one careless click away.
// pure logic (trigger and acknowledgement bookkeeping), free of wallet and ui
// imports.

import { decimalToStroops, stroopsToDecimal } from "@/lib/stellar/amount";
import type { AccountAudit } from "@/lib/types/account";
import { pathKey } from "@/lib/types/plan";

export const HIGH_VALUE_THRESHOLD_XLM = 1000;

export interface CloseValueInput {
  readonly audit: AccountAudit;
  // xlm quotes for credit balances, keyed by pathKey (resolveCreditPaths output)
  readonly creditQuotes: ReadonlyMap<string, { readonly destinationAmount: string }>;
  // ids of the claimable balances the plan claims
  // (planClaimableBalances(audit, selection).claimed), not the user's selection:
  // the batcher also claims self-sponsored balances the user unticked
  readonly claimedBalanceIds: readonly string[];
  // soroban positions and held tokens the close unwinds or moves, whose xlm
  // value is not estimated here
  readonly unpricedPositions: number;
}

export interface CloseValue {
  // native balance + quoted credit conversions + claimed xlm, as an xlm decimal
  readonly estimatedXlm: string;
  // holdings the close moves whose xlm value is unknown
  readonly unpricedHoldings: number;
  readonly highValue: boolean;
}

// what the close is expected to move, in xlm. a holding that cannot be priced
// trips the gate on its own, since it may be worth any amount.
export function assessCloseValue(
  input: CloseValueInput,
  threshold: number = HIGH_VALUE_THRESHOLD_XLM,
): CloseValue {
  const { audit, creditQuotes } = input;
  let stroops = 0n;
  let unpriced = input.unpricedPositions;

  for (const b of audit.balances) {
    if (!isPositive(b.amount)) continue;
    if (b.asset.kind === "native") {
      stroops += decimalToStroops(b.amount);
      continue;
    }
    const quote = b.asset.kind === "credit" ? creditQuotes.get(pathKey(b.asset)) : undefined;
    if (quote) stroops += decimalToStroops(quote.destinationAmount);
    else unpriced += 1;
  }

  const claimed = new Set(input.claimedBalanceIds);
  for (const cb of audit.claimableBalances) {
    if (!claimed.has(cb.id) || !isPositive(cb.amount)) continue;
    if (cb.asset.kind === "native") stroops += decimalToStroops(cb.amount);
    else unpriced += 1;
  }

  const estimatedXlm = stroopsToDecimal(stroops);
  return {
    estimatedXlm,
    unpricedHoldings: unpriced,
    highValue: unpriced > 0 || isHighValueTotalXlm(estimatedXlm, threshold),
  };
}

function isPositive(amount: string): boolean {
  for (const ch of amount) if (ch >= "1" && ch <= "9") return true;
  return false;
}

// true when the total strictly exceeds the threshold. a non-numeric total never
// trips it, so callers pass assessCloseValue's estimatedXlm, which is always a
// well-formed amount.
export function isHighValueTotalXlm(
  totalXlm: string,
  threshold: number = HIGH_VALUE_THRESHOLD_XLM,
): boolean {
  const n = Number.parseFloat(totalXlm);
  return Number.isFinite(n) && n > threshold;
}

// which acknowledgement boxes the acknowledge step must collect before the user
// can continue, given which advisory conditions are present
export function requiredAcknowledgements(flags: {
  readonly hasScam: boolean;
  readonly hasDiscovery: boolean;
  readonly hasAutoHandled: boolean;
  readonly hasHighValue: boolean;
}): string[] {
  return [
    flags.hasScam ? "scam" : null,
    flags.hasDiscovery ? "discovery" : null,
    flags.hasAutoHandled ? "autoHandled" : null,
    flags.hasHighValue ? "highValue" : null,
  ].filter((k): k is string => k !== null);
}

// cleared only when every required acknowledgement is ticked
export function allAcknowledged(
  required: readonly string[],
  acks: Readonly<Record<string, boolean>>,
): boolean {
  return required.every((k) => acks[k] === true);
}
