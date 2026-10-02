"use client";

import { useMachine } from "@xstate/react";
import { StrKey } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, Card, Notice } from "@/components/ui";
import { TypedConfirmation } from "@/components/confirmations/TypedConfirmation";
import { AuthImmutableBlock } from "@/components/warnings/AuthImmutableBlock";
import { PendingForwardBanner } from "@/components/wallet/PendingForwardBanner";
import { StandaloneTokensCard } from "@/components/wallet/StandaloneTokensCard";
import type { HeldToken } from "@/lib/soroban/held-tokens";
import { SponsoringBlock } from "@/components/warnings/SponsoringBlock";
import { CollectSignatures } from "@/components/multisig/CollectSignatures";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl } from "@/lib/explorer";
import { useNetworkStore } from "@/stores/network";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { trackClose, trackFunnel, trackVisit } from "@/lib/metrics/beacon";
import { pageFlowMachine } from "@/lib/orchestrator/page-flow-machine";
import { getPublicEnv } from "@/lib/config/env";
import { publishPlan } from "@/lib/multisig/plan-client";
import {
  assessBundleability,
  buildCloseTransaction,
  type CloseDisposal,
} from "@/lib/multisig/signing-request";
import { auditAccount } from "@/lib/stellar/account-audit";
import { getHorizon } from "@/lib/stellar/horizon-client";
import {
  lookupCex,
  requireMemoEnforcement,
  validateMemoFormat,
  type CexInfo,
} from "@/lib/safety/cex-registry";
import { runScamHeuristics } from "@/lib/safety/scam-heuristics";
import { isHighValueTotalXlm } from "@/lib/safety/high-value";
import { topologicalOrder } from "@/lib/plan/tree";
import type { AuditSigner } from "@/lib/types/account";
import type { Connector } from "@/lib/wallet/connector";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { disconnectSession, getActiveConnector } from "@/lib/wallet/active-connector";
import { useWalletStore } from "@/stores/wallet";

import { SR_ONLY } from "../_lib/a11y";
import { buildFlowSteps, type FlowPhase } from "../_lib/flow-steps";
import { FORM_SCHEMA, G_ADDRESS, INITIAL_FORM, parseMemo, type FormState } from "../_lib/form";
import { countTrustlines, groupPlanNodes, sumNativeBalance } from "../_lib/plan-copy";
import { AcknowledgePanel } from "./AcknowledgePanel";
import { CancelledPanel } from "./CancelledPanel";
import { ConfigurePanel } from "./ConfigurePanel";
import { IdleConnect } from "./IdleConnect";
import { LeftLoadingCard } from "./LoadingCard";
import { MultisigContextBar } from "./MultisigContextBar";
import { ResolvePanel } from "./ResolvePanel";
import { ReviewPanel } from "./ReviewPanel";
import { SponsorshipAutoRevokeNotice } from "./SponsorshipAutoRevokeNotice";
import { DemolishStatusWidget } from "./StatusWidget";
import { StepIndicator } from "./StepIndicator";

