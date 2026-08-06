// "Manual close required" advisory for protocols this tool cannot auto-unwind.
//
// Automated unwinding covers exactly Blend, Aquarius, Soroswap, and FxDAO. Any
// OTHER on-chain position — a pool share, a loan/vault receipt, or a staked
// balance in a protocol we don't support — can't be detected or unwound here.
// There is no general "what protocols has this account used" scan, but a held
// SEP-41 token from an UNRECOGNIZED contract is the visible fingerprint of one:
// protocols hand out receipt/share/staked tokens, and those surface as standalone
// tokens the account holds directly. So when the account holds standalone tokens
// we don't recognize, we advise a manual close of any such position before the
// account is deleted, rather than silently moving a receipt token as-is (which
// would strand the underlying value in the unsupported protocol).

export const SUPPORTED_DEFI_PROTOCOLS = ["Blend", "Aquarius", "Soroswap", "FxDAO"] as const;

// Returns a "manual close required" notice when the account holds standalone
// tokens (readable or unreadable) that could be positions in an unsupported
// protocol, or null when there are none.
export function manualCloseRequiredNotice(counts: {
  readonly heldTokenCount: number;
  readonly unreadableTokenCount: number;
}): string | null {
  const total = counts.heldTokenCount + counts.unreadableTokenCount;
  if (total <= 0) return null;
  const noun = total === 1 ? "token" : "tokens";
  return (
    `Manual close required for unsupported protocols: this close only auto-unwinds ` +
    `${SUPPORTED_DEFI_PROTOCOLS.join(", ")}. The account holds ${total} ${noun} from ` +
    `contract${total === 1 ? "" : "s"} we don't recognize. If any is a position in another DeFi ` +
    `app — a pool share, a loan or vault receipt, or a staked balance — unwind it in that app ` +
    `first; we can only move the ${noun} as-is, which may not reclaim the underlying value.`
  );
}
