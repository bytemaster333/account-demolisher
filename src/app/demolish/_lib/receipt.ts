// the success view's delivered amount and the saved receipt. The amount comes
// from the chain (the destination's credit effects on the delivering
// transaction), never from the pre-close balance, which ignores fees and every
// conversion, claim and withdrawal.

import type { Horizon } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { explorerTxUrl } from "@/lib/explorer";
import type { LeftBehindToken } from "@/lib/orchestrator/executor";
import type { PlanNode } from "@/lib/plan/tree";

import { stroopsToXlm, xlmToStroops } from "./fees";
import { nodeLabel } from "./plan-copy";

export interface EffectLike {
  readonly type: string;
  readonly account: string;
  readonly asset_type?: string;
  readonly amount?: string;
}

// native XLM credited to the destination across the given effects
export function sumDeliveredXlm(effects: readonly EffectLike[], destination: string): string {
  let total = 0n;
  for (const e of effects) {
    if (e.type !== "account_credited") continue;
    if (e.account !== destination || e.asset_type !== "native") continue;
    if (typeof e.amount !== "string") continue;
    total += xlmToStroops(e.amount);
  }
  return stroopsToXlm(total);
}

const EFFECTS_PAGE = 200;
// a close transaction carries at most 100 operations, each with a handful of
// effects, so this bounds the paging without ever truncating a real close
const MAX_EFFECT_PAGES = 10;

// read every effect of a transaction and sum what the destination received in
// XLM. Throws when Horizon can't be read, so the caller shows no number instead
// of a wrong one.
export async function fetchDeliveredXlm(
  horizon: Horizon.Server,
  txHash: string,
  destination: string,
): Promise<string> {
  const all: EffectLike[] = [];
  let page = await horizon.effects().forTransaction(txHash).limit(EFFECTS_PAGE).call();
  for (let i = 0; i < MAX_EFFECT_PAGES; i++) {
    all.push(...(page.records as unknown as readonly EffectLike[]));
    if (page.records.length < EFFECTS_PAGE) return sumDeliveredXlm(all, destination);
    page = await page.next();
  }
  throw new Error(`transaction ${txHash} has more effects than expected for a close`);
}

export function buildReceiptText(args: {
  readonly closedAccount: string;
  readonly destination: string;
  // null while unknown or when the lookup failed: no figure is written then
  readonly deliveredXlm: string | null;
  readonly network: NetworkConfig;
  readonly mergeHash: string | null;
  readonly ordered: readonly PlanNode[];
  // held tokens the close could not send, which stay on the closed account
  readonly leftBehind?: readonly LeftBehindToken[];
  // set when the run only prepared the close: the account is still open
  readonly preparedUntil?: Date;
}): string {
  const steps = args.ordered
    .filter((n) => n.kind !== "FinalClassicTx" && n.executed?.txHash)
    .map((n) => `${nodeLabel(n)}: ${explorerTxUrl(args.network, n.executed!.txHash)}`);
  if (args.preparedUntil !== undefined) {
    return [
      "Account Demolisher, close prepared (the account is still open)",
      `Account: ${args.closedAccount}`,
      `Come back on or after ${args.preparedUntil.toISOString().slice(0, 10)} to finish the close to ${args.destination}`,
      ...steps,
    ].join("\n");
  }
  const left = (args.leftBehind ?? []).map(
    (t) =>
      `Left on the closed account: token ${t.contractId}, ${t.amount.toString()} base units` +
      (t.unconfirmedTxHash !== undefined
        ? ` (transfer ${t.unconfirmedTxHash} submitted, not confirmed)`
        : ` (not sent: ${t.reason})`),
  );
  const lines = [
    left.length > 0
      ? "Account Demolisher, account closed with tokens left behind"
      : "Account Demolisher, account closed",
    `Closed account: ${args.closedAccount}`,
    args.deliveredXlm !== null
      ? `Delivered ${args.deliveredXlm} XLM to ${args.destination}`
      : `Your remaining balance was sent to ${args.destination}`,
    args.mergeHash ? `Merge tx: ${explorerTxUrl(args.network, args.mergeHash)}` : "",
    ...left,
    ...steps,
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}
