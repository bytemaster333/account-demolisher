// High-value safety gate. A close that moves a large value must require an
// explicit acknowledgement before it can proceed, so a big irreversible merge is
// never one careless click away. This module is the gate's pure logic (trigger +
// acknowledgement bookkeeping), kept free of any wallet/UI imports so it is
// unit-testable in isolation.

import type { AccountAudit } from "@/lib/types/account";
import { pathKey } from "@/lib/types/plan";

export const HIGH_VALUE_THRESHOLD_XLM = 1000;

export interface CloseValueInput {
  readonly audit: AccountAudit;
  // xlm quotes for credit balances, keyed by pathKey (resolveCreditPaths output)
  readonly creditQuotes: ReadonlyMap<string, { readonly destinationAmount: string }>;
  // the user's claim selection; undefined claims every claimable balance
  readonly claimableBalanceIds?: readonly string[];
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
      stroops += toStroops(b.amount);
      continue;
    }
    const quote = b.asset.kind === "credit" ? creditQuotes.get(pathKey(b.asset)) : undefined;
    if (quote) stroops += toStroops(quote.destinationAmount);
    else unpriced += 1;
  }

  const selected =
    input.claimableBalanceIds === undefined ? null : new Set(input.claimableBalanceIds);
  for (const cb of audit.claimableBalances) {
    if (cb.claimableNow !== true || (selected !== null && !selected.has(cb.id))) continue;
    if (!isPositive(cb.amount)) continue;
    if (cb.asset.kind === "native") stroops += toStroops(cb.amount);
    else unpriced += 1;
  }

  const estimatedXlm = fromStroops(stroops);
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

function toStroops(amount: string): bigint {
  const v = amount.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(v)) {
    throw new Error(`assessCloseValue: not a 7-decimal amount: "${amount}"`);
  }
  const [whole = "0", frac = ""] = v.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0"));
}

function fromStroops(stroops: bigint): string {
  return `${stroops / 10_000_000n}.${(stroops % 10_000_000n).toString().padStart(7, "0")}`;
}

// The high-value gate's TRIGGER: true when the account's total XLM STRICTLY
// exceeds the threshold. A non-numeric total never trips the gate.
export function isHighValueTotalXlm(
  totalXlm: string,
  threshold: number = HIGH_VALUE_THRESHOLD_XLM,
): boolean {
  const n = Number.parseFloat(totalXlm);
  return Number.isFinite(n) && n > threshold;
}

// Which acknowledgement checkboxes the acknowledge step must collect before the
// user can continue, given which advisory conditions are present. High value is
// one of them.
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

// The gate is cleared only when EVERY required acknowledgement is ticked.
export function allAcknowledged(
  required: readonly string[],
  acks: Readonly<Record<string, boolean>>,
): boolean {
  return required.every((k) => acks[k] === true);
}
