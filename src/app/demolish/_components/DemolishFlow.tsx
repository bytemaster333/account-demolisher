"use client";

import { useMachine } from "@xstate/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, Card, Notice } from "@/components/ui";
import { TypedConfirmation } from "@/components/confirmations/TypedConfirmation";
import { AuthImmutableBlock } from "@/components/warnings/AuthImmutableBlock";
import { PendingForwardBanner } from "@/components/wallet/PendingForwardBanner";
import { StandaloneTokensCard } from "@/components/wallet/StandaloneTokensCard";
import type { HeldToken } from "@/lib/soroban/held-tokens";
import { SponsoringBlock } from "@/components/warnings/SponsoringBlock";
import { CollectSignatures } from "@/components/multisig/CollectSignatures";
import { explorerAccountUrl } from "@/lib/explorer";
import { useNetworkStore } from "@/stores/network";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import {
  isRetryableFailure,
  pageFlowMachine,
  type PageFlowInput,
} from "@/lib/orchestrator/page-flow-machine";
import { getPublicEnv } from "@/lib/config/env";
import { SIGNING_WINDOW_SECONDS, assessBundleability } from "@/lib/multisig/signing-request";
import {
  lookupCex,
  requireMemoEnforcement,
  validateMemoFormat,
  type CexInfo,
} from "@/lib/safety/cex-registry";
import { runScamHeuristics } from "@/lib/safety/scam-heuristics";
import { isHighValueTotalXlm } from "@/lib/safety/high-value";
import { topologicalOrder } from "@/lib/plan/tree";
import type { Connector } from "@/lib/wallet/connector";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { disconnectSession, getActiveConnector } from "@/lib/wallet/active-connector";
import { useWalletStore } from "@/stores/wallet";

import { useBaseReserve, useDeliveredAmount } from "../_hooks/use-chain-figures";
import { useDemolishMetrics } from "../_hooks/use-demolish-metrics";
import { useDestinationChecks } from "../_hooks/use-destination-checks";
import { useMultisigPreflight } from "../_hooks/use-multisig-preflight";
import { useRunGuard } from "../_hooks/use-run-guard";
import { useSigningRequest } from "../_hooks/use-signing-request";
import { SR_ONLY } from "../_lib/a11y";
import { claimableSplit } from "../_lib/claimables";
import { failureNoteFor } from "../_lib/failure-note";
import { buildFlowSteps, flowPhaseFor, type ConfirmStage } from "../_lib/flow-steps";
import { FORM_SCHEMA, INITIAL_FORM, parseMemo, type FormState } from "../_lib/form";
import { heldSelectionDirty } from "../_lib/held-selection";
import { groupPlanNodes, sumNativeBalance } from "../_lib/plan-copy";
import { assessSigningRequest, claimsAtRiskInWindow } from "../_lib/signing-bundle";
import type { StoredSigningRequest } from "../_lib/signing-request-store";
import { AcknowledgePanel } from "./AcknowledgePanel";
import { CancelledPanel } from "./CancelledPanel";
import { ConfigurePanel, type PreflightView } from "./ConfigurePanel";
import { IdleConnect } from "./IdleConnect";
import { LeftLoadingCard } from "./LoadingCard";
import { MultisigContextBar } from "./MultisigContextBar";
import { ResolvePanel } from "./ResolvePanel";
import { ReviewPanel } from "./ReviewPanel";
import { SponsorshipAutoRevokeNotice } from "./SponsorshipAutoRevokeNotice";
import { DemolishStatusWidget, type SigningMode } from "./StatusWidget";
import { StepIndicator } from "./StepIndicator";

