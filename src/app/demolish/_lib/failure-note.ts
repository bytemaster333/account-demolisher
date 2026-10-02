// what the failure screen may honestly say about the account, read from the
// plan tree's receipts rather than assumed. A failure can land after the merge
// into the exchange helper account, or after DeFi steps already moved funds, so
// "nothing changed" is only true when no step has a receipt.

import { MEDIATOR_FORWARD_NODE_ID } from "@/lib/mediator/refresh";
import { topologicalOrder, type PlanNode, type PlanTree } from "@/lib/plan/tree";

export type FailureNote =
  // the account merged into the short-lived helper account, the forward to the
  // destination didn't finish: the balance is in the helper account now
  | {
      readonly kind: "in-mediator";
      readonly mergeHash: string;
      readonly mediatorPublicKey: string;
    }
  // the merge landed (direct close) but the run still reported a failure
  | { readonly kind: "closed"; readonly mergeHash: string }
  // some steps finished on chain; the account is still open
  | { readonly kind: "partial"; readonly ran: readonly PlanNode[] }
  // no step has a receipt
  | { readonly kind: "nothing-ran"; readonly multiBatch: boolean };

export function failureNoteFor(tree: PlanTree | null): FailureNote {
  if (tree === null) return { kind: "nothing-ran", multiBatch: false };
  const final = tree.allNodes.get("final-classic-tx");
  // node.executed on the final node is set only once the merge batch confirmed
  // (the executor never sets it for an intermediate batch), and a later
  // "blocked" progress event may overwrite its status but not its receipt
  const mergeHash = final?.executed?.txHash;
  if (mergeHash !== undefined) {
    const forward = tree.allNodes.get(MEDIATOR_FORWARD_NODE_ID);
    if (forward && forward.kind === "MediatorForward" && forward.executed === undefined) {
      return {
        kind: "in-mediator",
        mergeHash,
        mediatorPublicKey: forward.metadata.mediatorPublicKey,
      };
    }
    return { kind: "closed", mergeHash };
  }
  const ran = topologicalOrder(tree).filter((n) => n.executed !== undefined);
  if (ran.length > 0) return { kind: "partial", ran };
  const multiBatch = final?.kind === "FinalClassicTx" && final.metadata.batches.length > 1;
  return { kind: "nothing-ran", multiBatch };
}
