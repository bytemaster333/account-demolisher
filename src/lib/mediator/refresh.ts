// Re-point an already-built plan's mediator nodes at a freshly minted flow.
//
// SEC-01: the mediator flow token is minted at PREVIEW time with a hard 15-minute
// TTL (server/mediator-secret.ts). The close then runs FinalClassicTx — which
// funds an ephemeral mediator account and merges the user's ENTIRE balance into
// it — strictly before the separate MediatorForward sweeps that balance back out
// under the token. If more than 15 minutes elapse between preview and the forward
// (a careful review of a permanent action, a slow multi-position execution, a
// network hiccup), the token expires, the forward can no longer be co-signed, and
// the whole balance is stranded on an ephemeral account with no in-app recovery.
//
// The fix: re-mint the flow at EXECUTE time and re-point both mediator nodes at it,
// so the TTL clock starts immediately before the merge+forward — which both run in
// the same execute pass, well inside the window. The mediator account is internal
// and ephemeral (never something the user reviews; the reviewed DESTINATION is
// unchanged), so swapping its key between preview and execute is transparent.

export interface RefreshedFlow {
  readonly mediatorPublicKey: string;
  readonly flowToken: string;
}

// A structural view of the plan tree — avoids importing the full PlanTree/PlanNode
// types (and their readonly metadata) just to mutate the two hydration points.
export interface MediatorFlowTree {
  readonly allNodes: ReadonlyMap<string, { readonly metadata: unknown }>;
}

export const FINAL_CLASSIC_TX_NODE_ID = "final-classic-tx";
export const MEDIATOR_FORWARD_NODE_ID = "mediator-forward";

// Re-point FinalClassicTx (funds + merges INTO the mediator) and MediatorForward
// (sweeps OUT of it, under the flow token) at `flow`. Both must carry the SAME
// mediatorPublicKey or the merge and the forward would target different accounts.
// Returns true when the tree is a mediator close (a forward node exists) and was
// updated; false otherwise (nothing to do).
export function applyRefreshedMediatorFlow(tree: MediatorFlowTree, flow: RefreshedFlow): boolean {
  const forwardNode = tree.allNodes.get(MEDIATOR_FORWARD_NODE_ID);
  if (!forwardNode) return false;

  const finalNode = tree.allNodes.get(FINAL_CLASSIC_TX_NODE_ID);
  if (finalNode) {
    (finalNode.metadata as { mediatorPublicKey?: string }).mediatorPublicKey =
      flow.mediatorPublicKey;
  }

  const forwardMetadata = forwardNode.metadata as {
    mediatorPublicKey?: string;
    flowToken?: string;
  };
  forwardMetadata.mediatorPublicKey = flow.mediatorPublicKey;
  forwardMetadata.flowToken = flow.flowToken;

  return true;
}
