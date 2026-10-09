"use client";

import { useMachine } from "@xstate/react";
import { useMemo, useState } from "react";

import { TypedConfirmation } from "@/components/confirmations/TypedConfirmation";
import { AuthImmutableBlock } from "@/components/warnings/AuthImmutableBlock";
import { SponsoringBlock } from "@/components/warnings/SponsoringBlock";
import { PendingForwardBanner } from "@/components/wallet/PendingForwardBanner";
import { NETWORKS, type NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl } from "@/lib/explorer";
import { pageFlowMachine } from "@/lib/orchestrator/page-flow-machine";
import { destinationRequiresMediator, lookupCex, type CexInfo } from "@/lib/safety/cex-registry";
import { useNetworkStore } from "@/stores/network";
import { useWalletStore } from "@/stores/wallet";

import { useBaseReserve, useDeliveredAmount } from "../_hooks/use-chain-figures";
import { useCloseChoices } from "../_hooks/use-close-choices";
import { useCloseLocks } from "../_hooks/use-close-locks";
import { useConfirmStage } from "../_hooks/use-confirm-stage";
import { useDemolishMetrics } from "../_hooks/use-demolish-metrics";
import { useDestinationChecks } from "../_hooks/use-destination-checks";
import {
  useDisconnectWhenClosed,
  useFlowConnector,
  useTeardownNotice,
} from "../_hooks/use-flow-connector";
import { useMultisigPreflight } from "../_hooks/use-multisig-preflight";
import { useRunControls } from "../_hooks/use-run-controls";
import { useRunGuard } from "../_hooks/use-run-guard";
import { useRunReview } from "../_hooks/use-run-review";
import { useSharedClose } from "../_hooks/use-shared-close";
import { useStartClose } from "../_hooks/use-start-close";
import { failureNoteFor } from "../_lib/failure-note";
import { buildFlowSteps, flowPhaseFor } from "../_lib/flow-steps";
import { AcknowledgeStage } from "./AcknowledgeStage";
import { CancelledPanel } from "./CancelledPanel";
import { CollectStage } from "./CollectStage";
import type { PreflightView } from "./ConfigurePanel";
import { ConfigureStage } from "./ConfigureStage";
import {
  FlowError,
  FlowHeading,
  PreflightFailedCard,
  ResumeMismatchNotice,
  TeardownNotice,
} from "./FlowNotices";
import { IdleConnect } from "./IdleConnect";
import { LeftLoadingCard } from "./LoadingCard";
import { ResolveStage } from "./ResolveStage";
import { ReviewStage } from "./ReviewStage";
import { RunStatusStage } from "./RunStatusStage";

