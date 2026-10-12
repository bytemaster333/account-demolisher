"use client";

import type { NetworkConfig } from "@/lib/config/networks";
import type { PageFlowRunInput } from "@/lib/orchestrator/page-flow-machine";
import type { PlanTree } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";

import type { RunReview } from "../_hooks/use-run-review";
import type { ConfirmStage } from "../_lib/flow-steps";
import type { SharedClose } from "../_hooks/use-shared-close";
import { ReviewPanel } from "./ReviewPanel";

// the Review step, the clean "here is what will happen": plan overview, every
// operation, destination. A shared account's close is published from here as a
// signing request instead of being run.
export function ReviewStage({
  review,
  audit,
  runInput,
  tree,
  network,
  baseReserveStroops,
  baseReserveError,
  shared,
  goToStage,
  onBackToConfigure,
  onDemolish,
  onRebuild,
  onLeaveOutRisky,
}: {
  readonly review: RunReview;
  readonly audit: AccountAudit;
  readonly runInput: PageFlowRunInput;
  readonly tree: PlanTree | null;
  // the network the run is on
  readonly network: NetworkConfig;
  readonly baseReserveStroops: number | null;
  readonly baseReserveError: string | null;
  readonly shared: SharedClose;
  readonly goToStage: (stage: ConfirmStage) => void;
  readonly onBackToConfigure: () => void;
  // opens the typed confirmation
  readonly onDemolish: () => void;
  readonly onRebuild: () => void;
  // rebuilds without the claims at risk in the signing window
  readonly onLeaveOutRisky: () => void;
}): React.JSX.Element {
  const { claimRisks, signing } = shared;
  // back to the nearest earlier step this plan has
  const onBack = review.hasAckItems
    ? () => goToStage("acknowledge")
    : review.hasBlocker
      ? () => goToStage("resolve")
      : onBackToConfigure;
  return (
    <ReviewPanel
      planGroups={review.planGroups}
      audit={audit}
      baseReserveStroops={baseReserveStroops}
      baseReserveError={baseReserveError}
      destination={runInput.destination}
      memo={runInput.memo ?? null}
      useMediator={runInput.useMediator}
      deterministic={runInput.deterministicDisposal === true}
      network={network}
      blockers={review.blockers}
      {...(tree?.prepareOnly ? { prepareOnly: tree.prepareOnly } : {})}
      onBack={onBack}
      onDemolish={onDemolish}
      {...(review.multisigRequired
        ? {
            shared: {
              gate: shared.signingGate,
              claimRisks,
              ...(claimRisks.length > 0 ? { onLeaveOutRisky } : {}),
              onCreate: () => void signing.create(),
              creating: signing.creating,
              error: signing.error,
              ...(runInput.deterministicDisposal !== true ? { onRebuildShared: onRebuild } : {}),
            },
          }
        : {})}
    />
  );
}
