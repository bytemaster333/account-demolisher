// which claimable balances the reviewed close collects and which it leaves
// behind. A balance that isn't claimable yet is skipped by the batcher, and once
// the account is deleted it can't claim it any more, so the user has to be told.

import {
  planClaimableBalances,
  type ClaimableBalanceBlock,
  type TrustlineChange,
} from "@/lib/plan/classic-batcher";
import type { PlanTree } from "@/lib/plan/tree";
import { filterClaimableNow } from "@/lib/stellar/claimable-balances";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";
import { pathKey } from "@/lib/types/plan";

export type UnlockTime =
  // claimable right now, but the built plan doesn't claim it (it arrived after
  // the plan was built, or was left out of the selection)
  | { readonly kind: "now" }
  | { readonly kind: "at"; readonly at: Date }
  // this account can no longer claim it (its window has passed)
  | { readonly kind: "never" }
  // a relative-time predicate the audit can't evaluate without the creation time
  | { readonly kind: "unknown" };

// why the close doesn't collect a balance: the planner's reason, or the user
// left it out of the claim list. null when neither applies (a balance that
// arrived after the plan was built)
export type LeftBehindReason = ClaimableBalanceBlock | "not_selected";

export interface LeftBehindClaim {
  readonly id: string;
  readonly asset: AssetIdentifier;
  readonly amount: string;
  readonly unlock: UnlockTime;
  readonly reason: LeftBehindReason | null;
}

export interface ClaimableSplit {
  readonly collectCount: number;
  readonly leftBehind: readonly LeftBehindClaim[];
  readonly trustlineChanges: readonly TrustlineChange[];
}

function collectThresholds(node: unknown, out: number[], flags: { rel: boolean }): void {
  if (Array.isArray(node)) {
    for (const n of node) collectThresholds(n, out, flags);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "rel_before" || key === "relBefore") {
      flags.rel = true;
    } else if ((key === "abs_before_epoch" || key === "absBeforeEpoch") && value !== null) {
      const s = Number(value);
      if (Number.isFinite(s)) out.push(s * 1000);
    } else if ((key === "abs_before" || key === "absBefore") && typeof value === "string") {
      const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value);
      if (Number.isFinite(ms)) out.push(ms);
    } else {
      collectThresholds(value, out, flags);
    }
  }
}

// a predicate only changes value at its absolute thresholds, so the earliest
// instant this account can claim is the first threshold at which it holds
function earliestUnlock(
  cb: AccountAudit["claimableBalances"][number],
  publicKey: string,
  nowMs: number,
): UnlockTime {
  if (filterClaimableNow([cb], publicKey, new Date(nowMs)).length > 0) return { kind: "now" };
  const thresholds: number[] = [];
  const flags = { rel: false };
  collectThresholds(cb.claimantsRaw, thresholds, flags);
  const future = [...new Set(thresholds)].filter((t) => t > nowMs).sort((a, b) => a - b);
  for (const t of future) {
    if (filterClaimableNow([cb], publicKey, new Date(t)).length > 0) {
      return { kind: "at", at: new Date(t) };
    }
  }
  return flags.rel ? { kind: "unknown" } : { kind: "never" };
}

// the claim ids the built close collects, read from its batches
export function plannedClaimIds(tree: PlanTree | null): readonly string[] {
  const final = tree?.allNodes.get("final-classic-tx");
  if (!final || final.kind !== "FinalClassicTx") return [];
  return final.metadata.batches
    .flatMap((b) => b.operations)
    .filter((o) => o.kind === "claim_claimable_balance")
    .map((o) => String(o.metadata["balanceId"]));
}

export function claimableSplit(args: {
  readonly audit: AccountAudit;
  readonly tree: PlanTree | null;
  readonly publicKey: string;
  readonly nowMs: number;
}): ClaimableSplit {
  const final = args.tree?.allNodes.get("final-classic-tx");
  const md = final && final.kind === "FinalClassicTx" ? final.metadata : null;
  const claimed = new Set(plannedClaimIds(args.tree));

  // why the planner leaves a balance out, judged at the fee base the preview
  // built the batches with (simulated fee over its operation count)
  const reasons = new Map<string, ClaimableBalanceBlock>();
  if (md !== null) {
    const sim = final?.simulated;
    const feePerOp =
      sim?.kind === "classic" && sim.operationCount > 0
        ? Number(BigInt(sim.estimatedFee) / BigInt(sim.operationCount))
        : undefined;
    const options = feePerOp !== undefined ? { feePerOpStroops: feePerOp } : {};
    // a balance the planner itself left out of the recorded list (the user made
    // no pick) has a reason only in the planner's own pass over every balance
    for (const ids of [undefined, md.claimableBalanceIds]) {
      for (const l of planClaimableBalances(args.audit, ids, options).leftBehind) {
        reasons.set(l.balance.id, l.reason);
      }
    }
  }
  const reviewed = md?.claimableBalanceIds === undefined ? null : new Set(md.claimableBalanceIds);

  const leftBehind = args.audit.claimableBalances
    .filter((cb) => !claimed.has(cb.id))
    .map((cb) => ({
      id: cb.id,
      asset: cb.asset,
      amount: cb.amount,
      unlock: earliestUnlock(cb, args.publicKey, args.nowMs),
      reason:
        reasons.get(cb.id) ??
        (reviewed !== null && !reviewed.has(cb.id) ? ("not_selected" as const) : null),
    }));

  // a trustline the close opens (or raises) so a claim can land; an opened one
  // holds a base reserve until the close removes it again
  const lines = new Set(
    args.audit.balances.flatMap((b) => (b.asset.kind === "credit" ? [pathKey(b.asset)] : [])),
  );
  const trustlineChanges: TrustlineChange[] = [];
  for (const op of md?.batches.flatMap((b) => b.operations) ?? []) {
    if (op.kind !== "change_trust_add") continue;
    const asset = op.metadata["asset"] as AssetIdentifier | undefined;
    if (asset?.kind !== "credit") continue;
    trustlineChanges.push({ asset, change: lines.has(pathKey(asset)) ? "raise" : "add" });
  }
  return { collectCount: claimed.size, leftBehind, trustlineChanges };
}
