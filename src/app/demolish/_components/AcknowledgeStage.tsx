"use client";

import { StandaloneTokensCard } from "@/components/wallet/StandaloneTokensCard";
import type { NetworkConfig } from "@/lib/config/networks";
import type { PageFlowContext } from "@/lib/orchestrator/page-flow-machine";

import type { CloseChoices } from "../_hooks/use-close-choices";
import type { RunReview } from "../_hooks/use-run-review";
import type { ConfirmStage } from "../_lib/flow-steps";
import { AcknowledgePanel } from "./AcknowledgePanel";
import { SharedTokensNotice } from "./SharedTokensNotice";

// the Check the plan step: optional choices that apply on a rebuild, then the
// notes to read. Continue is gated until every note is acknowledged.
export function AcknowledgeStage({
  ctx,
  network,
  review,
  choices,
  publicKey,
  isCex,
  baseReserveStroops,
  onRebuild,
  goToStage,
  onBackToConfigure,
}: {
  readonly ctx: PageFlowContext;
  // the network the run is on
  readonly network: NetworkConfig;
  readonly review: RunReview;
  readonly choices: CloseChoices;
  readonly publicKey: string | null;
  // the close goes through the exchange mediator
  readonly isCex: boolean;
  readonly baseReserveStroops: number | null;
  readonly onRebuild: () => void;
  readonly goToStage: (stage: ConfirmStage) => void;
  readonly onBackToConfigure: () => void;
}): React.JSX.Element {
  const { closeValue, claimedQuotes, claimChoices, conversionChoices } = review;
  return (
    <AcknowledgePanel
      network={network}
      scamFindings={review.scamFindings}
      discoveryWarnings={review.discoveryWarnings}
      claimables={review.claimables}
      sponsorshipCount={review.numCoverable}
      baseReserveStroops={baseReserveStroops}
      highValue={
        closeValue !== null && closeValue.highValue
          ? {
              estimatedXlm: closeValue.estimatedXlm,
              unpricedHoldings: closeValue.unpricedHoldings,
              pricingError: claimedQuotes.status === "error" ? claimedQuotes.message : null,
            }
          : null
      }
      {...(claimChoices !== undefined ? { claimChoices } : {})}
      {...(conversionChoices !== undefined ? { conversionChoices } : {})}
      planNotes={review.planNotes}
      tokensSlot={
        !review.showTokenSection ? undefined : review.multisigRequired ? (
          <SharedTokensNotice
            count={ctx.heldTokens.length + ctx.unreadableHeldTokens.length}
            scanFailed={ctx.heldTokenScanFailed}
          />
        ) : (
          <StandaloneTokensCard
            discovered={ctx.heldTokens}
            unreadable={ctx.unreadableHeldTokens}
            selected={choices.selectedHeldTokens}
            onChange={choices.setSelectedHeldTokens}
            network={network}
            userPublicKey={publicKey}
            isCex={isCex}
            onRebuild={onRebuild}
            convertToXLM={choices.convertHeldTokensToXLM}
            onConvertToXLMChange={choices.setConvertHeldTokensToXLM}
            partnerAsOfLedger={ctx.partnerCoverage.heldTokensAsOfLedger}
          />
        )
      }
      rebuildRequired={review.rebuildRequired}
      waitReason={
        review.heldScam.pending
          ? "Checking the standalone tokens' names…"
          : claimedQuotes.status === "loading"
            ? "Pricing the pending payments this close collects…"
            : null
      }
      onRebuild={onRebuild}
      onBack={review.hasBlocker ? () => goToStage("resolve") : onBackToConfigure}
      onContinue={() => goToStage("review")}
    />
  );
}
