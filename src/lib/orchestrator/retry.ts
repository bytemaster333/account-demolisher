// tree preparation before an execute pass, and the preview results that must
// stop a close before anything is signed

import { BEST_EFFORT_KINDS, DEPENDENCY_SKIP_PREFIX } from "@/lib/orchestrator/executor";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";

// every node that has not landed and did not settle on purpose goes back to
// pending, so a re-execution re-runs it (and the merge after it) instead of
// skipping it. nodes that landed keep their receipt and are skipped by the
// executor; best-effort steps skipped on purpose stay skipped.
export function prepareTreeForExecution(tree: PlanTree): PlanTree {
  for (const node of tree.allNodes.values()) {
    if (node.executed !== undefined) continue;
    const rerun =
      node.status === "failed" ||
      node.status === "signed" ||
      node.status === "submitted" ||
      (node.status === "skipped" && node.error?.startsWith(DEPENDENCY_SKIP_PREFIX) === true);
    if (!rerun) continue;
    node.status = "pending";
    delete node.error;
  }
  return { ...tree };
}

export interface PreviewBlocker {
  readonly nodeId: string;
  readonly description: string;
  readonly error: string;
}

// a required step that could not be built or simulated in preview. confirming
// anyway would run every independent exit and then never reach the merge, so
// these block the confirmation. a best-effort step that failed is not a blocker:
// the executor tries it again and leaves the token or allowance behind if it
// still fails.
export function previewBlockers(tree: PlanTree | null): readonly PreviewBlocker[] {
  if (tree === null) return [];
  const out: PreviewBlocker[] = [];
  for (const node of tree.allNodes.values()) {
    if (node.status !== "failed") continue;
    if (isBestEffort(node)) continue;
    out.push({
      nodeId: node.id,
      description: node.description,
      error: node.error ?? "this step could not be prepared",
    });
  }
  return out;
}

function isBestEffort(node: PlanNode): boolean {
  return BEST_EFFORT_KINDS.has(node.kind);
}
