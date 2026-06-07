// memo enforcement for cex destinations.
//
// when the destination matches a known cex AND the entry has requiresMemo,
// the orchestrator must refuse to build a merge or payment unless the user
// supplied a memo of the correct type and non-empty value. hard refusal —
// callers should treat ok:false as terminal and surface the reason in the
// ui. no override.

import type { CexInfo, CexMemoType } from "@/lib/safety/cex-registry";
import type { ClassicMemo } from "@/lib/types/plan";

export type MemoEnforcementResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// returns ok:true if the (cex, memo) pair is acceptable. non-cex
// destinations also return ok:true.
export function requireMemoEnforcement(
  cex: CexInfo | null,
  memo: ClassicMemo | undefined,
): MemoEnforcementResult {
  if (cex === null) return { ok: true };
  if (!cex.requiresMemo) return { ok: true };

  const expectedType: CexMemoType = cex.memoType ?? "text";

  if (!memo || memo.value.trim().length === 0) {
    return {
      ok: false,
      reason: `${cex.name} requires a ${expectedType} memo on every deposit. Funds sent without a memo are lost. Add a memo before proceeding.`,
    };
  }
  if (memo.type !== expectedType) {
    return {
      ok: false,
      reason: `${cex.name} requires a ${expectedType} memo. The supplied memo is type "${memo.type}" — change it before proceeding.`,
    };
  }
  return { ok: true };
}
