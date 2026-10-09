"use client";

import type { NetworkConfig } from "@/lib/config/networks";
import { isRetryableFailure, type PageFlowContext } from "@/lib/orchestrator/page-flow-machine";
import type { PlanTree } from "@/lib/plan/tree";

import type { RunReview } from "../_hooks/use-run-review";
import { DemolishStatusWidget, type DeliveredAmount } from "./StatusWidget";
import type { StatusState } from "./status/types";

// execute / succeeded / prepared / failed all collapse to a single centered
// widget. one card lifecycle: header morphs by state (executing counter →
// success banner → failure banner), the plan tree is the body throughout, and
// the footer holds the right actions per state.
export function RunStatusStage({
  state,
  tree,
  ctx,
  review,
  network,
  destination,
  delivered,
  runMismatched,
  onRetry,
  onReset,
  onPreparedDone,
}: {
  readonly state: StatusState;
  readonly tree: PlanTree;
  readonly ctx: PageFlowContext;
  readonly review: RunReview;
  // the network the run is on
  readonly network: NetworkConfig;
  // the destination the run was built with
  readonly destination: string;
  readonly delivered: DeliveredAmount;
  readonly runMismatched: boolean;
  readonly onRetry: () => void;
  readonly onReset: () => void;
  readonly onPreparedDone: () => void;
}): React.JSX.Element {
  const runInput = ctx.input;
  return (
    <div style={{ maxWidth: 1080, margin: "0 auto" }}>
      <DemolishStatusWidget
        state={state}
        tree={tree}
        planGroups={review.planGroups}
        doneCount={review.doneCount}
        activeCount={review.activeCount}
        network={network}
        closedAccount={runInput?.publicKey ?? ctx.audit?.accountId ?? ""}
        destination={destination}
        mergeHash={review.finalNode?.executed?.txHash ?? null}
        delivered={delivered}
        error={ctx.error}
        signingMode={
          ctx.signedBundle !== null
            ? "bundle"
            : runInput?.signerKind === "secret"
              ? "secret"
              : "wallet"
        }
        retryResumes={isRetryableFailure(ctx.failureKind ?? "unknown")}
        retryDisabledReason={
          runMismatched
            ? "Reconnect the account and network this close was running on to retry."
            : null
        }
        failureKind={ctx.failureKind}
        executionNotes={ctx.executionNotes}
        landedPhases={ctx.landedPhases}
        discoveryDiagnostics={ctx.discoveryDiagnostics}
        prepared={ctx.preparedClose}
        onRetry={onRetry}
        onReset={onReset}
        onPreparedDone={onPreparedDone}
      />
    </div>
  );
}
