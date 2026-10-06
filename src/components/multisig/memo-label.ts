// how a close's memo reads to a signer. the memo decides whether an exchange
// credits the deposit, so it is spelled out next to the destination, and its
// absence is stated rather than left blank.

import type { CloseMemo } from "@/lib/multisig/signing-request";
import { hasHiddenCharacters, safeDisplay } from "@/lib/safe-display";
import type { ClassicMemo } from "@/lib/types/plan";

// a text memo is whatever the initiator typed, so control and bidi characters
// are stripped for display and their presence is said out loud
export function describeCloseMemo(memo: CloseMemo): string {
  if (memo.type === "none") return "No memo";
  const hidden = hasHiddenCharacters(memo.value) ? " (contains hidden characters)" : "";
  return `Memo (${memo.type.toUpperCase()}): ${safeDisplay(memo.value)}${hidden}`;
}

export function closeMemoForConfirmation(memo: CloseMemo): ClassicMemo | null {
  return memo.type === "none" ? null : { type: memo.type, value: memo.value };
}
