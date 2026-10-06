// user-facing notes the close flow shows before anything is signed

import type { PlanTree } from "@/lib/plan/tree";

// protocol key for a discovery that did not finish at all
export const ALL_PROTOCOLS = "all";

// user-facing copy for a discovery error. a warning an adapter wrote for the user
// (a stranding, backstop or manual-close notice) is shown verbatim; a technical
// load failure gets a generic frame.
export function discoveryWarningFor(e: {
  readonly protocol: string;
  readonly message: string;
}): string {
  if (e.protocol === ALL_PROTOCOLS) {
    return "We couldn't finish checking for DeFi positions, so anything you have in apps like Blend, Aquarius or Soroswap might be missing from this plan. The close stays blocked until a rebuilt plan can read them, because a position missed here would be left on the deleted account.";
  }
  const actionable =
    /backstop|stranded|will be stranded|withdraw it|manual close|close it manually|before closing/i.test(
      e.message,
    );
  return actionable
    ? e.message
    : `We couldn't check your ${e.protocol} positions. The close stays blocked until a rebuilt plan can read them.`;
}

// held-token notes shown before the user confirms, so a token that can't be
// swept is never a silent skip:
//   a CEX/mediator close can't forward raw tokens, so the selection is not swept;
//   a drain or conversion that failed in preview is tried again at execute, and
//   these notes say what happens if it fails again.
export function heldTokenDispositionWarnings(
  tree: PlanTree,
  opts: { readonly useMediator: boolean; readonly selectedCount: number },
): string[] {
  const out: string[] = [];
  if (opts.useMediator && opts.selectedCount > 0) {
    const n = opts.selectedCount;
    out.push(
      `The ${n} standalone token${n === 1 ? "" : "s"} you selected can't be forwarded to an ` +
        `exchange, so ${n === 1 ? "it won't" : "they won't"} be swept. Move ${
          n === 1 ? "it" : "them"
        } to a personal wallet before closing, or ${n === 1 ? "it" : "they"} will be left behind.`,
    );
  }
  for (const node of tree.allNodes.values()) {
    if (node.kind !== "TransferAsIs" && node.kind !== "ConvertSorobanToXLM") continue;
    if (node.status !== "failed" && node.status !== "skipped") continue;
    const asset = node.metadata.asset;
    const label =
      asset.kind === "contract"
        ? `${asset.contractId.slice(0, 4)}…${asset.contractId.slice(-4)}`
        : "a standalone token";
    const reason = node.error ?? "the simulation failed";
    if (node.kind === "TransferAsIs") {
      out.push(
        `We couldn't prepare the transfer of token ${label} (${reason}). The close tries it ` +
          "again; if it still fails, the token stays on the closed account. Remove it from the " +
          "sweep, or move it out of the account yourself first.",
      );
    } else {
      out.push(
        `We couldn't prepare the conversion of token ${label} to XLM (${reason}). The close tries ` +
          "again and, if it still can't convert it, sends the token to your destination as-is. If " +
          "that fails too, the close stops before the merge.",
      );
    }
  }
  return out;
}