export function DemolishFlow(): React.JSX.Element {
  const connectorRef = useRef<Connector | null>(null);
  const publicKey = useWalletStore((s) => s.publicKey);
  const connectorKind = useWalletStore((s) => s.connectorKind);
  const isDemo = useWalletStore((s) => s.isDemo);
  const disconnectWallet = useWalletStore((s) => s.disconnect);

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

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  // standalone SEP-41 tokens the user opted in to sweep (discovered ones they
  // ticked + any added by contract id). Kept OUTSIDE the zod form because each
  // carries a bigint balance; default empty so nothing is swept without a choice.
  const [selectedHeldTokens, setSelectedHeldTokens] = useState<readonly HeldToken[]>([]);
  // opt-in: convert the opted-in held tokens to XLM (Soroswap-router swap) instead
  // of transferring them as-is. Default off — transfer-as-is preserves the exact
  // token and can't be defeated by an illiquid/unroutable one.
  const [convertHeldTokensToXLM, setConvertHeldTokensToXLM] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // multisig: preflight the connected account for its signature threshold, then
  // collect additional signer secret keys until the combined weight meets it.
  const [multisig, setMultisig] = useState<{
    readonly required: boolean;
    readonly threshold: number;
    readonly signers: readonly AuditSigner[];
  } | null>(null);
  // preflight the connected account so the configure step knows up-front whether
  // it needs multiple signatures (a lightweight, read-only audit). Disconnect
  // resets are handled in setConnector, so the effect only does the async load.
  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    auditAccount(publicKey, network)
      .then((a) => {
        if (cancelled) return;
        setMultisig({
          required: a.requiresMultisig,
          threshold: a.thresholds.high,
          signers: a.signers,
        });
      })
      .catch(() => {
        if (!cancelled) setMultisig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey, network]);

  // the awaiting_confirmation phase has three stages:
  //  "resolve"    , take an action on a blocker (return-to-issuer) + rebuild
  //  "acknowledge", read-and-understand every warning / info card
  //  "review"     , the clean "here is what will happen" review + demolish
  // the stage is initialised per built plan (below), skipping any empty step.
  type ConfirmStage = "resolve" | "acknowledge" | "review";
  const [confirmStage, setConfirmStage] = useState<ConfirmStage>("review");
  // the final typed-confirmation dialog, opened from the review step
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const [snapshot, send] = useMachine(pageFlowMachine);
  const state = snapshot.value;
  const ctx = snapshot.context;

  const audit = ctx.audit;
  const tree = ctx.tree;

  // prefer the AUTHORITATIVE discovery audit once it's available: the preflight
  // above is only a best-effort head start and can silently fail, which would
  // otherwise mis-classify a shared account as single-signer. ctx.audit is the
  // audit the plan is actually built from.
  const effectiveMultisig = useMemo(() => {
    if (audit) {
      return {
        required: audit.requiresMultisig,
        threshold: audit.thresholds.high,
        signers: audit.signers,
      };
    }
    return multisig;
  }, [audit, multisig]);

  // the initiator's own signing weight on the shared account (their key alone)
  const primaryWeight = useMemo(() => {
    if (!effectiveMultisig || !publicKey) return 0;
    return effectiveMultisig.signers.find((s) => s.key === publicKey)?.weight ?? 0;
  }, [effectiveMultisig, publicKey]);
  const multisigRequired = publicKey !== null && effectiveMultisig?.required === true;

  // scam heuristics over the account's held credit balances (look-alike symbols,
  // homoglyphs, off-allowlist contracts), surfaced as an informational notice.
  const scamFindings = useMemo(
    () => (audit ? runScamHeuristics(audit.balances, network.id) : []),
    [audit, network.id],
  );

  const isMachineIdle = state === "idle";
  const isDiscovering = state === "discovering";
  const isPreviewing = state === "previewing";
  const isAwaitingConfirmation = state === "awaiting_confirmation";
  const isExecuting = state === "executing";
  const isSucceeded = state === "succeeded";
  const isFailed = state === "failed";

  // ── usage metrics (aggregate, no PII) ──────────────────────────────────────
  // one page-view on mount, then one beacon per funnel milestone and one for the
  // verified close (its on-chain merge hash) as the machine advances. Each fires
  // at most once per mount; all are fire-and-forget and never affect the flow.
  const metricsSentRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const once = (key: string, fn: () => void): void => {
      if (metricsSentRef.current.has(key)) return;
      metricsSentRef.current.add(key);
      fn();
    };
    const net = network.id;
    once("visit", () => trackVisit("demolish", net));
    if (publicKey) once("wallet_connected", () => trackFunnel(net, "wallet_connected"));
    if (isPreviewing) once("discovery_completed", () => trackFunnel(net, "discovery_completed"));
    if (isAwaitingConfirmation) once("plan_built", () => trackFunnel(net, "plan_built"));
    if (isExecuting) once("close_started", () => trackFunnel(net, "close_started"));
    if (isSucceeded && ctx.result?.ok && ctx.result.mergedTxHash) {
      const hash = ctx.result.mergedTxHash;
      once("close_completed", () => trackClose(net, hash));
    }
  }, [
    publicKey,
    isPreviewing,
    isAwaitingConfirmation,
    isExecuting,
    isSucceeded,
    ctx.result,
    network.id,
  ]);
  const isCancelled = state === "cancelled";

  // Abort the close if the wallet is torn down while parked at the confirmation
  // step (the user hit Disconnect, or switched network — which disconnects the
  // session). Without this the machine keeps its plan and the Review panel + the
  // confirm button stay live, so a secret-key/demo connector (whose disconnect is a
  // no-op and whose instance is retained in the machine context) would still run
  // the irreversible merge on CONFIRM, on the old network. Leaving the confirmation
  // state makes CONFIRM inert until the user reconnects and rebuilds the plan.
  useEffect(() => {
    if (publicKey === null && isAwaitingConfirmation) {
      send({ type: "CANCEL" });
    }
  }, [publicKey, isAwaitingConfirmation, send]);

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

  // two distinct concerns, kept as separate steps:
  //  - a BLOCKER (un-routable balance) needs an ACTION + rebuild  → "resolve"
  //  - warnings / info need only READ-AND-UNDERSTAND               → "acknowledge"
  const hasBlocker = ctx.unroutableCredits.length > 0;
  const hasScam = scamFindings.length > 0;
  const hasDiscovery = ctx.discoveryWarnings.length > 0;
  const hasAutoHandled = audit !== null && (audit.claimableBalances.length > 0 || numCoverable > 0);
  // the standalone-token section belongs with the warnings (it's about funds that
  // could be left behind). Show it whenever there's a real reason to look: tokens
  // found, unreadable candidates, or the optional scan couldn't finish (so the
  // manual add-a-token is still reachable). A clean, complete scan doesn't nag.
  const showTokenSection =
    ctx.heldTokens.length > 0 || ctx.unreadableHeldTokens.length > 0 || ctx.heldTokenScanFailed;
  const hasAckItems = hasScam || hasDiscovery || hasAutoHandled || isHighValue || showTokenSection;

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

  // configure = no tree yet (either before START, or after a CANCEL that returned us to cancelled)
  const isConfiguring = !blocked && publicKey !== null && tree === null;
  // the three awaiting_confirmation stages, gated on the tree being present
  const inConfirmation = !blocked && tree !== null && isAwaitingConfirmation;
  const isResolve = inConfirmation && confirmStage === "resolve";
  const isAcknowledge = inConfirmation && confirmStage === "acknowledge";
  const isReview = inConfirmation && confirmStage === "review";
  const showFlow = !isIdle && !blocked;

  // current flow phase for the step indicator
  const flowPhase: FlowPhase = !showFlow
    ? "connect"
    : isExecuting || isSucceeded || isFailed
      ? "execute"
      : tree === null
        ? "configure"
        : confirmStage === "resolve"
          ? "resolve"
          : confirmStage === "acknowledge"
            ? "acknowledge"
            : "review";

  // step indicator. Resolve/Acknowledge are only decided once the plan is built
  // (tree !== null), during "Building plan…" the tree is null and
  // unroutableCredits is empty, so computing them then would briefly show
  // Acknowledge before the built plan reveals a blocker and flips to Resolve.
  // And Acknowledge stays hidden while a blocker is unresolved, since returning a
  // token to its issuer can drop that token's warnings after the rebuild.
  // set once the initiator turns the reviewed close into a signing request (their
  // key already signed, published to the relay); the Collect step then renders in
  // place of Review. `id` is the relay handle; `xdr` seeds the initial view.
  const [signingRequestId, setSigningRequestId] = useState<string | null>(null);
  const [signingRequestXdr, setSigningRequestXdr] = useState<string | null>(null);
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [createRequestError, setCreateRequestError] = useState<string | null>(null);

  const planBuilt = tree !== null;
  // the Signatures step is active only while still gathering signatures (machine
  // parked at awaiting_confirmation); once the bundle is submitted the machine
  // moves to executing/succeeded and the Close step takes over, same as any close.
  const collecting = signingRequestId !== null && isAwaitingConfirmation;
  const flowSteps = useMemo(
    () =>
      buildFlowSteps({
        phase: flowPhase,
        hasResolve: planBuilt && hasBlocker,
        hasAcknowledge: planBuilt && hasAckItems && !hasBlocker,
        isSucceeded,
        hasCollect: multisigRequired,
        collecting,
      }),
    [flowPhase, planBuilt, hasBlocker, hasAckItems, isSucceeded, multisigRequired, collecting],
  );

  // cex / mediator
  const cex: CexInfo | null = useMemo(() => {
    const trimmed = form.destination.trim();
    if (trimmed.length === 0) return null;
    return lookupCex(trimmed);
  }, [form.destination]);

  // gate the "Build & simulate" button on a usable destination so the user gets
  // immediate feedback instead of being able to proceed and only then hit an
  // error. Empty is left hint-free (self-evident); a bad or self address is
  // explained inline. (onStart still re-validates as the authoritative check.)
  const destinationGate = useMemo<{ ready: boolean; hint: string | null }>(() => {
    const trimmed = form.destination.trim();
    if (trimmed.length === 0) return { ready: false, hint: null };
    if (!G_ADDRESS.safeParse(trimmed).success) {
      return { ready: false, hint: "That isn't a valid Stellar G… address." };
    }
    if (trimmed === publicKey) {
      return {
        ready: false,
        hint: "Destination can't be your own account, the network rejects a self-merge.",
      };
    }
    return { ready: true, hint: null };
  }, [form.destination, publicKey]);
  const useMediator = cex !== null;

  // Existence check for the destination. ACCOUNT_MERGE (and, on the exchange path,
  // the mediator's forward payment) fails if the destination account does not
  // exist on-chain, and that failure only surfaces at the final, irreversible step
  // AFTER the DeFi exits have already run. So verify up-front that the destination
  // exists and block the close until it does, instead of failing late. Debounced,
  // and keyed to the address so a stale in-flight result can't leak onto a newer
  // one. A transient (non-404) read error does not hard-block (the merge would
  // still fail loudly); only a confirmed "missing" (404) blocks.
  const [destCheck, setDestCheck] = useState<{
    addr: string;
    state: "checking" | "exists" | "missing" | "error";
  } | null>(null);
  useEffect(() => {
    const trimmed = form.destination.trim();
    // invalid / self address: destinationGate owns the gate; leave destCheck as
    // is (destExistsGate defers to destinationGate for these). Setting state
    // synchronously in an effect body is a cascading-render smell, so every
    // setDestCheck below runs inside the debounce timer / async resolution.
    if (!G_ADDRESS.safeParse(trimmed).success || trimmed === publicKey) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setDestCheck({ addr: trimmed, state: "checking" });
      void getHorizon(network)
        .loadAccount(trimmed)
        .then(() => {
          if (!cancelled) setDestCheck({ addr: trimmed, state: "exists" });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const e = err as { response?: { status?: number }; name?: string; message?: string };
          const notFound =
            e?.response?.status === 404 ||
            e?.name === "NotFoundError" ||
            /404|not[_ ]?found|resource missing/i.test(e?.message ?? "");
          setDestCheck({ addr: trimmed, state: notFound ? "missing" : "error" });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form.destination, publicKey, network]);

  const destExistsGate = useMemo<{ ready: boolean; hint: string | null }>(() => {
    const trimmed = form.destination.trim();
    // defer to destinationGate until the address is well-formed and not self
    if (!G_ADDRESS.safeParse(trimmed).success || trimmed === publicKey) {
      return { ready: true, hint: null };
    }
    if (!destCheck || destCheck.addr !== trimmed || destCheck.state === "checking") {
      return { ready: false, hint: "Checking the destination account…" };
    }
    if (destCheck.state === "missing") {
      return {
        ready: false,
        hint: "This destination account doesn't exist on the network yet. A close merges into it, which needs an existing, funded account. Fund it first, or use a different address.",
      };
    }
    return { ready: true, hint: null };
  }, [form.destination, publicKey, destCheck]);

  // gate the Continue CTA on a required exchange memo (and a well-formed memo
  // value), so the requirement shows inline instead of bouncing the user back
  // after they press Continue. Reuses the exact checks onStart runs
  // (validateMemoFormat + requireMemoEnforcement) so the gate and the submit path
  // can never disagree. Only engages once the destination itself is valid; until
  // then destinationGate owns the hint.
  const memoGate = useMemo<{ ready: boolean; hint: string | null }>(() => {
    const trimmed = form.destination.trim();
    if (!G_ADDRESS.safeParse(trimmed).success) return { ready: true, hint: null };
    const memo = parseMemo(form);
    if (memo !== undefined) {
      const formatError = validateMemoFormat(memo.type, memo.value);
      if (formatError !== null) return { ready: false, hint: formatError };
    }
    const check = requireMemoEnforcement(trimmed, memo);
    if (!check.ok) return { ready: false, hint: check.reason };
    return { ready: true, hint: null };
  }, [form]);

  // whether the account holds Soroban (smart-contract) positions. Those each need
  // their own transaction, so they can't be bundled into a single signable close.
  const hasSorobanPositions =
    ctx.positions.blend.length > 0 ||
    ctx.positions.aquarius.length > 0 ||
    ctx.positions.soroswap.length > 0 ||
    ctx.positions.fxdao.length > 0;

  // a shared account whose close fits in ONE bundled transaction can be closed by
  // collecting signatures (the signing-request path). Otherwise it can only be
  // closed live with every required key present in this browser. Allowance
  // revocations are separate Soroban transactions the bundle can't include, so an
  // account with active allowances is NOT bundleable (else the reviewed revokes
  // would be silently dropped from the signed transaction).
  const bundleability = assessBundleability({
    hasSorobanPositions,
    hasSelectedAllowances: ctx.allowances.length > 0,
    useMediator,
  });
  const canUseSigningRequest = multisigRequired && bundleability.ok;

  const setConnector = useCallback((c: Connector | null) => {
    connectorRef.current = c;
    // a new/cleared connection invalidates any in-progress signing request.
    // Use functional updates that return the SAME reference when already reset.
    // ConnectButton re-notifies every render, so a fresh `null` here would create
    // a new reference each time and spin an infinite render loop. hasConnector is
    // derived from the wallet store, so it needs no explicit set here.
    setMultisig((prev) => (prev === null ? prev : null));
    setSigningRequestId((prev) => (prev === null ? prev : null));
    setSigningRequestXdr((prev) => (prev === null ? prev : null));
  }, []);

  // once the account is closed it no longer exists, drop the connection so a
  // later navigation back to /demolish starts at Connect, not Configure with a
  // dead account. A shared close now also ends in the machine "succeeded" state
  // (the collected bundle is submitted via SUBMIT_BUNDLE), so this one guard
  // covers both flows. Cleared directly (not via setConnector) so the success
  // view, which keys off the machine/tree, stays visible. Guarded to fire once.
  const closedRef = useRef(false);
  useEffect(() => {
    if (isSucceeded && !closedRef.current) {
      closedRef.current = true;
      connectorRef.current = null;
      // full teardown (connector + kit + store): the account was merged and no
      // longer exists, so leave nothing authorized to it at the wallet level
      void disconnectSession(disconnectWallet);
    } else if (!isSucceeded && closedRef.current) {
      closedRef.current = false;
    }
  }, [isSucceeded, disconnectWallet]);

  // guard against navigating away / closing the tab mid-execution, a partial
  // run leaves the account half-dismantled. The native prompt is the strongest
  // signal the browser allows.
  useEffect(() => {
    if (!isExecuting) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isExecuting]);

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
    if (form.fallback.trim().length > 0 && !StrKey.isValidEd25519PublicKey(form.fallback.trim())) {
      setFormError("Fallback address must be a valid Stellar G... address.");
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
    // their own key, and the reviewed close is built as ONE deterministic bundled
    // transaction (no market sell that could sink the signed bundle) and, after
    // Review, published as a signing request the other signers add signatures to.
    // If the close can't be bundled into one transaction (Soroban/mediator), that
    // path is impossible, so refuse rather than start.
    if (multisigRequired && !canUseSigningRequest) {
      setFormError(
        bundleability.reason ??
          "This shared account's close can't be bundled into a single signing request.",
      );
      return;
    }

    // the signing-request path signs ONE bundled transaction, so it can't rely on
    // a market sell: force deterministic disposal so the reviewed plan is exactly
    // the transaction every signer signs.
    const deterministic = multisigRequired;

    send({
      type: "START",
      input: {
        publicKey,
        network,
        connector: connectorRef.current,
        destination: parsed.data.destination,
        useMediator,
        ...(memo ? { memo } : {}),
        ...(form.fallback.trim().length > 0 ? { userFallbackAddress: form.fallback.trim() } : {}),
        ...(form.selectedCbIds.length > 0
          ? { selectedClaimableBalanceIds: form.selectedCbIds }
          : {}),
        ...(form.returnToIssuer.length > 0 ? { returnToIssuerAssetKeys: form.returnToIssuer } : {}),
        ...(form.sendToDestination.length > 0
          ? { sendToDestinationAssetKeys: form.sendToDestination }
          : {}),
        ...(selectedHeldTokens.length > 0 ? { selectedHeldTokens } : {}),
        ...(convertHeldTokensToXLM && selectedHeldTokens.length > 0
          ? { convertHeldTokensToXLM: true }
          : {}),
        ...(deterministic ? { deterministicDisposal: true } : {}),
      },
    });
  }, [
    form,
    publicKey,
    network,
    useMediator,
    send,
    multisigRequired,
    canUseSigningRequest,
    bundleability.reason,
    selectedHeldTokens,
    convertHeldTokensToXLM,
  ]);

  const onCancel = useCallback(() => {
    setShowConfirmDialog(false);
    send({ type: "CANCEL" });
  }, [send]);

  // turn the REVIEWED close into a signing request: rebuild the exact bundled
  // transaction the user just reviewed (same audit, destination, deterministic
  // disposal), sign the initiator's part, and hand it to the Collect step. The
  // batcher inputs match the machine's deterministic preview, so what co-signers
  // sign is exactly what was reviewed.
  const onCreateRequest = useCallback(async () => {
    const a = ctx.audit;
    const connector = connectorRef.current;
    if (a === null || connector === null) return;
    setCreatingRequest(true);
    setCreateRequestError(null);
    try {
      const sourceAccount = await getHorizon(network).loadAccount(a.accountId);
      const disposal: CloseDisposal = {
        ...(form.returnToIssuer.length > 0 ? { returnToIssuerAssetKeys: form.returnToIssuer } : {}),
        ...(form.sendToDestination.length > 0
          ? { sendToDestinationAssetKeys: form.sendToDestination }
          : {}),
      };
      const tx = buildCloseTransaction({
        audit: a,
        destination: form.destination,
        network,
        sourceAccount,
        disposal,
      });
      const { signedXdr } = await connector.signTransaction(tx, network.passphrase);
      // publish to the relay so co-signers can add signatures from their own
      // devices and this page sees each one arrive live.
      const id = await publishPlan(network.id, signedXdr);
      setSigningRequestXdr(signedXdr);
      setSigningRequestId(id);
    } catch (e: unknown) {
      setCreateRequestError(errorMessage(e, "Couldn't create the signing request."));
    } finally {
      setCreatingRequest(false);
    }
  }, [ctx.audit, network, form.destination, form.returnToIssuer, form.sendToDestination]);

  const onReset = useCallback(() => {
    setShowConfirmDialog(false);
    setForm(INITIAL_FORM);
    setSelectedHeldTokens([]);
    setFormError(null);
    // the account we operated on is gone (merged) or abandoned, fully drop the
    // connection so "Start over" returns to Connect, not Configure with a dead
    // account still selected. setConnector(null) also resets multisig/signing
    // state; disconnectSession tears down the connector + kit + store.
    setConnector(null);
    void disconnectSession(disconnectWallet);
    send({ type: "RESET" });
  }, [send, setConnector, disconnectWallet]);
  const onRetry = useCallback(() => send({ type: "RETRY" }), [send]);
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

  // pre-select the claimable balances by default so the demo flow "just works".
  // only balances claimable NOW are pre-checked, an unclaimable one would fail
  // on-chain, so the user must consciously leave it out (or wait).
  const [prefilledAuditId, setPrefilledAuditId] = useState<string | null>(null);
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

  // account-side derived values used in the review summary (totalXlm/isHighValue
  // are computed earlier so the flow phase can read them)
  const acctSub = audit?.subentryCount ?? 0;
  const acctTrustlines = audit ? countTrustlines(audit) : 0;
  const acctOffers = audit?.offers.length ?? 0;
  const acctData = audit?.data.length ?? 0;
  const acctClaimable = audit?.claimableBalances.length ?? 0;

  // plan groupings
  const orderedNodes = useMemo(() => (tree ? topologicalOrder(tree) : []), [tree]);
  const planGroups = useMemo(() => groupPlanNodes(orderedNodes), [orderedNodes]);
  const activeCount = orderedNodes.length;
  const doneCount = orderedNodes.filter(
    (n) => n.status === "confirmed" || n.status === "skipped",
  ).length;
  const finalNode = tree?.allNodes.get("final-classic-tx");
  const mergeHash = finalNode?.executed?.txHash;

  const hasMemo = parseMemo(form) !== undefined;
  const destination = form.destination.trim();
  const destHead = destination.length > 4 ? destination.slice(0, -4) : "";
  const destTail = destination.length > 0 ? destination.slice(-4) : "";

  // ────────────────────────────────────────────────────────────────────────────

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 24px 96px" }}>
      {/* SEC-01 part B: offer to resume an interrupted exchange forward, if any */}
      <PendingForwardBanner publicKey={publicKey} />

      {/* IDLE, connect */}
      {isIdle ? (
        <IdleConnect
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

          {/* during the brief discover/preview transition, take over the whole
              row with a single centered loading widget, no side rail, no
              form behind it. */}
          {(isDiscovering || isPreviewing) && tree === null ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              <LeftLoadingCard message={isDiscovering ? "Auditing account…" : "Building plan…"} />
            </div>
          ) : null}

          {/* execute / succeeded / failed all collapse to a single centered
              widget. one card lifecycle: header morphs by state (executing
              counter → success banner → failure banner), the plan tree is the
              body throughout, and the footer holds the right actions per state.
              no 2-column reflow when execution finishes. */}
          {(isExecuting || isSucceeded || isFailed) && tree !== null ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              <DemolishStatusWidget
                state={isSucceeded ? "succeeded" : isFailed ? "failed" : "executing"}
                planGroups={planGroups}
                doneCount={doneCount}
                activeCount={activeCount}
                network={network}
                totalXlm={totalXlm}
                destination={destination}
                mergeHash={mergeHash ?? null}
                error={ctx.error}
                onRetry={onRetry}
                onReset={onReset}
              />
            </div>
          ) : null}

          {/* A failure BEFORE any plan tree exists (audit / discovery error, e.g.
              the connected account has no record on the selected network). The
              status widget above needs tree !== null, so without this branch the
              Close step rendered completely blank. Surface the real error and give
              a way out instead of a black screen. */}
          {isFailed && tree === null ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Notice tone="danger" title="Couldn't prepare this close">
                  {ctx.error ?? "Something went wrong before the plan could be built."}
                  {ctx.error?.includes("not found on this network") ? (
                    <span style={{ display: "block", marginTop: 8, color: "var(--fg-2)" }}>
                      This account has no record on the {network.id} network. Check the network
                      selector (top right) and make sure the account is funded there, then try
                      again.
                    </span>
                  ) : null}
                </Notice>
                <div style={{ display: "flex", gap: 10 }}>
                  <Button variant="secondary" onClick={onRetry} data-testid="preflight-retry">
                    Try again
                  </Button>
                  <Button variant="ghost" onClick={onReset} data-testid="preflight-reset">
                    Start over
                  </Button>
                </div>
              </Card>
            </div>
          ) : null}

          {/* single-column flow content, configure / review / sign-off / cancelled.
              No side rail and no modals: the plan detail lives in the sign-off step. */}
          {!(isDiscovering || isPreviewing) && !isExecuting && !isSucceeded && !isFailed ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              {signingRequestId !== null && signingRequestXdr !== null && audit !== null ? (
                /* the Signatures step: the reviewed close was published; collect
                   the other signatures live here, then the initiator closes. /sign
                   is the page the OTHER signers open. */
                <CollectSignatures
                  planId={signingRequestId}
                  audit={audit}
                  network={network}
                  initialXdr={signingRequestXdr}
                  destination={form.destination}
                  connectedKey={publicKey}
                  onClose={(finalXdr) => send({ type: "SUBMIT_BUNDLE", signedXdr: finalXdr })}
                />
              ) : (
                <>
                  {isConfiguring ? (
                    multisigRequired ? (
                      /* shared account: configure the close here (no signer keys
                         asked at this step). After Review it's published as a
                         signing request and the other signatures are collected in
                         the dedicated Signatures step. */
                      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                        <MultisigContextBar
                          threshold={effectiveMultisig?.threshold ?? 0}
                          have={primaryWeight}
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
                        {audit && numCoverable > 0 ? (
                          <SponsorshipAutoRevokeNotice count={numCoverable} />
                        ) : null}
                        <ConfigurePanel
                          form={form}
                          setForm={setForm}
                          cex={cex}
                          hasMemo={hasMemo}
                          formError={formError}
                          isBusy={false}
                          canStart={
                            publicKey !== null &&
                            hasConnector &&
                            destinationGate.ready &&
                            destExistsGate.ready &&
                            canUseSigningRequest &&
                            memoGate.ready
                          }
                          startHint={
                            publicKey === null || !hasConnector
                              ? "Connect a wallet to continue."
                              : !canUseSigningRequest
                                ? (bundleability.reason ??
                                  "This shared account's close can't be gathered into one signing request.")
                                : (destinationGate.hint ?? destExistsGate.hint ?? memoGate.hint)
                          }
                          onGeneratePlan={onStart}
                          audit={audit}
                          isDemo={isDemo}
                        />
                      </div>
                    ) : (
                      /* single-signer account */
                      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                        {audit && numCoverable > 0 ? (
                          <SponsorshipAutoRevokeNotice count={numCoverable} />
                        ) : null}
                        <ConfigurePanel
                          form={form}
                          setForm={setForm}
                          cex={cex}
                          hasMemo={hasMemo}
                          formError={formError}
                          isBusy={false}
                          canStart={
                            publicKey !== null &&
                            hasConnector &&
                            destinationGate.ready &&
                            destExistsGate.ready &&
                            memoGate.ready
                          }
                          startHint={
                            publicKey === null || !hasConnector
                              ? "Connect a wallet to continue."
                              : (destinationGate.hint ?? destExistsGate.hint ?? memoGate.hint)
                          }
                          onGeneratePlan={onStart}
                          audit={audit}
                          isDemo={isDemo}
                        />
                      </div>
                    )
                  ) : null}

                  {/* RESOLVE, actions only: blockers that need a return-to-issuer
                      choice + rebuild. Rebuild is gated until every one is resolved. */}
                  {isResolve ? (
                    <ResolvePanel
                      credits={ctx.unroutableCredits}
                      network={network}
                      returnToIssuer={form.returnToIssuer}
                      sendToDestination={form.sendToDestination}
                      onSetDisposal={onSetResidueDisposal}
                      onRebuild={onStart}
                      onBack={onCancel}
                    />
                  ) : null}

                  {/* ACKNOWLEDGE, information only: read-and-understand each warning /
                      info card. Continue is gated until all are acknowledged. */}
                  {isAcknowledge ? (
                    <AcknowledgePanel
                      network={network}
                      scamFindings={scamFindings}
                      discoveryWarnings={ctx.discoveryWarnings}
                      autoHandled={{
                        claimableCount: audit?.claimableBalances.length ?? 0,
                        sponsorshipCount: numCoverable,
                      }}
                      highValue={isHighValue ? { totalXlm } : null}
                      tokensSlot={
                        showTokenSection ? (
                          <StandaloneTokensCard
                            discovered={ctx.heldTokens}
                            unreadable={ctx.unreadableHeldTokens}
                            selected={selectedHeldTokens}
                            onChange={setSelectedHeldTokens}
                            network={network}
                            userPublicKey={publicKey}
                            isCex={useMediator}
                            onRebuild={onStart}
                            convertToXLM={convertHeldTokensToXLM}
                            onConvertToXLMChange={setConvertHeldTokensToXLM}
                          />
                        ) : undefined
                      }
                      onBack={onCancel}
                      onContinue={() => setConfirmStage("review")}
                    />
                  ) : null}

                  {/* REVIEW, the clean "here is what will happen": plan overview,
                      every operation, destination. */}
                  {isReview ? (
                    <ReviewPanel
                      planGroups={planGroups}
                      totalXlm={totalXlm}
                      activeCount={activeCount}
                      destination={form.destination}
                      network={network}
                      snapshot={
                        audit
                          ? {
                              pk: publicKey ?? "",
                              sub: acctSub,
                              trustlines: acctTrustlines,
                              offers: acctOffers,
                              data: acctData,
                              claimable: acctClaimable,
                            }
                          : null
                      }
                      onBack={
                        hasAckItems
                          ? () => setConfirmStage("acknowledge")
                          : hasBlocker
                            ? () => setConfirmStage("resolve")
                            : onCancel
                      }
                      onDemolish={() => setShowConfirmDialog(true)}
                      {...(multisigRequired
                        ? {
                            createRequest: {
                              onCreate: () => void onCreateRequest(),
                              creating: creatingRequest,
                              error: createRequestError,
                            },
                          }
                        : {})}
                    />
                  ) : null}

                  {isCancelled ? <CancelledPanel onResume={() => send({ type: "RESET" })} /> : null}
                </>
              )}
            </div>
          ) : null}

          {/* final gate, typed-confirmation dialog, opened from Review */}
          {showConfirmDialog ? (
            <TypedConfirmation
              destination={form.destination}
              explorerUrl={explorerAccountUrl(network, form.destination)}
              onCancel={() => setShowConfirmDialog(false)}
              onConfirm={(typed) => {
                setShowConfirmDialog(false);
                send({ type: "CONFIRM", typed });
              }}
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
