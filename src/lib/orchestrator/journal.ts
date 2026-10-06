// per-node execution record that survives a RETRY (the machine re-executes the
// same node objects). it holds what the plan types have no place for: the last
// submission whose outcome is not known yet, and the receipts of classic phases
// that landed before the close finished.

import type { PlanNode } from "@/lib/plan/tree";

export interface PendingSubmission {
  readonly hash: string;
  // unix seconds after which the transaction can no longer be included
  readonly maxTime: number | null;
  // classic phases only: whether this batch carried the account_merge
  readonly final?: boolean;
}

export interface PhaseReceipt {
  readonly txHash: string;
  readonly ledger: number;
}

export interface NodeJournal {
  pending: PendingSubmission | null;
  readonly landedPhases: PhaseReceipt[];
  // mediator forward only: local time before the request that issued the flow
  // token now on the node, or null when that is not known
  flowIssuedAt: number | null;
}

const journals = new WeakMap<PlanNode, NodeJournal>();

export function journalFor(node: PlanNode): NodeJournal {
  let j = journals.get(node);
  if (j === undefined) {
    j = { pending: null, landedPhases: [], flowIssuedAt: null };
    journals.set(node, j);
  }
  return j;
}

// read-only view for callers that report what already landed
export function landedPhasesOf(node: PlanNode): readonly PhaseReceipt[] {
  return journals.get(node)?.landedPhases ?? [];
}