export function DemolishFlow(): React.JSX.Element {
  const connectorRef = useRef<Connector | null>(null);
  const publicKey = useWalletStore((s) => s.publicKey);
  const connectorKind = useWalletStore((s) => s.connectorKind);
  const isDemo = useWalletStore((s) => s.isDemo);
  const disconnectWallet = useWalletStore((s) => s.disconnect);

  // the navbar's network. A run keeps its own (ctx.input.network, below), and
  // every run-specific view, link and metric uses that one instead.
  const networkId = useNetworkStore((s) => s.networkId);
  const network = useMemo<NetworkConfig>(() => resolveNetwork(networkId), [networkId]);

  // Do we have a live connector that can actually SIGN here? Derived (not stored)
  // so it stays in sync with the app-wide wallet session across client-side
  // navigation: a kit connection can always be reconstructed, and any live
  // connector shared via setActiveConnector (e.g. from /allowances) counts. A
  // pasted-seed session whose connector didn't survive to this page stays
  // unsignable, which correctly gates the CTA. Mirrors the allowances page.
  const hasConnector =
    publicKey !== null && (getActiveConnector() !== null || connectorKind === "kit");

  // Populate connectorRef when arriving already-connected (e.g. connected on
  // /allowances, then navigated here client-side). connectorRef starts empty on
  // each mount, but the wallet session is shared, so recover the live connector
  // for signing. Sets a ref only (no state) so the derived hasConnector above is
  // the single source of truth for the gate.
  useEffect(() => {
    if (publicKey === null) {
      connectorRef.current = null;
      return;
    }
    if (connectorRef.current !== null) return; // connected on this page already
    const active = getActiveConnector();
    if (active !== null) {
      connectorRef.current = active;
    } else if (connectorKind === "kit") {
      // the kit reads its own persisted wallet selection, so a fresh instance can
      // sign even after the live object was lost
      connectorRef.current = new WalletKitConnector(network);
    }
  }, [publicKey, connectorKind, network]);

  // fixed per mount: the reference time for claim windows and stored requests
  const [mountedAt] = useState(() => Date.now());

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  // standalone SEP-41 tokens the user opted in to sweep (discovered ones they
  // ticked + any added by contract id). Kept OUTSIDE the zod form because each
  // carries a bigint balance; default empty so nothing is swept without a choice.
  const [selectedHeldTokens, setSelectedHeldTokens] = useState<readonly HeldToken[]>([]);
  // opt-in: convert the opted-in held tokens to XLM (Soroswap-router swap) instead
  // of transferring them as-is. Default off: transfer-as-is preserves the exact
  // token and can't be defeated by an illiquid/unroutable one.
  const [convertHeldTokensToXLM, setConvertHeldTokensToXLM] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // pre-select the claimable balances by default so the demo flow "just works"
  // (see the render-time prefill below)
  const [prefilledAuditId, setPrefilledAuditId] = useState<string | null>(null);

  // whether the connected account is shared, read before the plan is built so a
  // shared account is planned without market sells from the start
  const { preflight, retry: retryPreflight } = useMultisigPreflight(publicKey, network);

  // the awaiting_confirmation phase has three stages:
  //  "resolve"    , take an action on a blocker (return-to-issuer) + rebuild
  //  "acknowledge", read-and-understand every warning / info card
  //  "review"     , the clean "here is what will happen" review + demolish
  // the stage is initialised per built plan (below), skipping any empty step.
  const [confirmStage, setConfirmStage] = useState<ConfirmStage>("review");
  // the final typed-confirmation dialog, opened from the review step
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const [snapshot, send] = useMachine(pageFlowMachine);
  const state = snapshot.value;
  const ctx = snapshot.context;

  const audit = ctx.audit;
  const tree = ctx.tree;
  const runInput = ctx.input;
  const runNetwork = runInput?.network ?? network;

  // prefer the AUTHORITATIVE discovery audit once it's available. ctx.audit is
  // the audit the plan is actually built from.
  const effectiveMultisig = useMemo(() => {
    if (audit) {
      return {
        required: audit.requiresMultisig,
        threshold: audit.thresholds.high,
        signers: audit.signers,
      };
    }
    return preflight.status === "ready" ? preflight.info : null;
  }, [audit, preflight]);

  // the initiator's own signing weight on the shared account (their key alone)
  const primaryWeight = useMemo(() => {
    if (!effectiveMultisig || !publicKey) return 0;
    return effectiveMultisig.signers.find((s) => s.key === publicKey)?.weight ?? 0;
  }, [effectiveMultisig, publicKey]);
  const multisigRequired = publicKey !== null && effectiveMultisig?.required === true;

  // scam heuristics over the account's held credit balances (look-alike symbols,
  // homoglyphs, off-allowlist contracts), surfaced as an informational notice.
  const scamFindings = useMemo(
    () => (audit ? runScamHeuristics(audit.balances, runNetwork.id) : []),
    [audit, runNetwork.id],
  );

  const isMachineIdle = state === "idle";
  const isDiscovering = state === "discovering";
  const isPreviewing = state === "previewing";
  const isAwaitingConfirmation = state === "awaiting_confirmation";
  const isExecuting = state === "executing";
  const isSucceeded = state === "succeeded";
  const isFailed = state === "failed";
  const isCancelled = state === "cancelled";

  // a plan is bound to the account and network it was built for: once either
  // changes it is discarded, and it can't be confirmed or retried here
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

  // derived UI sub-states from the design ↔ real machine mapping
  const isIdle = isMachineIdle && publicKey === null;
  const authImmutable = audit?.flags.authImmutable === true;
  const numSponsoring = audit?.sponsorship.numSponsoring ?? 0;
  // self-sponsored entries the demolition releases on its own (trustlines,
  // offers, signers + claimable CBs), computed once in the audit.
  const numCoverable = audit?.sponsorship.coverable ?? 0;
  // hard-block only when at least one sponsorship is foreign (sponsoring entries
  const isSponsorBlock = !authImmutable && numSponsoring > numCoverable;
  const isImmutableBlock = authImmutable;
  const blocked = isImmutableBlock || isSponsorBlock;

  // total native balance + high-value flag, needed by the Resolve step and the
  // review summary; computed early so the flow phase / stepper can read them.
  const totalXlm = audit ? sumNativeBalance(audit) : "0";
  const isHighValue = useMemo<boolean>(() => {
    if (!audit) return false;
    return isHighValueTotalXlm(totalXlm);
  }, [audit, totalXlm]);

  // what the reviewed close collects, and the claimable balances it leaves
  const claimables = useMemo(
    () =>
      audit
        ? claimableSplit({ audit, tree, publicKey: audit.accountId, nowMs: mountedAt })
        : { collectCount: 0, leftBehind: [] },
    [audit, tree, mountedAt],
  );

  // two distinct concerns, kept as separate steps:
  //  - a BLOCKER (un-routable balance) needs an ACTION + rebuild  → "resolve"
  //  - warnings / info need only READ-AND-UNDERSTAND               → "acknowledge"
  const hasBlocker = ctx.unroutableCredits.length > 0;
  const hasScam = scamFindings.length > 0;
  const hasDiscovery = ctx.discoveryWarnings.length > 0;
  const hasAutoHandled = claimables.collectCount > 0 || numCoverable > 0;
  const hasLeftBehind = claimables.leftBehind.length > 0;
  // the standalone-token section belongs with the warnings (it's about funds that
  // could be left behind). Show it whenever there's a real reason to look: tokens
  // found, unreadable candidates, or the optional scan couldn't finish (so the
  // manual add-a-token is still reachable). A clean, complete scan doesn't nag.
  const showTokenSection =
    ctx.heldTokens.length > 0 || ctx.unreadableHeldTokens.length > 0 || ctx.heldTokenScanFailed;
  const hasAckItems =
    hasScam || hasDiscovery || hasAutoHandled || hasLeftBehind || isHighValue || showTokenSection;

  // initialise the confirm stage per built plan: resolve blockers first, then
  // acknowledge warnings/info, then the clean review, skipping any empty step.
  const initedTreeRef = useRef<unknown>(null);
  useEffect(() => {
    if (tree !== null && isAwaitingConfirmation) {
      if (initedTreeRef.current !== tree) {
        initedTreeRef.current = tree;
        setConfirmStage(hasBlocker ? "resolve" : hasAckItems ? "acknowledge" : "review");
        setShowConfirmDialog(false);
      }
    } else if (tree === null) {
      initedTreeRef.current = null;
    }
  }, [tree, isAwaitingConfirmation, hasBlocker, hasAckItems]);

  // configure = no run in progress for this account
  const isConfiguring = !blocked && publicKey !== null && isMachineIdle;
  // the three awaiting_confirmation stages, gated on the tree being present
  const inConfirmation = !blocked && tree !== null && isAwaitingConfirmation && !runMismatched;
  const isResolve = inConfirmation && confirmStage === "resolve";
  const isAcknowledge = inConfirmation && confirmStage === "acknowledge";
  const isReview = inConfirmation && confirmStage === "review";
  const showFlow = !isIdle && !blocked;

  // cex / mediator
  const cex: CexInfo | null = useMemo(() => {
    const trimmed = form.destination.trim();
    if (trimmed.length === 0) return null;
    return lookupCex(trimmed);
  }, [form.destination]);
  const useMediator = cex !== null;

  // ── shared-account signing request ────────────────────────────────────────
  // Configure only knows the destination kind; the full gate (positions, held
  // tokens, the built tree, deterministic disposal) applies once a plan exists
  const configureGate = assessBundleability({
    hasSorobanPositions: false,
    hasSelectedAllowances: false,
    useMediator,
  });
  const signingGate = assessSigningRequest({
    positions: ctx.positions,
    allowanceCount: ctx.allowances.length,
    useMediator: runInput?.useMediator ?? useMediator,
    heldTokensSelected: Math.max(
      selectedHeldTokens.length,
      runInput?.selectedHeldTokens?.length ?? 0,
    ),
    tree,
    deterministic: runInput?.deterministicDisposal === true,
  });
  const claimRisks = useMemo(
    () =>
      multisigRequired && audit !== null && tree !== null
        ? claimsAtRiskInWindow({
            audit,
            tree,
            publicKey: audit.accountId,
            nowMs: mountedAt,
            windowSeconds: SIGNING_WINDOW_SECONDS,
          })
        : [],
    [multisigRequired, audit, tree, mountedAt],
  );

  const signing = useSigningRequest({
    runInput,
    audit,
    tree,
    network: runNetwork,
    gate: signingGate,
    runMismatched,
    isAwaitingConfirmation,
    publicKey,
    storeNetworkId: network.id,
    nowMs: mountedAt,
  });
  const activeRequest = signing.active;
  // the Signatures step is shown only while still gathering signatures for the
  // current, matching run; a cancel or a wallet/network change takes it down
  const collecting = activeRequest !== null && isAwaitingConfirmation && !runMismatched;

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
        isSucceeded,
        hasCollect: multisigRequired,
        collecting,
      }),
    [
      showFlow,
      state,
      planBuilt,
      confirmStage,
      hasBlocker,
      hasAckItems,
      isSucceeded,
      multisigRequired,
      collecting,
    ],
  );

  // inline gates on the destination and memo, so Continue only enables for a
  // close onStart will accept
  const { destinationGate, destExistsGate, memoGate } = useDestinationChecks(
    form,
    publicKey,
    network,
  );

  const setConnector = useCallback((c: Connector | null) => {
    connectorRef.current = c;
    // ConnectButton re-notifies every render, so nothing here may create a new
    // state value on each call (it would spin an infinite render loop). The
    // preflight is keyed to the account and the signing request to the run, so
    // neither needs an explicit reset here.
  }, []);

  // once the account is closed it no longer exists, drop the connection so a
  // later navigation back to /demolish starts at Connect, not Configure with a
  // dead account. A shared close also ends in the machine "succeeded" state (the
  // collected bundle is submitted via SUBMIT_BUNDLE), so this one guard covers
  // both flows. Cleared directly (not via setConnector) so the success view,
  // which keys off the machine/tree, stays visible. Guarded to fire once.
  const closedRef = useRef(false);
  const finishSigning = signing.finished;
  useEffect(() => {
    if (isSucceeded && !closedRef.current) {
      closedRef.current = true;
      connectorRef.current = null;
      // a submitted signing request has nothing left to resume
      if (ctx.signedBundleXdr !== null) finishSigning();
      // full teardown (connector + kit + store): the account was merged and no
      // longer exists, so leave nothing authorized to it at the wallet level
      void disconnectSession(disconnectWallet);
    } else if (!isSucceeded && closedRef.current) {
      closedRef.current = false;
    }
  }, [isSucceeded, disconnectWallet, ctx.signedBundleXdr, finishSigning]);

  // guard against navigating away / closing the tab mid-execution, a partial
  // run leaves the account half-dismantled; while signatures are being
  // collected, leaving drops the live view of them.
  useEffect(() => {
    if (!isExecuting && !collecting) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isExecuting, collecting]);

  const startRun = useCallback(
    (input: PageFlowInput) => {
      setShowConfirmDialog(false);
      send({ type: "START", input });
    },
    [send],
  );

  const onStart = useCallback(() => {
    setFormError(null);

    const parsed = FORM_SCHEMA.safeParse(form);
    if (!parsed.success) {
      setFormError(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }
    if (!publicKey || !connectorRef.current) {
      setFormError("Connect a wallet first.");
      return;
    }
    if (parsed.data.destination === publicKey) {
      setFormError(
        "Destination can't be your own account, Stellar rejects a self-merge (ACCOUNT_MERGE_MALFORMED).",
      );
      return;
    }

    const memo = parseMemo(form);

    // validate the memo VALUE shape for ANY destination, so a malformed id/hash
    // memo can't slip past a non-CEX close and throw inside Memo.id()/hash() only
    // at execute time (mid-close, after earlier steps may have submitted).
    if (memo !== undefined) {
      const memoFormatError = validateMemoFormat(memo.type, memo.value);
      if (memoFormatError !== null) {
        setFormError(memoFormatError);
        return;
      }
    }

    // hard refusal when the destination is a CEX and the memo is missing, the
    // wrong type, or malformed (strict value validation, not just presence)
    const memoCheck = requireMemoEnforcement(parsed.data.destination, memo);
    if (!memoCheck.ok) {
      setFormError(memoCheck.reason);
      return;
    }

    // a self-hosted deployment doesn't run the exchange mediator, so it can't
    // safely route a close to a memo-required exchange: refuse up front rather
    // than fail late at the mediator step (this is the documented self-hosted
    // safety guarantee).
    if (useMediator && getPublicEnv().NEXT_PUBLIC_DEPLOYMENT_MODE === "self-hosted") {
      setFormError(
        "This self-hosted deployment doesn't run the exchange mediator, so it can't route a close " +
          "to a memo-required exchange. Withdraw to a self-custody address instead.",
      );
      return;
    }

    // A shared account is always closed the same way: the initiator signs with
    // their own key, the reviewed close is built as ONE deterministic bundled
    // transaction (no market sell that could sink the signed bundle) and, after
    // Review, published as a signing request the other signers add signatures
    // to. When what's already known rules that out, refuse rather than start.
    if (multisigRequired) {
      const known =
        audit !== null && audit.accountId === publicKey
          ? assessSigningRequest({
              positions: ctx.positions,
              allowanceCount: ctx.allowances.length,
              useMediator,
              heldTokensSelected: selectedHeldTokens.length,
              tree: null,
              deterministic: true,
            })
          : configureGate;
      if (!known.ok) {
        setFormError(
          known.reason ??
            "This shared account's close can't be bundled into a single signing request.",
        );
        return;
      }
    }

    startRun({
      publicKey,
      network,
      connector: connectorRef.current,
      destination: parsed.data.destination,
      useMediator,
      ...(memo ? { memo } : {}),
      ...(form.selectedCbIds.length > 0 ? { selectedClaimableBalanceIds: form.selectedCbIds } : {}),
      ...(form.returnToIssuer.length > 0 ? { returnToIssuerAssetKeys: form.returnToIssuer } : {}),
      ...(form.sendToDestination.length > 0
        ? { sendToDestinationAssetKeys: form.sendToDestination }
        : {}),
      ...(selectedHeldTokens.length > 0 ? { selectedHeldTokens } : {}),
      ...(convertHeldTokensToXLM && selectedHeldTokens.length > 0
        ? { convertHeldTokensToXLM: true }
        : {}),
      // the signing-request path signs ONE bundled transaction, so it can't rely
      // on a market sell: force deterministic disposal so the reviewed plan is
      // exactly the transaction every signer signs
      ...(multisigRequired ? { deterministicDisposal: true } : {}),
    });
  }, [
    form,
    publicKey,
    network,
    useMediator,
    multisigRequired,
    audit,
    ctx.positions,
    ctx.allowances,
    configureGate,
    selectedHeldTokens,
    convertHeldTokensToXLM,
    startRun,
  ]);

  // resume a stored signing request: rebuild the close from the inputs it was
  // built with; the request is only reused if the rebuilt plan matches it
  const onResumeRequest = useCallback(
    (record: StoredSigningRequest) => {
      if (!publicKey || !connectorRef.current) {
        setFormError("Connect a wallet first.");
        return;
      }
      const connector = connectorRef.current;
      void signing.resume(record, (r) => {
        setForm({
          ...INITIAL_FORM,
          destination: r.destination,
          memoType: r.memo?.type ?? "none",
          memoValue: r.memo?.value ?? "",
          selectedCbIds: [...r.selectedCbIds],
          returnToIssuer: [...r.returnToIssuer],
          sendToDestination: [...r.sendToDestination],
        });
        startRun({
          publicKey,
          network,
          connector,
          destination: r.destination,
          useMediator: false,
          ...(r.memo ? { memo: r.memo } : {}),
          ...(r.selectedCbIds.length > 0 ? { selectedClaimableBalanceIds: r.selectedCbIds } : {}),
          ...(r.returnToIssuer.length > 0 ? { returnToIssuerAssetKeys: r.returnToIssuer } : {}),
          ...(r.sendToDestination.length > 0
            ? { sendToDestinationAssetKeys: r.sendToDestination }
            : {}),
          deterministicDisposal: true,
        });
      });
    },
    [publicKey, network, signing, startRun],
  );

  // Back from the first confirmation stage returns to Configure with the form
  // as it was: the plan is discarded (cancel), then the run is reset to idle.
  // Nothing else cancels a run by hand, so a cancelled run on screen always
  // came from the run guard (wallet or network changed).
  const onBackToConfigure = useCallback(() => {
    setShowConfirmDialog(false);
    signing.reset();
    send({ type: "CANCEL" });
    send({ type: "RESET" });
  }, [send, signing]);

  const onReset = useCallback(() => {
    setShowConfirmDialog(false);
    setForm(INITIAL_FORM);
    setSelectedHeldTokens([]);
    setConvertHeldTokensToXLM(false);
    setPrefilledAuditId(null);
    setFormError(null);
    signing.reset();
    // the account we operated on is gone (merged) or abandoned, fully drop the
    // connection so "Start over" returns to Connect, not Configure with a dead
    // account still selected. disconnectSession tears down the connector + kit +
    // store.
    setConnector(null);
    void disconnectSession(disconnectWallet);
    send({ type: "RESET" });
  }, [send, setConnector, disconnectWallet, signing]);

  // start over after a cancel: back to Configure for the same connection
  const onStartOverAfterCancel = useCallback(() => {
    signing.reset();
    send({ type: "RESET" });
  }, [send, signing]);

  const onRetry = useCallback(() => {
    if (runMismatched) return;
    send({ type: "RETRY" });
  }, [send, runMismatched]);

  const onSetResidueDisposal = useCallback(
    (key: string, mode: "none" | "issuer" | "destination") => {
      setForm((f) => {
        const issuer = new Set(f.returnToIssuer);
        const dest = new Set(f.sendToDestination);
        // a balance goes to at most one place; clear both, then set the choice
        issuer.delete(key);
        dest.delete(key);
        if (mode === "issuer") issuer.add(key);
        else if (mode === "destination") dest.add(key);
        return { ...f, returnToIssuer: [...issuer], sendToDestination: [...dest] };
      });
    },
    [],
  );

  useEffect(() => {
    return () => {
      connectorRef.current = null;
    };
  }, []);

  // only balances claimable NOW are pre-checked, an unclaimable one would fail
  // on-chain, so the user must consciously leave it out (or wait).
  if (
    audit &&
    audit.claimableBalances.length > 0 &&
    prefilledAuditId !== audit.accountId &&
    form.selectedCbIds.length === 0
  ) {
    const claimableIds = audit.claimableBalances
      .filter((cb) => cb.claimableNow !== false)
      .map((cb) => cb.id);
    setForm((f) => ({ ...f, selectedCbIds: claimableIds }));
    setPrefilledAuditId(audit.accountId);
  }

  // plan in execution order; groups are consecutive runs of one phase
  const orderedNodes = useMemo(() => (tree ? topologicalOrder(tree) : []), [tree]);
  const planGroups = useMemo(() => groupPlanNodes(orderedNodes), [orderedNodes]);
  const activeCount = orderedNodes.length;
  const doneCount = orderedNodes.filter(
    (n) => n.status === "confirmed" || n.status === "skipped",
  ).length;
  const failedInMediator = isFailed && failureNoteFor(tree).kind === "in-mediator";
  const finalNode = tree?.allNodes.get("final-classic-tx");
  const mergeHash = finalNode?.executed?.txHash;

  // the destination and memo the run was built with; the form can drift from it
  const runDestination = runInput?.destination ?? form.destination.trim();
  const runMemo = runInput?.memo ?? null;
  const hasMemo = parseMemo(form) !== undefined;
  const destination = form.destination.trim();
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

  const signingMode: SigningMode =
    ctx.signedBundleXdr !== null
      ? "bundle"
      : runInput?.connector.kind === "secret"
        ? "secret"
        : "wallet";

  // token choices made on the Warnings step only reach the plan by a rebuild
  const rebuildRequired =
    runInput !== null &&
    !multisigRequired &&
    heldSelectionDirty(selectedHeldTokens, convertHeldTokensToXLM, runInput)
      ? "Your token choices aren't in the plan yet. Rebuild the plan to apply them before continuing."
      : null;

  const preflightView: PreflightView =
    preflight.status === "error"
      ? { status: "error", message: preflight.message, retry: retryPreflight }
      : preflight.status === "ready"
        ? { status: "ready" }
        : { status: "loading" };

  const configureCommon = {
    form,
    setForm,
    cex,
    hasMemo,
    formError,
    onGeneratePlan: onStart,
    audit,
    isDemo,
    preflight: preflightView,
    destinationInvalid: destinationGate.hint !== null,
  } as const;

  // the confirm-dialog and Collect actions refuse a plan whose account or
  // network no longer match (the guard also cancels it). Each event also names
  // the account and network on screen, so the machine can refuse one that
  // doesn't match the run it holds.
  const expected = { publicKey: publicKey ?? "", networkId: network.id };
  const confirmClose = (typed: string): void => {
    setShowConfirmDialog(false);
    if (runMismatched) return;
    const event = { type: "CONFIRM" as const, typed, expected };
    send(event);
  };

  // ────────────────────────────────────────────────────────────────────────────

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 24px 96px" }}>
      {/* SEC-01 part B: offer to resume an interrupted exchange forward, if any.
          A run that failed inside the helper account shows its own resume in the
          status widget, so this one steps aside to avoid two resume buttons. */}
      {!failedInMediator ? <PendingForwardBanner publicKey={publicKey} /> : null}

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
      {!isIdle && isImmutableBlock ? <AuthImmutableBlock onDismiss={onReset} /> : null}
      {!isIdle && !isImmutableBlock && isSponsorBlock ? (
        // hard mode only, foreign sponsorships the batcher can't auto-revoke
        <SponsoringBlock
          numSponsoring={numSponsoring}
          coverable={numCoverable}
          onDismiss={onReset}
          // onProceed never fires in hard mode (button isn't rendered) but the
          // component still requires the prop; pass a no-op
          onProceed={onReset}
        />
      ) : null}

      {/* FLOW */}
      {showFlow ? (
        <>
          {/* persistent page heading for assistive tech, the flow panels below
              are h2s; this keeps a single h1 per screen */}
          <h1 style={SR_ONLY}>Close a Stellar account</h1>
          <StepIndicator steps={flowSteps} />
          {/* announces the current step to screen readers when the panel changes */}
          <div aria-live="polite" style={SR_ONLY}>
            {(() => {
              const active = flowSteps.find((s) => s.isActive);
              return active ? `Now on step: ${active.label}` : "";
            })()}
          </div>

          {/* during discover/preview, take over the whole row with a single
              centered loading widget. Shown whatever tree the context still
              holds, so a rebuild or a rediscovering retry never renders blank. */}
          {isDiscovering || isPreviewing ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              <LeftLoadingCard message={isDiscovering ? "Auditing account…" : "Building plan…"} />
            </div>
          ) : null}

          {/* execute / succeeded / failed all collapse to a single centered
              widget. one card lifecycle: header morphs by state (executing
              counter → success banner → failure banner), the plan tree is the
              body throughout, and the footer holds the right actions per state. */}
          {(isExecuting || isSucceeded || isFailed) && tree !== null ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              <DemolishStatusWidget
                state={isSucceeded ? "succeeded" : isFailed ? "failed" : "executing"}
                tree={tree}
                planGroups={planGroups}
                doneCount={doneCount}
                activeCount={activeCount}
                network={runNetwork}
                closedAccount={runInput?.publicKey ?? audit?.accountId ?? ""}
                destination={runDestination}
                mergeHash={mergeHash ?? null}
                delivered={delivered}
                error={ctx.error}
                signingMode={signingMode}
                retryResumes={isRetryableFailure(ctx.failureKind ?? "unknown")}
                retryDisabledReason={
                  runMismatched
                    ? "Reconnect the account and network this close was running on to retry."
                    : null
                }
                onRetry={onRetry}
                onReset={onReset}
              />
            </div>
          ) : null}

          {/* A failure BEFORE any plan tree exists (audit / discovery error, e.g.
              the connected account has no record on the selected network). */}
          {isFailed && tree === null ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Notice tone="danger" title="Couldn't prepare this close">
                  {ctx.error ?? "Something went wrong before the plan could be built."}
                  {ctx.error?.includes("not found on this network") ? (
                    <span style={{ display: "block", marginTop: 8, color: "var(--fg-2)" }}>
                      This account has no record on the {runNetwork.id} network. Check the network
                      selector (top right) and make sure the account is funded there, then try
                      again.
                    </span>
                  ) : null}
                </Notice>
                <div style={{ display: "flex", gap: 10 }}>
                  <Button
                    variant="secondary"
                    onClick={onRetry}
                    disabled={runMismatched}
                    data-testid="preflight-retry"
                  >
                    Try again
                  </Button>
                  <Button variant="ghost" onClick={onReset} data-testid="preflight-reset">
                    Start over
                  </Button>
                </div>
              </Card>
            </div>
          ) : null}

          {/* single-column flow content, configure / review / sign-off / cancelled. */}
          {!(isDiscovering || isPreviewing) && !isExecuting && !isSucceeded && !isFailed ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              {/* refusals from a rebuild (Resolve, the token card, Warnings)
                  land here; Configure shows its own */}
              {formError !== null && !isConfiguring ? (
                <p
                  role="alert"
                  data-testid="flow-error"
                  style={{
                    margin: "0 0 14px",
                    padding: "11px 13px",
                    borderRadius: 11,
                    border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
                    fontSize: 13,
                    color: "var(--danger)",
                  }}
                >
                  {formError}
                </p>
              ) : null}

              {collecting && activeRequest !== null && audit !== null ? (
                /* the Signatures step: the reviewed close was published; collect
                   the other signatures live here, then the initiator closes. /sign
                   is the page the OTHER signers open. */
                <>
                  {signing.notStored ? (
                    <p
                      role="status"
                      style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--warning)" }}
                    >
                      This browser can&apos;t store the request, so keep this tab open until it
                      closes.
                    </p>
                  ) : null}
                  <CollectSignatures
                    planId={activeRequest.planId}
                    audit={audit}
                    network={runNetwork}
                    initialXdr={activeRequest.xdr}
                    destination={runDestination}
                    connectedKey={publicKey}
                    onClose={(finalXdr) => {
                      if (runMismatched) return;
                      const event = {
                        type: "SUBMIT_BUNDLE" as const,
                        signedXdr: finalXdr,
                        expected,
                      };
                      send(event);
                    }}
                  />
                </>
              ) : (
                <>
                  {isConfiguring && signing.stored !== null ? (
                    <ResumeRequestCard
                      record={signing.stored}
                      busy={signing.resumeBusy}
                      error={signing.resumeError}
                      onResume={() => onResumeRequest(signing.stored!)}
                      onDiscard={signing.discardStored}
                    />
                  ) : null}

                  {isConfiguring ? (
                    /* one panel for both account kinds, so it isn't remounted (and
                       the focused input lost) when the shared-account check lands */
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                      {multisigRequired ? (
                        /* shared account: configure the close here (no signer keys
                           asked at this step). After Review it's published as a
                           signing request and the other signatures are collected in
                           the dedicated Signatures step. */
                        <>
                          <MultisigContextBar
                            threshold={effectiveMultisig?.threshold ?? 0}
                            have={primaryWeight}
                            signers={effectiveMultisig?.signers ?? []}
                          />
                          <p
                            style={{
                              margin: 0,
                              fontSize: 12.5,
                              lineHeight: 1.5,
                              color: "var(--fg-3)",
                            }}
                          >
                            You&apos;ll gather the other signatures after you review the close, no
                            signer keys needed here.
                          </p>
                        </>
                      ) : null}
                      {audit && numCoverable > 0 ? (
                        <SponsorshipAutoRevokeNotice count={numCoverable} />
                      ) : null}
                      <ConfigurePanel
                        {...configureCommon}
                        deterministic={multisigRequired}
                        canStart={
                          publicKey !== null &&
                          hasConnector &&
                          destinationGate.ready &&
                          destExistsGate.ready &&
                          memoGate.ready &&
                          (!multisigRequired || configureGate.ok)
                        }
                        startHint={
                          publicKey === null || !hasConnector
                            ? "Connect a wallet to continue."
                            : multisigRequired && !configureGate.ok
                              ? (configureGate.reason ??
                                "This shared account's close can't be gathered into one signing request.")
                              : (destinationGate.hint ?? destExistsGate.hint ?? memoGate.hint)
                        }
                      />
                    </div>
                  ) : null}

                  {isAwaitingConfirmation && signing.resumeMismatch !== null ? (
                    <Notice tone="warning" title="This signing request can't be reused">
                      {signing.resumeMismatch}
                      <div style={{ marginTop: 10 }}>
                        <Button variant="secondary" onClick={signing.discardStored}>
                          Discard it
                        </Button>
                      </div>
                    </Notice>
                  ) : null}

                  {/* RESOLVE, actions only: blockers that need a return-to-issuer
                      choice + rebuild. Rebuild is gated until every one is resolved. */}
                  {isResolve ? (
                    <ResolvePanel
                      credits={ctx.unroutableCredits}
                      network={runNetwork}
                      returnToIssuer={form.returnToIssuer}
                      sendToDestination={form.sendToDestination}
                      onSetDisposal={onSetResidueDisposal}
                      onRebuild={onStart}
                      onBack={onBackToConfigure}
                    />
                  ) : null}

                  {/* ACKNOWLEDGE, information only: read-and-understand each warning /
                      info card. Continue is gated until all are acknowledged. */}
                  {isAcknowledge && audit !== null ? (
                    <AcknowledgePanel
                      network={runNetwork}
                      scamFindings={scamFindings}
                      discoveryWarnings={ctx.discoveryWarnings}
                      claimables={claimables}
                      sponsorshipCount={numCoverable}
                      baseReserveStroops={baseReserveStroops}
                      highValue={isHighValue ? { totalXlm } : null}
                      tokensSlot={
                        !showTokenSection ? undefined : multisigRequired ? (
                          <SharedTokensNotice
                            count={ctx.heldTokens.length + ctx.unreadableHeldTokens.length}
                            scanFailed={ctx.heldTokenScanFailed}
                          />
                        ) : (
                          <StandaloneTokensCard
                            discovered={ctx.heldTokens}
                            unreadable={ctx.unreadableHeldTokens}
                            selected={selectedHeldTokens}
                            onChange={setSelectedHeldTokens}
                            network={runNetwork}
                            userPublicKey={publicKey}
                            isCex={runInput?.useMediator ?? useMediator}
                            onRebuild={onStart}
                            convertToXLM={convertHeldTokensToXLM}
                            onConvertToXLMChange={setConvertHeldTokensToXLM}
                          />
                        )
                      }
                      rebuildRequired={rebuildRequired}
                      onRebuild={onStart}
                      onBack={hasBlocker ? () => setConfirmStage("resolve") : onBackToConfigure}
                      onContinue={() => setConfirmStage("review")}
                    />
                  ) : null}

                  {/* REVIEW, the clean "here is what will happen": plan overview,
                      every operation, destination. */}
                  {isReview && audit !== null && runInput !== null ? (
                    <ReviewPanel
                      planGroups={planGroups}
                      audit={audit}
                      baseReserveStroops={baseReserveStroops}
                      destination={runInput.destination}
                      memo={runMemo}
                      useMediator={runInput.useMediator}
                      deterministic={runInput.deterministicDisposal === true}
                      network={runNetwork}
                      onBack={
                        hasAckItems
                          ? () => setConfirmStage("acknowledge")
                          : hasBlocker
                            ? () => setConfirmStage("resolve")
                            : onBackToConfigure
                      }
                      onDemolish={() => setShowConfirmDialog(true)}
                      {...(multisigRequired
                        ? {
                            shared: {
                              gate: signingGate,
                              claimRisks,
                              onCreate: () => void signing.create(),
                              creating: signing.creating,
                              error: signing.error,
                              ...(runInput.deterministicDisposal !== true
                                ? { onRebuildShared: onStart }
                                : {}),
                            },
                          }
                        : {})}
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
                      onStartOver={onStartOverAfterCancel}
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
              onCancel={() => setShowConfirmDialog(false)}
              onConfirm={confirmClose}
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
    </main>
  );
}

// a shared account's close is one bundled classic transaction, so it can't move
// standalone tokens (each needs its own transaction); say so instead of offering
// a sweep the signing request would drop
function SharedTokensNotice({
  count,
  scanFailed,
}: {
  readonly count: number;
  readonly scanFailed: boolean;
}): React.JSX.Element {
  return (
    <Notice tone="warning" title="Standalone tokens stay on this account" role="status">
      {count > 0
        ? `This account holds ${count} standalone token${count === 1 ? "" : "s"} (custom SEP-41 tokens). `
        : "The scan for standalone tokens couldn't finish, so some may not be listed. "}
      A signing request closes the account in one transaction, which can&apos;t move them. Move them
      out with all signers first, or they stay on the deleted account.
      {scanFailed && count > 0 ? " The scan didn't finish, so there may be more." : ""}
    </Notice>
  );
}

function ResumeRequestCard({
  record,
  busy,
  error,
  onResume,
  onDiscard,
}: {
  readonly record: StoredSigningRequest;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onResume: () => void;
  readonly onDiscard: () => void;
}): React.JSX.Element {
  return (
    <Notice
      tone="neutral"
      title="You have a signing request in progress"
      data-testid="resume-signing-request"
    >
      A close of this account to {record.destination.slice(0, 6)}…{record.destination.slice(-4)} was
      published for co-signers on{" "}
      {new Date(record.createdAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
      {record.validUntil !== null
        ? ` and stays valid until ${new Date(record.validUntil).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}`
        : ""}
      . Resume it to keep collecting the signatures already given.
      {error !== null ? (
        <div role="alert" style={{ marginTop: 8, color: "var(--danger)", fontSize: 12.5 }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <Button onClick={onResume} loading={busy} disabled={busy} data-testid="resume-request">
          {busy ? "Loading…" : "Resume signing request"}
        </Button>
        <Button variant="ghost" onClick={onDiscard} data-testid="discard-request">
          Discard
        </Button>
      </div>
    </Notice>
  );
}
