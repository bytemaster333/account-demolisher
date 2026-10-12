// re-point an already-built plan's mediator nodes at a freshly minted flow.
//
// the preview mints a flow so the plan can show and simulate the merge into a
// mediator. the orchestrator mints again at execute time and swaps the new flow
// in here, so the token in use is younger than the one the user reviewed. the
// mediator account is internal and ephemeral; the reviewed destination and memo
// do not change. the token still expires 15 minutes after this mint, which can
// fall inside a long close; the forward renews an expired token through the
// re-issue route, so a late forward is not stranded by it.

import { mediatorLabel } from "@/lib/plan/classic-batcher";

export interface RefreshedFlow {
  readonly mediatorPublicKey: string;
  readonly flowToken: string;
}

// A structural view of the plan tree, to avoid importing the full PlanTree and
// PlanNode types (and their readonly metadata) just to rewrite these fields.
export interface MediatorFlowTree {
  readonly allNodes: ReadonlyMap<
    string,
    { readonly metadata: unknown; readonly description?: string }
  >;
}

export const FINAL_CLASSIC_TX_NODE_ID = "final-classic-tx";
export const MEDIATOR_FORWARD_NODE_ID = "mediator-forward";

interface MutableOp {
  kind: string;
  summary: string;
  metadata: Record<string, unknown>;
}

interface MutableBatch {
  operations: MutableOp[];
  mediator?: { publicKey: string; fundingXlm: string };
}

// the plan names the mediator by its full key or by mediatorLabel, so matching
// on the same function keeps this swap in step if the label's form changes
function repointText(text: string, from: string, to: string): string {
  return text.split(from).join(to).split(mediatorLabel(from)).join(mediatorLabel(to));
}

// the batches carry the mediator as the funding target, the merge destination
// and in their summaries; all of it has to follow the new key or the reviewed
// plan and an exported copy would name an account that is never used
function repointBatches(batches: unknown, from: string, to: string): unknown {
  if (!Array.isArray(batches)) return batches;
  return (batches as MutableBatch[]).map((batch) => ({
    ...batch,
    ...(batch.mediator?.publicKey === from
      ? { mediator: { ...batch.mediator, publicKey: to } }
      : {}),
    operations: batch.operations.map((op) => {
      const pointsAtMediator =
        (op.kind === "create_account_mediator" || op.kind === "account_merge") &&
        op.metadata.destination === from;
      if (!pointsAtMediator) return op;
      return {
        ...op,
        summary: repointText(op.summary, from, to),
        metadata: { ...op.metadata, destination: to },
      };
    }),
  }));
}

// re-point FinalClassicTx (funds and merges into the mediator) and
// MediatorForward (sweeps out of it, under the flow token) at `flow`. both must
// carry the same mediatorPublicKey or the merge and the forward would target
// different accounts. returns true when the tree is a mediator close (a forward
// node exists) and was updated; false otherwise (nothing to do).
export function applyRefreshedMediatorFlow(tree: MediatorFlowTree, flow: RefreshedFlow): boolean {
  const forwardNode = tree.allNodes.get(MEDIATOR_FORWARD_NODE_ID);
  if (!forwardNode) return false;

  const finalNode = tree.allNodes.get(FINAL_CLASSIC_TX_NODE_ID);
  if (finalNode) {
    const metadata = finalNode.metadata as { mediatorPublicKey?: string; batches?: unknown };
    const previous = metadata.mediatorPublicKey;
    metadata.mediatorPublicKey = flow.mediatorPublicKey;
    if (previous !== undefined && previous !== flow.mediatorPublicKey) {
      metadata.batches = repointBatches(metadata.batches, previous, flow.mediatorPublicKey);
      if (typeof finalNode.description === "string") {
        (finalNode as { description: string }).description = repointText(
          finalNode.description,
          previous,
          flow.mediatorPublicKey,
        );
      }
    }
  }

  const forwardMetadata = forwardNode.metadata as {
    mediatorPublicKey?: string;
    flowToken?: string;
  };
  forwardMetadata.mediatorPublicKey = flow.mediatorPublicKey;
  forwardMetadata.flowToken = flow.flowToken;

  return true;
}
