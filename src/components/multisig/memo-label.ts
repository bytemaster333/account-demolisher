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
  const { label, value, note } = memoParts({ type: memo.type, value: memo.value });
  return `${label} ${value}${note}`;
}

// the pieces of that label, for the confirmation dialog, which styles the value
// on its own. one source, so the final gate and the signing pages can't word a
// memo differently.
export interface MemoParts {
  // "Memo (TEXT):"
  readonly label: string;
  // the value with hidden characters stripped
  readonly value: string;
  // " (contains hidden characters)" when any were stripped, otherwise ""
  readonly note: string;
}

export function memoParts(memo: {
  readonly type: ClassicMemo["type"] | Exclude<CloseMemo["type"], "none">;
  readonly value: string;
}): MemoParts {
  return {
    label: `Memo (${memo.type.toUpperCase()}):`,
    value: safeDisplay(memo.value),
    note: hasHiddenCharacters(memo.value) ? " (contains hidden characters)" : "",
  };
}

export function closeMemoForConfirmation(memo: CloseMemo): ClassicMemo | null {
  return memo.type === "none" ? null : { type: memo.type, value: memo.value };
}
