"use client";

import type { NetworkConfig } from "@/lib/config/networks";
import type { PageFlowContext } from "@/lib/orchestrator/page-flow-machine";

import type { CloseChoices } from "../_hooks/use-close-choices";
import { ResolvePanel } from "./ResolvePanel";

// the Resolve step: what keeps the close from starting, each with its choices,
// then a rebuild with them
export function ResolveStage({
  ctx,
  network,
  choices,
  otherBlockers,
  onRebuild,
  onBack,
}: {
  readonly ctx: PageFlowContext;
  // the network the run is on
  readonly network: NetworkConfig;
  readonly choices: CloseChoices;
  // the blockers this step can't offer a choice for
  readonly otherBlockers: readonly string[];
  readonly onRebuild: () => void;
  readonly onBack: () => void;
}): React.JSX.Element {
  return (
    <ResolvePanel
      credits={ctx.unroutableCredits}
      network={network}
      returnToIssuer={choices.form.returnToIssuer}
      sendToDestination={choices.form.sendToDestination}
      acceptedPriceKeys={choices.acceptedPriceKeys}
      onSetDisposal={choices.onSetDisposal}
      refused={ctx.refusedConversions}
      heldChoices={choices.heldChoices}
      onHeldChoice={choices.onHeldChoice}
      forfeits={ctx.emissionForfeits}
      forfeitPools={new Set(choices.forfeitPools)}
      onForfeit={choices.onForfeit}
      otherBlockers={otherBlockers}
      onRebuild={onRebuild}
      onBack={onBack}
    />
  );
}
