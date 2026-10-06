// which claimable balances the reviewed close collects and which it leaves
// behind. A balance that isn't claimable yet is skipped by the batcher, and once
// the account is deleted it can't claim it any more, so the user has to be told.

import type { PlanTree } from "@/lib/plan/tree";
import { filterClaimableNow } from "@/lib/stellar/claimable-balances";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";

export type UnlockTime =
  // claimable right now, but the built plan doesn't claim it (it arrived after
  // the plan was built, or was left out of the selection)
  | { readonly kind: "now" }
  | { readonly kind: "at"; readonly at: Date }
  // this account can no longer claim it (its window has passed)
  | { readonly kind: "never" }
  // a relative-time predicate the audit can't evaluate without the creation time
  | { readonly kind: "unknown" };

export interface LeftBehindClaim {
  readonly id: string;
  readonly asset: AssetIdentifier;
  readonly amount: string;
  readonly unlock: UnlockTime;
}

export interface ClaimableSplit {
  readonly collectCount: number;
  readonly leftBehind: readonly LeftBehindClaim[];
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
  collectThresholds(cb.predicate, thresholds, flags);
  const future = [...new Set(thresholds)].filter((t) => t > nowMs).sort((a, b) => a - b);
  for (const t of future) {
    if (filterClaimableNow([cb], publicKey, new Date(t)).length > 0) {
      return { kind: "at", at: new Date(t) };
    }
  }
  return flags.rel ? { kind: "unknown" } : { kind: "never" };
}

export function claimableSplit(args: {
  readonly audit: AccountAudit;
  readonly tree: PlanTree | null;
  readonly publicKey: string;
  readonly nowMs: number;
}): ClaimableSplit {
  const final = args.tree?.allNodes.get("final-classic-tx");
  const claimed = new Set(
    final && final.kind === "FinalClassicTx"
      ? final.metadata.batches
          .flatMap((b) => b.operations)
          .filter((o) => o.kind === "claim_claimable_balance")
          .map((o) => String(o.metadata["balanceId"]))
      : [],
  );
  const leftBehind = args.audit.claimableBalances
    .filter((cb) => !claimed.has(cb.id))
    .map((cb) => ({
      id: cb.id,
      asset: cb.asset,
      amount: cb.amount,
      unlock: earliestUnlock(cb, args.publicKey, args.nowMs),
    }));
  return { collectCount: claimed.size, leftBehind };
}