// the /demolish page: wires the run's machine to the hooks that derive what it
// shows and to the stage that renders it. Each stage lives in its own
// component, and the state and handlers behind them in _hooks.
export function DemolishFlow(): React.JSX.Element {
  const publicKey = useWalletStore((s) => s.publicKey);
  const connectorKind = useWalletStore((s) => s.connectorKind);
  const isDemo = useWalletStore((s) => s.isDemo);
  const disconnectWallet = useWalletStore((s) => s.disconnect);

  // the navbar's network. A run keeps its own (ctx.input.network, below), and
  // every run-specific view, link and metric uses that one instead.
  const networkId = useNetworkStore((s) => s.networkId);
  const network = useMemo<NetworkConfig>(() => NETWORKS[networkId], [networkId]);

  const connector = useFlowConnector(publicKey, connectorKind, network);
  const { hasConnector, setConnector } = connector;

  // fixed per mount: the reference time for claim windows and stored requests
  const [mountedAt] = useState(() => Date.now());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { teardownError, onTeardownError, clearTeardownError } = useTeardownNotice();

  // whether the connected account is shared, read before the plan is built so a
  // shared account is planned without market sells from the start
  const { preflight, retry: retryPreflight } = useMultisigPreflight(publicKey, network);

  const [snapshot, send, actorRef] = useMachine(pageFlowMachine);
  const state = snapshot.value;
  const ctx = snapshot.context;
  const audit = ctx.audit;
  const tree = ctx.tree;
  const runInput = ctx.input;
  const runNetwork = runInput?.network ?? network;

  const choices = useCloseChoices(ctx.refusedConversions);

  const isMachineIdle = state === "idle";
  const isDiscovering = state === "discovering";
  const isPreviewing = state === "previewing";
  const isAwaitingConfirmation = state === "awaiting_confirmation";
  const isExecuting = state === "executing";
  const isSucceeded = state === "succeeded";
  // every step ran but nothing merged: the account stays open until the queued
  // backstop withdrawal unlocks
  const isPrepared = state === "prepared";
  const isFailed = state === "failed";
  const isCancelled = state === "cancelled";

  // a plan is bound to the account and network it was built for: once either
  // changes it is discarded, and it can't be confirmed or retried here. A close
  // already executing is stopped at its next step boundary.
  const runMismatched = useRunGuard({
    state: String(state),
    input: runInput,
    publicKey,
    networkId: network.id,
    send,
  });

  useDemolishMetrics({
    networkId: network.id,
    runNetworkId: runNetwork.id,
    connected: publicKey !== null,
    state: String(state),
    mergedTxHash: ctx.result?.ok ? (ctx.result.mergedTxHash ?? null) : null,
  });

  const review = useRunReview({
    ctx,
    isAwaitingConfirmation,
    publicKey,
    preflight,
    runNetwork,
    mountedAt,
    choices,
  });
  const { multisigRequired, hasBlocker, hasAckItems, blocked } = review;

  const { confirmStage, goToStage, showConfirmDialog, setShowConfirmDialog } = useConfirmStage({
    tree,
    isAwaitingConfirmation,
    hasBlocker,
    hasAckItems,
    setFormError,
  });

  // derived UI sub-states from the design ↔ real machine mapping
  const isIdle = isMachineIdle && publicKey === null;
  // configure = no run in progress for this account
  const isConfiguring = !blocked && publicKey !== null && isMachineIdle;
  // the three awaiting_confirmation stages, gated on the tree being present
  const inConfirmation = !blocked && tree !== null && isAwaitingConfirmation && !runMismatched;
  const isResolve = inConfirmation && confirmStage === "resolve";
  const isAcknowledge = inConfirmation && confirmStage === "acknowledge";
  const isReview = inConfirmation && confirmStage === "review";
  const showFlow = !isIdle && !blocked;

  // inline gates on the destination and memo, so Continue only enables for a
  // close onStart will accept
  const { destinationGate, destExistsGate, memoGate, sep29MemoRequired } = useDestinationChecks(
    choices.form,
    publicKey,
    network,
  );

  // cex / mediator: every memo-required destination, a registry exchange or a
  // SEP-29 flagged account, goes through the mediator
  const cex: CexInfo | null = useMemo(() => {
    const trimmed = choices.form.destination.trim();
    if (trimmed.length === 0) return null;
    return lookupCex(trimmed);
  }, [choices.form.destination]);
  const useMediator = destinationRequiresMediator(
    choices.form.destination.trim(),
    sep29MemoRequired === true,
  );

  const shared = useSharedClose({
    ctx,
    publicKey,
    network,
    runNetwork,
    mountedAt,
    useMediator,
    multisigRequired,
    effectiveMultisig: review.effectiveMultisig,
    selectedHeldTokens: choices.selectedHeldTokens,
    runMismatched,
    isAwaitingConfirmation,
  });
  const { signing, collecting } = shared;
  const activeRequest = signing.active;

  useCloseLocks({
    isExecuting,
    collecting,
    gatheringSignatures: shared.gatheringSignatures,
  });

  const planBuilt = tree !== null;
  const flowSteps = useMemo(
    () =>
      buildFlowSteps({
        phase: flowPhaseFor({
          showFlow,
          state: String(state),
          hasTree: planBuilt,
          confirmStage,
        }),
        hasResolve: planBuilt && hasBlocker,
        hasAcknowledge: planBuilt && hasAckItems && !hasBlocker,
        isSucceeded: isSucceeded || isPrepared,
        hasCollect: multisigRequired,
        collecting,
        prepareOnly: tree?.prepareOnly !== undefined,
      }),
    [
      showFlow,
      state,
      planBuilt,
      confirmStage,
      hasBlocker,
      hasAckItems,
      isSucceeded,
      isPrepared,
      multisigRequired,
      collecting,
      tree,
    ],
  );

  useDisconnectWhenClosed({
    isSucceeded,
    connectorRef: connector.connectorRef,
    bundleSubmitted: ctx.signedBundle !== null,
    finishSigning: signing.finished,
    disconnectWallet,
    onTeardownError,
  });

  const start = useStartClose({
    send,
    ctx,
    publicKey,
    network,
    connector,
    choices,
    sep29MemoRequired,
    destExistsHint: destExistsGate.hint,
    useMediator,
    multisigRequired,
    configureGate: shared.configureGate,
    builtClaimList: review.builtClaimList,
    claimRisks: shared.claimRisks,
    signing,
    setFormError,
    setShowConfirmDialog,
  });
  const onStart = start.onStart;

  const controls = useRunControls({
    send,
    getMachineState: () => actorRef.getSnapshot().value,
    runInput,
    publicKey,
    networkId: network.id,
    runMismatched,
    blockers: review.blockers,
    connector,
    choices,
    signing,
    setFormError,
    setShowConfirmDialog,
    disconnectWallet,
    onTeardownError,
    clearTeardownError,
  });
  const { onBackToConfigure, onReset, onRetry } = controls;

  const failedInMediator =
    isFailed && failureNoteFor(tree, ctx.landedPhases).kind === "in-mediator";

  // the destination the run was built with; the form can drift from it
  const runDestination = runInput?.destination ?? choices.form.destination.trim();
  const destination = choices.form.destination.trim();
  const destHead = destination.length > 4 ? destination.slice(0, -4) : "";
  const destTail = destination.length > 0 ? destination.slice(-4) : "";

  const baseReserveStroops = useBaseReserve(runNetwork, audit !== null);
  // an exchange close delivers through the forward out of the helper account
  const deliveryHash =
    (runInput?.useMediator ? ctx.result?.forwardTxHash : ctx.result?.mergedTxHash) ?? null;
  const delivered = useDeliveredAmount(
    runNetwork,
    isSucceeded ? deliveryHash : null,
    runDestination,
  );

  const preflightView: PreflightView =
    preflight.status === "error"
      ? { status: "error", message: preflight.message, retry: retryPreflight }
      : preflight.status === "ready"
        ? { status: "ready" }
        : { status: "loading" };

  // the close is running or over: the status widget (or the preflight failure)
  // replaces the planning panels
  const runStarted = isExecuting || isSucceeded || isFailed || isPrepared;

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 24px 96px" }}>
      {/* SEC-01 part B: offer to resume an interrupted exchange forward, if any.
          A run that failed inside the helper account shows its own resume in the
          status widget, so this one steps aside to avoid two resume buttons. */}
      {!failedInMediator ? <PendingForwardBanner publicKey={publicKey} /> : null}

      {teardownError !== null ? (
        <TeardownNotice message={teardownError} onDismiss={clearTeardownError} />
      ) : null}

      {/* IDLE, connect. Keyed by network so a switch starts it fresh. */}
      {isIdle ? (
        <IdleConnect
          key={network.id}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
          network={network}
          onKitConnector={(c) => setConnector(c)}
          onSecretConnector={(c) => setConnector(c)}
        />
      ) : null}

      {/* BLOCKED, full takeover */}
      {!isIdle && review.isImmutableBlock ? <AuthImmutableBlock onDismiss={onReset} /> : null}
      {!isIdle && !review.isImmutableBlock && review.isSponsorBlock ? (
        // foreign sponsorships the close can't release on its own
        <SponsoringBlock
          numSponsoring={review.numSponsoring}
          coverable={review.numCoverable}
          onDismiss={onReset}
        />
      ) : null}

      {/* FLOW */}
      {showFlow ? (
        <>
          <FlowHeading steps={flowSteps} />

          {/* during discover/preview, take over the whole row with a single
              centered loading widget. Shown whatever tree the context still
              holds, so a rebuild or a rediscovering retry never renders blank. */}
          {isDiscovering || isPreviewing ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              <LeftLoadingCard message={isDiscovering ? "Auditing account…" : "Building plan…"} />
            </div>
          ) : null}

          {runStarted && tree !== null ? (
            <RunStatusStage
              state={
                isSucceeded
                  ? "succeeded"
                  : isPrepared
                    ? "prepared"
                    : isFailed
                      ? "failed"
                      : "executing"
              }
              tree={tree}
              ctx={ctx}
              review={review}
              network={runNetwork}
              destination={runDestination}
              delivered={delivered}
              runMismatched={runMismatched}
              onRetry={onRetry}
              onReset={onReset}
              onPreparedDone={controls.onPreparedDone}
            />
          ) : null}

          {isFailed && tree === null ? (
            <PreflightFailedCard
              error={ctx.error}
              network={runNetwork}
              retryDisabled={runMismatched}
              onRetry={onRetry}
              onReset={onReset}
            />
          ) : null}

          {/* single-column flow content, configure / review / sign-off / cancelled. */}
          {!(isDiscovering || isPreviewing) && !runStarted ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              {formError !== null && !isConfiguring ? <FlowError message={formError} /> : null}

              {collecting && activeRequest !== null && audit !== null ? (
                <CollectStage
                  request={activeRequest}
                  notStored={signing.notStored}
                  audit={audit}
                  network={runNetwork}
                  destination={runDestination}
                  connectedKey={publicKey}
                  onClose={controls.submitBundle}
                  onRebuildRequest={start.onRebuildRequest}
                />
              ) : (
                <>
                  {isConfiguring ? (
                    <ConfigureStage
                      signing={signing}
                      onResumeRequest={start.onResumeRequest}
                      multisigRequired={multisigRequired}
                      effectiveMultisig={review.effectiveMultisig}
                      primaryWeight={review.primaryWeight}
                      choices={choices}
                      cex={cex}
                      useMediator={useMediator}
                      formError={formError}
                      onStart={onStart}
                      isDemo={isDemo}
                      preflight={preflightView}
                      connected={publicKey !== null && hasConnector}
                      destinationGate={destinationGate}
                      destExistsGate={destExistsGate}
                      memoGate={memoGate}
                      configureGate={shared.configureGate}
                    />
                  ) : null}

                  {isAwaitingConfirmation && signing.resumeMismatch !== null ? (
                    <ResumeMismatchNotice
                      reason={signing.resumeMismatch}
                      onDiscard={signing.discardStored}
                    />
                  ) : null}

                  {isResolve ? (
                    <ResolveStage
                      ctx={ctx}
                      network={runNetwork}
                      choices={choices}
                      otherBlockers={review.otherBlockers}
                      onRebuild={onStart}
                      onBack={onBackToConfigure}
                    />
                  ) : null}

                  {isAcknowledge && audit !== null ? (
                    <AcknowledgeStage
                      ctx={ctx}
                      network={runNetwork}
                      review={review}
                      choices={choices}
                      publicKey={publicKey}
                      isCex={runInput?.useMediator ?? useMediator}
                      baseReserveStroops={baseReserveStroops}
                      onRebuild={onStart}
                      goToStage={goToStage}
                      onBackToConfigure={onBackToConfigure}
                    />
                  ) : null}

                  {isReview && audit !== null && runInput !== null ? (
                    <ReviewStage
                      review={review}
                      audit={audit}
                      runInput={runInput}
                      tree={tree}
                      network={runNetwork}
                      baseReserveStroops={baseReserveStroops}
                      shared={shared}
                      goToStage={goToStage}
                      onBackToConfigure={onBackToConfigure}
                      onDemolish={() => setShowConfirmDialog(true)}
                      onRebuild={onStart}
                      onLeaveOutRisky={start.onLeaveOutRisky}
                    />
                  ) : null}

                  {isCancelled ? (
                    <CancelledPanel
                      reason="wallet-changed"
                      publishedRequest={
                        signing.published !== null
                          ? {
                              planId: signing.published.planId,
                              validUntil: signing.published.validUntil,
                            }
                          : null
                      }
                      onStartOver={controls.onStartOverAfterCancel}
                    />
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {/* final gate, typed-confirmation dialog, opened from Review */}
          {showConfirmDialog && runInput !== null ? (
            <TypedConfirmation
              destination={runInput.destination}
              explorerUrl={explorerAccountUrl(runNetwork, runInput.destination)}
              memo={runInput.memo ?? null}
              memoViaMediator={runInput.useMediator}
              prepareOnly={tree?.prepareOnly !== undefined}
              onCancel={() => setShowConfirmDialog(false)}
              onConfirm={controls.confirmClose}
            />
          ) : null}
        </>
      ) : null}

      {/* hidden inputs preserved for E2E selectors */}
      <input
        type="hidden"
        data-testid="connector-ready"
        value={hasConnector ? "true" : "false"}
        readOnly
      />
      <input type="hidden" data-testid="machine-state" value={String(state)} readOnly />
      <input type="hidden" data-testid="dest-head" value={destHead} readOnly />
      <input type="hidden" data-testid="dest-tail" value={destTail} readOnly />
    </div>
  );
}
