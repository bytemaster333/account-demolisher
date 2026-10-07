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
  // xlm quotes for credit balances, keyed by pathKey (resolveCreditPaths output).
  // a quote carrying sourceAmount covers exactly that amount of the asset, and
  // counts only when it matches the balance plus the credit claims on it; one
  // without sourceAmount covers the balance alone.
  readonly creditQuotes: ReadonlyMap<
    string,
    { readonly destinationAmount: string; readonly sourceAmount?: string }
  >;
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

  // per credit asset: the balance and each credit claim landing on it
  const credits = new Map<string, { balance: bigint; claims: bigint[] }>();
  const creditOf = (key: string) => {
    let entry = credits.get(key);
    if (entry === undefined) {
      entry = { balance: 0n, claims: [] };
      credits.set(key, entry);
    }
    return entry;
  };

  for (const b of audit.balances) {
    if (!isPositive(b.amount)) continue;
    if (b.asset.kind === "native") stroops += decimalToStroops(b.amount);
    else if (b.asset.kind === "credit")
      creditOf(pathKey(b.asset)).balance = decimalToStroops(b.amount);
    else unpriced += 1;
  }

  const claimed = new Set(input.claimedBalanceIds);
  for (const cb of audit.claimableBalances) {
    if (!claimed.has(cb.id) || !isPositive(cb.amount)) continue;
    if (cb.asset.kind === "native") stroops += decimalToStroops(cb.amount);
    // claiming the account's own asset burns it, so it moves nothing
    else if (cb.asset.kind === "credit" && cb.asset.issuer === audit.accountId) continue;
    else if (cb.asset.kind === "credit") {
      creditOf(pathKey(cb.asset)).claims.push(decimalToStroops(cb.amount));
    } else unpriced += 1;
  }

  for (const [key, { balance, claims }] of credits) {
    const quote = creditQuotes.get(key);
    const total = claims.reduce((sum, c) => sum + c, balance);
    if (quote === undefined) {
      unpriced += (balance > 0n ? 1 : 0) + claims.length;
    } else if (quote.sourceAmount === undefined) {
      // sized for the balance only, so the claims stay unpriced
      if (balance > 0n) stroops += decimalToStroops(quote.destinationAmount);
      unpriced += claims.length;
    } else if (decimalToStroops(quote.sourceAmount) === total) {
      stroops += decimalToStroops(quote.destinationAmount);
    } else {
      unpriced += 1;
    }
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

// true when an xlm total strictly exceeds the threshold, compared in stroops. a
// malformed total or threshold throws: a value that cannot be read must never
// pass as small.
export function isHighValueTotalXlm(
  totalXlm: string,
  threshold: number = HIGH_VALUE_THRESHOLD_XLM,
): boolean {
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    throw new RangeError(
      `high-value threshold must be a non-negative whole number of XLM; got ${threshold}`,
    );
  }
  return decimalToStroops(totalXlm) > BigInt(threshold) * 10_000_000n;
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
