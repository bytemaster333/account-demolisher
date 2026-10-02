// standalone-token choices live in page state and only reach the plan through a
// rebuild, so the page compares them with what the built plan used

import type { HeldToken } from "@/lib/soroban/held-tokens";

function tokenKey(t: HeldToken): string {
  return `${t.contractId}:${t.balance.toString()}`;
}

// true when the ticked tokens (contract and amount) or the convert toggle differ
// from the plan that was built. The convert toggle only matters with a selection.
export function heldSelectionDirty(
  selected: readonly HeldToken[],
  convertToXLM: boolean,
  built: {
    readonly selectedHeldTokens?: readonly HeldToken[];
    readonly convertHeldTokensToXLM?: boolean;
  },
): boolean {
  const builtTokens = built.selectedHeldTokens ?? [];
  const a = new Set(selected.map(tokenKey));
  const b = new Set(builtTokens.map(tokenKey));
  if (a.size !== b.size || [...a].some((k) => !b.has(k))) return true;
  if (selected.length === 0) return false;
  return convertToXLM !== (built.convertHeldTokensToXLM === true);
}
