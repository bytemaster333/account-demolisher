"use client";

// orchestrator-driven demolition UI, styled to match the dc design (lines 492-775 + modals)
// wires the page-flow xstate machine and the plan tree

import { useMachine } from "@xstate/react";
import { BASE_FEE, Keypair, StrKey } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { AppShell } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Notice,
  SectionLabel,
  Select,
  StatGrid,
} from "@/components/ui";
import { TypedConfirmation } from "@/components/confirmations/TypedConfirmation";
import { AuthImmutableBlock } from "@/components/warnings/AuthImmutableBlock";
import { DiscoveryWarnings } from "@/components/warnings/DiscoveryWarnings";
import { ResidueConsent, type ResidueConsentCredit } from "@/components/warnings/ResidueConsent";
import { ScamTokenNotice } from "@/components/warnings/ScamTokenNotice";
import {
  PendingClaimableBalances,
  type PendingClaimableBalanceEntry,
} from "@/components/warnings/PendingClaimableBalances";
import { SponsoringBlock } from "@/components/warnings/SponsoringBlock";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { CreateTestAccountButton } from "@/components/wallet/CreateTestAccountButton";
import { MultisigSigners, type AddedSigner } from "@/components/wallet/MultisigSigners";
import { SecretKeyFallback } from "@/components/wallet/SecretKeyFallback";
import { explorerTxUrl } from "@/lib/explorer";
import Link from "next/link";
import { useNetworkStore } from "@/stores/network";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { pageFlowMachine } from "@/lib/orchestrator/page-flow-machine";
import { auditAccount } from "@/lib/stellar/account-audit";
import { lookupCex, requireMemoEnforcement, type CexInfo } from "@/lib/safety/cex-registry";
import { runScamHeuristics, type ScamFinding } from "@/lib/safety/scam-heuristics";
import { topologicalOrder, type PlanNode } from "@/lib/plan/tree";
import type { AccountAudit, AuditSigner, ClaimableBalanceEntry } from "@/lib/types/account";
import type { ClassicMemo } from "@/lib/types/plan";
import type { Connector } from "@/lib/wallet/connector";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";
import { MultiSignerConnector, type MultiSignerMember } from "@/lib/wallet/multi-signer";
import { setActiveConnector } from "@/lib/wallet/active-connector";
import { useWalletStore } from "@/stores/wallet";

const HIGH_VALUE_THRESHOLD_XLM = 1000;

const G_ADDRESS = z
  .string()
  .min(1, { message: "Destination address is required." })
  .refine((v) => StrKey.isValidEd25519PublicKey(v), {
    message: "Not a valid Stellar G... address.",
  });

const MEMO_TYPE = z.enum(["none", "text", "id", "hash", "return"]);

const FORM_SCHEMA = z.object({
  destination: G_ADDRESS,
  memoType: MEMO_TYPE,
  memoValue: z.string(),
  fallback: z.string(),
  selectedCbIds: z.array(z.string()),
  // pathKey()s of un-routable credit assets the user consented to return to
  // their issuer so the account can close
  returnToIssuer: z.array(z.string()),
});

type FormState = z.infer<typeof FORM_SCHEMA>;

const INITIAL_FORM: FormState = {
  destination: "",
  memoType: "none",
  memoValue: "",
  fallback: "",
  selectedCbIds: [],
  returnToIssuer: [],
};

// ─── derived helpers ────────────────────────────────────────────────────────

function shortPk(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
}

// map an audited claimable balance to the notice row, flagging any that the
// account can't claim right now (left in place rather than attempted).
function toPendingCb(cb: ClaimableBalanceEntry): PendingClaimableBalanceEntry {
  const assetLabel =
    cb.asset.kind === "native" ? "XLM" : cb.asset.kind === "credit" ? cb.asset.code : "POOL";
  return {
    id: cb.id,
    amount: cb.amount,
    assetLabel,
    ...(cb.claimableNow === false ? { reason: "not claimable yet — left in place" } : {}),
  };
}

function sumNativeBalance(audit: AccountAudit): string {
  const native = audit.balances.find((b) => b.asset.kind === "native");
  return native?.amount ?? "0";
}

function countTrustlines(audit: AccountAudit): number {
  return audit.balances.filter((b) => b.asset.kind === "credit").length;
}

function thresholdLabel(audit: AccountAudit): string {
  // medium threshold over total signer weight is the closest analogue to the design's "2/3"
  const total = audit.signers.reduce((acc, s) => acc + s.weight, 0);
  return `${audit.thresholds.medium} / ${total || audit.signers.length}`;
}

// plan-tree grouping for the left rail. groups by node "phase"
// soroban-side nodes belong to "unwind"; the final classic + mediator nodes belong to "merge"
function groupPlanNodes(nodes: readonly PlanNode[]): ReadonlyArray<{
  phase: string;
  nodes: readonly PlanNode[];
}> {
  const groups = new Map<string, PlanNode[]>();
  for (const node of nodes) {
    const phase = phaseForNode(node);
    let arr = groups.get(phase);
    if (!arr) {
      arr = [];
      groups.set(phase, arr);
    }
    arr.push(node);
  }
  return [...groups.entries()].map(([phase, ns]) => ({ phase, nodes: ns }));
}

function phaseForNode(node: PlanNode): string {
  switch (node.kind) {
    case "RevokeAllowance":
      return "Allowances";
    case "RepayBlend":
    case "PayFxDAODebt":
      return "DeFi debt";
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
    case "RedeemFxDAO":
      return "DeFi withdrawals";
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
      return "Claim rewards";
    case "ConvertSorobanToXLM":
    case "TransferAsIs":
      return "Liquidation";
    case "BackstopQueue":
      return "Queued backstop";
    case "FinalClassicTx":
      return "Merge";
    case "MediatorForward":
      return "Mediator forward";
  }
}

function nodeLabel(node: PlanNode): string {
  switch (node.kind) {
    case "RevokeAllowance":
      return "Revoke SEP-41 allowance";
    case "RepayBlend":
      return "Repay Blend debt";
    case "PayFxDAODebt":
      return "Pay FxDAO debt";
    case "WithdrawBlend":
      return "Withdraw Blend position";
    case "WithdrawAquarius":
      return "Withdraw Aquarius LP";
    case "WithdrawSoroswapLp":
      return "Withdraw Soroswap LP";
    case "RedeemFxDAO":
      return "Redeem FxDAO vault";
    case "ClaimBlendEmissions":
      return "Claim Blend emissions";
    case "ClaimAquariusRewards":
      return "Claim Aquarius rewards";
    case "ConvertSorobanToXLM":
      return "Convert SEP-41 → XLM";
    case "TransferAsIs":
      return "Transfer token as-is";
    case "BackstopQueue":
      return "Queue Blend backstop";
    case "FinalClassicTx":
      return "Final merge transaction";
    case "MediatorForward":
      return "Mediator forward to destination";
  }
}

// network fee for a node, in stroops (0 when not simulated).
// exported for unit tests.
export function nodeFeeStroops(node: PlanNode): number {
  const sim = node.simulated;
  const raw =
    sim?.kind === "soroban"
      ? // the submitted fee assembles as minResourceFee + the classic inclusion
        // fee; every soroban node here is a single op built with BASE_FEE, so add
        // BASE_FEE to match assembleTransaction (and the classic branch, which
        // already tallies BASE_FEE * opCount).
        (Number.parseInt(sim.minResourceFee, 10) + Number.parseInt(BASE_FEE, 10)).toString()
      : sim?.kind === "classic"
        ? sim.estimatedFee
        : null;
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

// stroops → a trimmed XLM string (1 XLM = 10,000,000 stroops)
function stroopsToXlm(stroops: number): string {
  const xlm = stroops / 1e7;
  if (xlm === 0) return "0";
  const s = xlm.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
}

interface FlowStep {
  readonly num: string;
  readonly label: string;
  readonly isDone: boolean;
  readonly isActive: boolean;
  readonly isTodo: boolean;
  readonly notLast: boolean;
}

type FlowPhase = "connect" | "configure" | "resolve" | "acknowledge" | "review" | "execute";

function buildFlowSteps(args: {
  readonly phase: FlowPhase;
  // Resolve (blocker action) and Acknowledge (read warnings) are each shown only
  // when the built plan surfaced that kind of item; empty steps are omitted.
  readonly hasResolve: boolean;
  readonly hasAcknowledge: boolean;
  readonly isSucceeded: boolean;
}): readonly FlowStep[] {
  const { phase, hasResolve, hasAcknowledge, isSucceeded } = args;
  const labels = [
    "Connect",
    "Configure",
    ...(hasResolve ? ["Resolve"] : []),
    ...(hasAcknowledge ? ["Acknowledge"] : []),
    "Review",
    "Execute",
  ];

  const activeLabel =
    phase === "connect"
      ? "Connect"
      : phase === "configure"
        ? "Configure"
        : phase === "resolve"
          ? "Resolve"
          : phase === "acknowledge"
            ? "Acknowledge"
            : phase === "review"
              ? "Review"
              : "Execute";
  // a phase whose step was omitted (shouldn't happen) falls back to Review
  let activeIdx = labels.indexOf(activeLabel);
  if (activeIdx < 0) activeIdx = labels.indexOf("Review");

  return labels.map((label, i) => {
    const num = String(i + 1).padStart(2, "0");
    const isActive = i === activeIdx && !isSucceeded;
    const isDone = isSucceeded || i < activeIdx;
    const isTodo = !isActive && !isDone;
    const notLast = i < labels.length - 1;
    return { num, label, isDone, isActive, isTodo, notLast };
  });
}

// ─── page ────────────────────────────────────────────────────────────────────

export default function DemolishPage(): React.JSX.Element {
  return (
    <AppShell>
      <DemolishFlow />
    </AppShell>
  );
}

function DemolishFlow(): React.JSX.Element {
  const connectorRef = useRef<Connector | null>(null);
  const [hasConnector, setHasConnector] = useState(false);
  const publicKey = useWalletStore((s) => s.publicKey);
  const isDemo = useWalletStore((s) => s.isDemo);
  const disconnectWallet = useWalletStore((s) => s.disconnect);

  const networkId = useNetworkStore((s) => s.networkId);
  const network = useMemo<NetworkConfig>(() => resolveNetwork(networkId), [networkId]);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  // multisig: preflight the connected account for its signature threshold, then
  // collect additional signer secret keys until the combined weight meets it.
  const [multisig, setMultisig] = useState<{
    readonly required: boolean;
    readonly threshold: number;
    readonly signers: readonly AuditSigner[];
  } | null>(null);
  const [extraSigners, setExtraSigners] = useState<
    readonly {
      readonly publicKey: string;
      readonly weight: number;
      readonly connector: Connector;
    }[]
  >([]);

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

  const primaryWeight = useMemo(() => {
    if (!multisig || !publicKey) return 0;
    return multisig.signers.find((s) => s.key === publicKey)?.weight ?? 0;
  }, [multisig, publicKey]);
  const collectedWeight = primaryWeight + extraSigners.reduce((sum, s) => sum + s.weight, 0);
  const multisigRequired = publicKey !== null && multisig?.required === true;
  const multisigReady = !multisigRequired || collectedWeight >= (multisig?.threshold ?? 0);

  const onAddSecretSigner = useCallback(
    (secret: string): string | null => {
      if (!multisig || !publicKey) return "Connect an account first.";
      if (!StrKey.isValidEd25519SecretSeed(secret)) return "Not a valid Stellar secret key (S…).";
      let pk: string;
      try {
        pk = Keypair.fromSecret(secret).publicKey();
      } catch {
        return "Could not derive a public key from that secret.";
      }
      if (pk === publicKey) return "That is the already-connected signer.";
      if (extraSigners.some((s) => s.publicKey === pk)) return "That signer is already added.";
      const signer = multisig.signers.find((s) => s.key === pk && s.weight > 0);
      if (!signer) return "That key is not an authorized signer on this account.";
      const connector = new SecretKeyConnector(secret);
      setExtraSigners((prev) => [...prev, { publicKey: pk, weight: signer.weight, connector }]);
      return null;
    },
    [multisig, publicKey, extraSigners],
  );

  const onRemoveSigner = useCallback((pk: string) => {
    setExtraSigners((prev) => prev.filter((s) => s.publicKey !== pk));
  }, []);

  // the awaiting_confirmation phase has three stages:
  //  "resolve"     — take an action on a blocker (return-to-issuer) + rebuild
  //  "acknowledge" — read-and-understand every warning / info card
  //  "review"      — the clean "here is what will happen" review + demolish
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

  // scam heuristics over the account's held credit balances (look-alike symbols,
  // homoglyphs, off-allowlist contracts) — surfaced as an informational notice.
  const scamFindings = useMemo(() => (audit ? runScamHeuristics(audit.balances) : []), [audit]);

  const isMachineIdle = state === "idle";
  const isDiscovering = state === "discovering";
  const isPreviewing = state === "previewing";
  const isAwaitingConfirmation = state === "awaiting_confirmation";
  const isExecuting = state === "executing";
  const isSucceeded = state === "succeeded";
  const isFailed = state === "failed";
  const isCancelled = state === "cancelled";

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

  // total native balance + high-value flag — needed by the Resolve step and the
  // review summary; computed early so the flow phase / stepper can read them.
  const totalXlm = audit ? sumNativeBalance(audit) : "0";
  const isHighValue = useMemo<boolean>(() => {
    if (!audit) return false;
    const n = Number.parseFloat(totalXlm);
    if (!Number.isFinite(n)) return false;
    return n > HIGH_VALUE_THRESHOLD_XLM;
  }, [audit, totalXlm]);

  // two distinct concerns, kept as separate steps:
  //  - a BLOCKER (un-routable balance) needs an ACTION + rebuild  → "resolve"
  //  - warnings / info need only READ-AND-UNDERSTAND               → "acknowledge"
  const hasBlocker = ctx.unroutableCredits.length > 0;
  const hasScam = scamFindings.length > 0;
  const hasDiscovery = ctx.discoveryWarnings.length > 0;
  const hasAutoHandled = audit !== null && (audit.claimableBalances.length > 0 || numCoverable > 0);
  const hasAckItems = hasScam || hasDiscovery || hasAutoHandled || isHighValue;

  // initialise the confirm stage per built plan: resolve blockers first, then
  // acknowledge warnings/info, then the clean review — skipping any empty step.
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
  // (tree !== null) — during "Building plan…" the tree is null and
  // unroutableCredits is empty, so computing them then would briefly show
  // Acknowledge before the built plan reveals a blocker and flips to Resolve.
  // And Acknowledge stays hidden while a blocker is unresolved, since returning a
  // token to its issuer can drop that token's warnings after the rebuild.
  const planBuilt = tree !== null;
  const flowSteps = useMemo(
    () =>
      buildFlowSteps({
        phase: flowPhase,
        hasResolve: planBuilt && hasBlocker,
        hasAcknowledge: planBuilt && hasAckItems && !hasBlocker,
        isSucceeded,
      }),
    [flowPhase, planBuilt, hasBlocker, hasAckItems, isSucceeded],
  );

  // cex / mediator
  const cex: CexInfo | null = useMemo(() => {
    const trimmed = form.destination.trim();
    if (trimmed.length === 0) return null;
    return lookupCex(trimmed);
  }, [form.destination]);
  const useMediator = cex !== null;

  const setConnector = useCallback((c: Connector | null) => {
    connectorRef.current = c;
    setHasConnector(c !== null);
    // a new/cleared connection invalidates any collected multisig signers.
    // Use functional updates that return the SAME reference when already reset —
    // ConnectButton re-notifies every render, so a fresh `[]`/`null` here would
    // create a new reference each time and spin an infinite render loop.
    setMultisig((prev) => (prev === null ? prev : null));
    setExtraSigners((prev) => (prev.length === 0 ? prev : []));
  }, []);

  // once the account is closed it no longer exists — drop the connection so a
  // later navigation back to /demolish starts at Connect, not Configure with a
  // dead account. The success screen keys off the machine + tree (not publicKey)
  // so it stays visible. Guarded by a ref so it fires once per close.
  const closedRef = useRef(false);
  useEffect(() => {
    if (isSucceeded && !closedRef.current) {
      closedRef.current = true;
      setConnector(null);
      setActiveConnector(null);
      disconnectWallet();
    } else if (!isSucceeded && closedRef.current) {
      closedRef.current = false;
    }
  }, [isSucceeded, setConnector, disconnectWallet]);

  // guard against navigating away / closing the tab mid-execution — a partial
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
        "Destination can't be your own account — Stellar rejects a self-merge (ACCOUNT_MERGE_MALFORMED).",
      );
      return;
    }

    const memo = parseMemo(form);

    // hard refusal when the destination is a CEX and the memo is missing, the
    // wrong type, or malformed (strict value validation, not just presence)
    const memoCheck = requireMemoEnforcement(parsed.data.destination, memo);
    if (!memoCheck.ok) {
      setFormError(memoCheck.reason);
      return;
    }

    // for a multisig account, gather every collected signer into one connector
    // that signs each transaction with all of them (meeting the threshold).
    let connector: Connector = connectorRef.current;
    if (multisigRequired) {
      if (!multisigReady) {
        setFormError(
          `This account needs signing weight ${multisig?.threshold ?? 0}; you have ${collectedWeight}. Add more signer keys.`,
        );
        return;
      }
      const members: MultiSignerMember[] = [
        { connector: connectorRef.current, publicKey, weight: primaryWeight },
        ...extraSigners.map((s) => ({
          connector: s.connector,
          publicKey: s.publicKey,
          weight: s.weight,
        })),
      ];
      connector = new MultiSignerConnector(publicKey, members);
    }

    send({
      type: "START",
      input: {
        publicKey,
        network,
        connector,
        destination: parsed.data.destination,
        useMediator,
        ...(memo ? { memo } : {}),
        ...(form.fallback.trim().length > 0 ? { userFallbackAddress: form.fallback.trim() } : {}),
        ...(form.selectedCbIds.length > 0
          ? { selectedClaimableBalanceIds: form.selectedCbIds }
          : {}),
        ...(form.returnToIssuer.length > 0 ? { returnToIssuerAssetKeys: form.returnToIssuer } : {}),
      },
    });
  }, [
    form,
    publicKey,
    network,
    useMediator,
    send,
    multisigRequired,
    multisigReady,
    multisig,
    collectedWeight,
    primaryWeight,
    extraSigners,
  ]);

  const onCancel = useCallback(() => {
    setShowConfirmDialog(false);
    send({ type: "CANCEL" });
  }, [send]);
  const onReset = useCallback(() => {
    setShowConfirmDialog(false);
    setForm(INITIAL_FORM);
    setFormError(null);
    // the account we operated on is gone (merged) or abandoned — fully drop the
    // connection so "Start over" returns to Connect, not Configure with a dead
    // account still selected.
    setConnector(null);
    setActiveConnector(null);
    disconnectWallet();
    send({ type: "RESET" });
  }, [send, setConnector, disconnectWallet]);
  const onRetry = useCallback(() => send({ type: "RETRY" }), [send]);
  const onToggleResidue = useCallback((key: string, consent: boolean) => {
    setForm((f) => {
      const set = new Set(f.returnToIssuer);
      if (consent) set.add(key);
      else set.delete(key);
      return { ...f, returnToIssuer: [...set] };
    });
  }, []);

  useEffect(() => {
    return () => {
      connectorRef.current = null;
    };
  }, []);

  // pre-select the claimable balances by default so the demo flow "just works".
  // only balances claimable NOW are pre-checked — an unclaimable one would fail
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
  const acctPkShort = publicKey ? shortPk(publicKey) : "";
  const acctSub = audit?.subentryCount ?? 0;
  // acctThreshold is no longer surfaced now that AuditCard was dropped from preview;
  // keep the derivation for potential future re-use without tripping lint
  void (audit ? thresholdLabel(audit) : "—");
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
      {/* IDLE — connect */}
      {isIdle ? (
        <IdleConnect
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
          network={network}
          onKitConnector={(c) => setConnector(c)}
          onSecretConnector={(c) => setConnector(c)}
        />
      ) : null}

      {/* BLOCKED — full takeover */}
      {!isIdle && isImmutableBlock ? <AuthImmutableBlock onDismiss={onReset} /> : null}
      {!isIdle && !isImmutableBlock && isSponsorBlock ? (
        // hard mode only — foreign sponsorships the batcher can't auto-revoke
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
          <StepIndicator steps={flowSteps} />

          {/* during the brief discover/preview transition, take over the whole
              row with a single centered loading widget — no side rail, no
              form behind it. */}
          {(isDiscovering || isPreviewing) && tree === null ? (
            <div style={{ maxWidth: 560, margin: "0 auto" }}>
              <LeftLoadingCard message={isDiscovering ? "Auditing account…" : "Building plan…"} />
            </div>
          ) : null}

          {/* execute / succeeded / failed all collapse to a single centered
              widget. one card lifecycle: header morphs by state (executing
              counter → success banner → failure banner), the plan tree is the
              body throughout, and the footer holds the right actions per state.
              no 2-column reflow when execution finishes. */}
          {(isExecuting || isSucceeded || isFailed) && tree !== null ? (
            <div style={{ maxWidth: 640, margin: "0 auto" }}>
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

          {/* single-column flow content — configure / review / sign-off / cancelled.
              No side rail and no modals: the plan detail lives in the sign-off step. */}
          {!(isDiscovering || isPreviewing) && !isExecuting && !isSucceeded && !isFailed ? (
            <div style={{ maxWidth: isConfiguring ? 640 : 760, margin: "0 auto" }}>
              {isConfiguring ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {multisigRequired && multisig ? (
                    <MultisigSigners
                      threshold={multisig.threshold}
                      currentWeight={collectedWeight}
                      added={extraSigners.map(
                        (s): AddedSigner => ({ publicKey: s.publicKey, weight: s.weight }),
                      )}
                      onAddSecret={onAddSecretSigner}
                      onRemove={onRemoveSigner}
                    />
                  ) : null}
                  {audit && numCoverable > 0 ? (
                    <SponsorshipAutoRevokeNotice count={numCoverable} />
                  ) : null}
                  {audit && audit.claimableBalances.length > 0 ? (
                    <PendingClaimableBalances pending={audit.claimableBalances.map(toPendingCb)} />
                  ) : null}
                  <ConfigurePanel
                    form={form}
                    setForm={setForm}
                    cex={cex}
                    hasMemo={hasMemo}
                    formError={formError}
                    isBusy={false}
                    canStart={publicKey !== null && hasConnector && multisigReady}
                    onGeneratePlan={onStart}
                    audit={audit}
                    isDemo={isDemo}
                  />
                </div>
              ) : null}

              {/* RESOLVE — actions only: blockers that need a return-to-issuer
                  choice + rebuild. Rebuild is gated until every one is resolved. */}
              {isResolve ? (
                <ResolvePanel
                  credits={ctx.unroutableCredits}
                  network={network}
                  consented={form.returnToIssuer}
                  onToggle={onToggleResidue}
                  onRebuild={onStart}
                  onBack={onCancel}
                />
              ) : null}

              {/* ACKNOWLEDGE — information only: read-and-understand each warning /
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
                  onBack={onCancel}
                  onContinue={() => setConfirmStage("review")}
                />
              ) : null}

              {/* REVIEW — the clean "here is what will happen": plan overview,
                  every operation, destination. No cautions (all handled above). */}
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
                          pkShort: acctPkShort,
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
                />
              ) : null}

              {isCancelled ? <CancelledPanel onResume={() => send({ type: "RESET" })} /> : null}
            </div>
          ) : null}

          {/* final gate — typed-confirmation dialog, opened from Review */}
          {showConfirmDialog ? (
            <TypedConfirmation
              destination={form.destination}
              onCancel={() => setShowConfirmDialog(false)}
              onConfirm={() => {
                setShowConfirmDialog(false);
                send({ type: "CONFIRM" });
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

// ─── sub-views ───────────────────────────────────────────────────────────────

function IdleConnect({
  advancedOpen,
  onToggleAdvanced,
  network,
  onKitConnector,
  onSecretConnector,
}: {
  readonly advancedOpen: boolean;
  readonly onToggleAdvanced: () => void;
  readonly network: NetworkConfig;
  readonly onKitConnector: (c: WalletKitConnector | null) => void;
  readonly onSecretConnector: (c: SecretKeyConnector) => void;
}): React.JSX.Element {
  const isTestnetLike = network.friendbot !== null;
  const netLabel =
    network.id === "mainnet" ? "Mainnet" : network.id === "futurenet" ? "Futurenet" : "Testnet";
  // once demo setup starts it takes over the screen as a dedicated step
  const [demoActive, setDemoActive] = useState(false);
  return (
    <div style={{ maxWidth: demoActive ? 640 : 720, margin: "8px auto 0" }}>
      {!demoActive ? (
        <>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 11px",
              borderRadius: 999,
              border: "1px solid var(--border-2)",
              background: "transparent",
              marginBottom: 22,
            }}
          >
            <span
              style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }}
            />
            <span
              style={{
                font: "600 11px/1 Geist, sans-serif",
                color: "var(--fg-2)",
                letterSpacing: "0.04em",
                whiteSpace: "nowrap",
              }}
            >
              STEP 1 OF 5
            </span>
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 36,
              fontWeight: 600,
              letterSpacing: "-0.03em",
              color: "var(--fg)",
            }}
          >
            Close a Stellar account
          </h1>
          <p
            style={{
              margin: "13px 0 30px",
              fontSize: 16,
              lineHeight: 1.55,
              color: "var(--fg-2)",
              maxWidth: 560,
            }}
          >
            Connect the account you want to close. The demolisher unwinds every trustline, offer,
            data entry, signer, and Soroban position, then merges the reserve to a destination you
            choose — all signed on your device, nothing auto-submitted.
            {isTestnetLike
              ? " New here? Spin up a throwaway demo account at the bottom to see the whole flow first."
              : ""}
          </p>

          {/* primary: connect a real wallet */}
          <div
            style={{
              padding: 18,
              borderRadius: 13,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>
                Connect a wallet
              </span>
              <span style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
                Freighter, xBull, Albedo, Rabet, Lobstr, Hana, WalletConnect.
              </span>
            </div>
            <ConnectButton network={network} onConnector={onKitConnector} />
          </div>

          {/* collapsed: legacy/advanced seed paste */}
          <div
            style={{
              marginTop: 14,
              border: "1px solid var(--border)",
              borderRadius: 13,
              overflow: "hidden",
              background: "var(--surface)",
            }}
          >
            <button
              type="button"
              onClick={onToggleAdvanced}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "15px 17px",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--fg)",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--fg-3)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                </svg>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                  Advanced, paste a secret key
                </span>
              </span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--fg-3)"
                strokeWidth={2.2}
                strokeLinecap="round"
                style={{ transform: advancedOpen ? "rotate(180deg)" : "none" }}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {advancedOpen ? (
              <div style={{ padding: "0 17px 17px" }}>
                <SecretKeyFallback onConnector={onSecretConnector} />
              </div>
            ) : null}
          </div>

          {/* testnet-only divider before the demo step */}
          {isTestnetLike ? (
            <div
              style={{
                margin: "30px 0 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                color: "var(--fg-3)",
                fontSize: 11.5,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <span>or explore on {netLabel} first</span>
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
          ) : null}
        </>
      ) : null}

      {/* demo setup — takes over as a dedicated step once it starts */}
      {isTestnetLike ? (
        <CreateTestAccountButton
          network={network}
          onConnector={onSecretConnector}
          onActiveChange={setDemoActive}
        />
      ) : null}
    </div>
  );
}

function StepIndicator({ steps }: { readonly steps: readonly FlowStep[] }): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        marginBottom: 26,
        flexWrap: "wrap",
      }}
    >
      {steps.map((st) => (
        <div key={st.num} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "7px 13px 7px 8px",
              borderRadius: 999,
              border: st.isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: "transparent",
            }}
          >
            {st.isDone ? (
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  border: "1px solid var(--success)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--success)"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </span>
            ) : null}
            {st.isActive ? (
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  border: "1px solid var(--accent)",
                  color: "var(--accent)",
                  display: "grid",
                  placeItems: "center",
                  font: "600 10px/1 Geist, sans-serif",
                }}
              >
                {st.num}
              </span>
            ) : null}
            {st.isTodo ? (
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  border: "1.5px solid var(--border-2)",
                  color: "var(--fg-3)",
                  display: "grid",
                  placeItems: "center",
                  font: "600 10px/1 Geist, sans-serif",
                }}
              >
                {st.num}
              </span>
            ) : null}
            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>{st.label}</span>
          </div>
          {st.notLast ? (
            <span style={{ width: 18, height: 1, background: "var(--border-2)" }} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

// inline notice surfaced ABOVE the configure form when the account has
function SponsorshipAutoRevokeNotice({ count }: { readonly count: number }): React.JSX.Element {
  return (
    <div
      role="status"
      data-testid="sponsorship-auto-revoke-notice"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 11,
        background: "var(--surface-2)",
        border: "1px solid color-mix(in srgb, var(--warning) 14%, transparent)",
        color: "var(--fg)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: "var(--surface-2)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--warning)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--fg)",
            letterSpacing: "-0.005em",
          }}
        >
          {count === 1 ? "1 self-sponsored entry" : `${count} self-sponsored entries`} on this
          account
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "var(--fg-2)",
          }}
        >
          The demolisher will revoke {count === 1 ? "it" : "them"} as part of the close-out tx — no
          action needed.
        </div>
      </div>
    </div>
  );
}

function LeftLoadingCard({ message }: { readonly message: string }): React.JSX.Element {
  return (
    <div
      style={{
        // borderless + transparent: float over the ambient page background so
        // the giant animated icon is the focal point, not a card chrome
        background: "transparent",
        border: "none",
        padding: "60px 28px",
        minHeight: 420,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        position: "relative",
      }}
    >
      {/* huge animated search/audit icon with concentric pulse rings */}
      <div
        aria-hidden
        style={{
          position: "relative",
          width: 220,
          height: 220,
          display: "grid",
          placeItems: "center",
        }}
      >
        {/* outer concentric rings — different delays for a "scanning" feel */}
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: "1px solid var(--accent-line)",
            animation: "ringPulse 1.8s ease-out infinite",
          }}
        />
        <span
          style={{
            position: "absolute",
            inset: 30,
            borderRadius: "50%",
            border: "1px solid var(--accent-line)",
            animation: "ringPulse 1.8s ease-out infinite",
            animationDelay: "0.45s",
          }}
        />
        <span
          style={{
            position: "absolute",
            inset: 60,
            borderRadius: "50%",
            border: "1px solid var(--accent-line)",
            animation: "ringPulse 1.8s ease-out infinite",
            animationDelay: "0.9s",
          }}
        />
        {/* the big icon tile */}
        <span
          style={{
            position: "relative",
            width: 108,
            height: 108,
            borderRadius: 28,
            background: "var(--surface-2)",
            border: "1px solid var(--accent-line)",
            color: "var(--accent)",
            display: "grid",
            placeItems: "center",
            animation: "pulse 2.2s ease-in-out infinite",
          }}
        >
          <svg
            width="52"
            height="52"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </span>
      </div>

      <div
        style={{
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          position: "relative",
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--fg)",
            letterSpacing: "-0.01em",
          }}
        >
          {message}
        </div>
      </div>
    </div>
  );
}

// single, evolving widget that covers execute / succeeded / failed
function DemolishStatusWidget({
  state,
  planGroups,
  doneCount,
  activeCount,
  network,
  totalXlm,
  destination,
  mergeHash,
  error,
  onRetry,
  onReset,
}: {
  readonly state: "executing" | "succeeded" | "failed";
  readonly planGroups: ReadonlyArray<{ phase: string; nodes: readonly PlanNode[] }>;
  readonly doneCount: number;
  readonly activeCount: number;
  readonly network: NetworkConfig;
  readonly totalXlm: string;
  readonly destination: string;
  readonly mergeHash: string | null;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onReset: () => void;
}): React.JSX.Element {
  const accent =
    state === "succeeded"
      ? "var(--success)"
      : state === "failed"
        ? "var(--danger)"
        : "var(--accent)";
  const accentSoft =
    state === "succeeded"
      ? "var(--surface-2)"
      : state === "failed"
        ? "var(--surface-2)"
        : "var(--surface-2)";

  const parsed = state === "failed" ? parseDemolishError(error) : null;
  const pct = activeCount > 0 ? Math.round((doneCount / activeCount) * 100) : 0;

  // elapsed seconds while executing — the interval drives it (async setState is
  // fine); it's only read from the executing subtitle
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (state !== "executing") return;
    const start = Date.now();
    const h = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(h);
  }, [state]);

  // a plain-text receipt of an irreversible action — destination + every tx
  const [copied, setCopied] = useState(false);
  const copyReceipt = (): void => {
    const lines = [
      `Account Demolisher — account closed`,
      `Forwarded ${totalXlm} XLM to ${destination}`,
      mergeHash ? `Merge tx: ${explorerTxUrl(network, mergeHash)}` : "",
      ...planGroups.flatMap((g) =>
        g.nodes
          .filter((n) => n.executed?.txHash)
          .map((n) => `${nodeLabel(n)}: ${explorerTxUrl(network, n.executed!.txHash!)}`),
      ),
    ].filter(Boolean);
    void navigator.clipboard
      ?.writeText(lines.join("\n"))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* clipboard blocked — ignore */
      });
  };

  return (
    <div
      data-testid="demolish-status-widget"
      data-state={state}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 18,
        boxShadow: "var(--shadow-sm)",
        overflow: "hidden",
      }}
    >
      {/* ─── header ────────────────────────────────────────────── */}
      <div
        style={{
          position: "relative",
          padding: "22px 22px 20px",
          borderBottom: "1px solid var(--border)",
          background: `linear-gradient(180deg, ${accentSoft} 0%, transparent 100%)`,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <span
            aria-hidden
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              background: "var(--surface-2)",
              border: `1px solid ${accent}`,
              color: accent,
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
              animation:
                state === "succeeded"
                  ? "pop .35s ease-out"
                  : state === "executing"
                    ? "pulse 2s ease-in-out infinite"
                    : "none",
            }}
          >
            {state === "succeeded" ? (
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12.5l4.5 4.5L19 7" />
              </svg>
            ) : state === "failed" ? (
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 9v4M12 17h.01" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            ) : (
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            )}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontSize: 17,
                  fontWeight: 600,
                  letterSpacing: "-0.015em",
                  color: "var(--fg)",
                }}
              >
                {state === "succeeded"
                  ? "Account closed"
                  : state === "failed"
                    ? "Demolition failed"
                    : "Executing demolition"}
              </h2>
              <span
                style={{
                  font: "600 11.5px/1 'Geist Mono', monospace",
                  color: "var(--fg-3)",
                  letterSpacing: "0.02em",
                }}
              >
                {doneCount}/{activeCount}
              </span>
            </div>
            <p
              style={{
                margin: "5px 0 0",
                fontSize: 12.5,
                lineHeight: 1.5,
                color: "var(--fg-2)",
              }}
            >
              {state === "succeeded" ? (
                <>
                  <strong style={{ color: "var(--fg)", fontFamily: "'Geist Mono', monospace" }}>
                    {totalXlm} XLM
                  </strong>{" "}
                  forwarded — the account no longer exists on the ledger.
                </>
              ) : state === "failed" ? (
                (parsed?.summary ?? "An unknown error occurred while running the plan.")
              ) : (
                <>
                  Signing and submitting each step in order — your wallet may prompt for each.{" "}
                  {elapsed > 0 ? `Running for ${elapsed}s.` : ""}
                </>
              )}
            </p>
          </div>
        </div>

        {/* executing: progress bar + a prominent "don't leave" guard */}
        {state === "executing" ? (
          <>
            <div
              aria-hidden
              style={{
                marginTop: 16,
                height: 6,
                borderRadius: 3,
                background: "var(--surface-2)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  background: "var(--accent)",
                  borderRadius: 3,
                  transition: "width .35s ease",
                }}
              />
            </div>
            <div
              role="alert"
              style={{
                marginTop: 12,
                display: "flex",
                gap: 9,
                alignItems: "flex-start",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)",
                background: "var(--surface)",
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--warning)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0, marginTop: 1 }}
                aria-hidden
              >
                <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              </svg>
              <span style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-2)" }}>
                <strong style={{ color: "var(--warning)" }}>Keep this tab open.</strong> Leaving now
                could stop the close-out partway through, with some steps done and the account not
                yet closed.
              </span>
            </div>
          </>
        ) : null}

        {/* extra meta strip under the header for succeeded/failed */}
        {state === "succeeded" && mergeHash ? (
          <a
            href={explorerTxUrl(network, mergeHash)}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              marginTop: 14,
              padding: "8px 11px",
              borderRadius: 9,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              color: "var(--fg)",
              textDecoration: "none",
              font: "500 12px/1 'Geist Mono', monospace",
            }}
            title="Open merge tx on stellar.expert"
          >
            <span style={{ fontSize: 10, color: "var(--fg-3)" }}>MERGE TX</span>
            <span>{truncateHash(mergeHash)}</span>
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
          </a>
        ) : null}

        {state === "failed" && parsed && parsed.ops.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 5,
              marginTop: 12,
            }}
          >
            {parsed.txCode !== null ? (
              <code
                style={{
                  padding: "3px 7px",
                  borderRadius: 6,
                  font: "600 10.5px/1 'Geist Mono', monospace",
                  color: "var(--danger)",
                  background: "var(--surface-2)",
                  border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)",
                }}
              >
                {parsed.txCode}
              </code>
            ) : null}
            {parsed.ops.map((op, i) => {
              const isFail = op !== "op_success";
              return (
                <code
                  key={i}
                  title={`op ${i + 1}: ${op}`}
                  style={{
                    padding: "3px 7px",
                    borderRadius: 6,
                    font: "600 10.5px/1 'Geist Mono', monospace",
                    color: isFail ? "var(--danger)" : "var(--success)",
                    background: isFail ? "var(--surface-2)" : "var(--surface-2)",
                    border: `1px solid color-mix(in srgb, var(${isFail ? "--danger" : "--success"}) 25%, transparent)`,
                  }}
                >
                  {isFail ? `${i + 1}: ${op}` : `${i + 1} ✓`}
                </code>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* ─── body: plan tree (same throughout the lifecycle) ─── */}
      <div
        style={{
          maxHeight: state === "executing" ? "calc(100vh - 360px)" : "none",
          overflowY: state === "executing" ? "auto" : "visible",
          padding: "8px 8px 4px",
        }}
      >
        {planGroups.map((g) => (
          <div key={g.phase}>
            <div style={{ padding: "10px 9px 3px" }}>
              <span
                style={{
                  font: "600 10px/1 Geist, sans-serif",
                  color: "var(--fg-3)",
                  letterSpacing: "0.07em",
                  textTransform: "uppercase",
                }}
              >
                {g.phase}
              </span>
            </div>
            {g.nodes.map((n) => (
              <PlanRow key={n.id} node={n} network={network} />
            ))}
          </div>
        ))}
      </div>

      {/* ─── footer: action buttons (state-specific) ─── */}
      {state === "succeeded" || state === "failed" ? (
        <div
          style={{
            display: "flex",
            gap: 10,
            padding: "16px 18px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-2)",
          }}
        >
          {state === "failed" ? (
            <>
              <button
                type="button"
                onClick={onRetry}
                data-testid="demolish-retry"
                style={{
                  flex: 1,
                  height: 40,
                  padding: "0 16px",
                  borderRadius: 10,
                  border: "1px solid var(--border-2)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  fontWeight: 600,
                  fontSize: 13.5,
                  cursor: "pointer",
                }}
              >
                Retry
              </button>
              <button
                type="button"
                onClick={onReset}
                data-testid="demolish-failed-reset"
                style={{
                  flex: 1,
                  height: 40,
                  padding: "0 16px",
                  borderRadius: 10,
                  border: "1px solid var(--accent-line)",
                  background: "transparent",
                  color: "var(--accent)",
                  fontWeight: 600,
                  fontSize: 13.5,
                  cursor: "pointer",
                }}
              >
                Start over
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={copyReceipt}
                data-testid="demolish-copy-receipt"
                style={{
                  height: 40,
                  padding: "0 16px",
                  borderRadius: 10,
                  border: "1px solid var(--border-2)",
                  background: "var(--surface)",
                  color: copied ? "var(--success)" : "var(--fg)",
                  fontWeight: 600,
                  fontSize: 13.5,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {copied ? "Copied ✓" : "Copy receipt"}
              </button>
              <Link
                href="/"
                data-testid="demolish-reset"
                style={{
                  flex: 1,
                  height: 40,
                  padding: "0 16px",
                  borderRadius: 10,
                  border: "1px solid var(--accent-line)",
                  background: "transparent",
                  color: "var(--accent)",
                  fontWeight: 600,
                  fontSize: 13.5,
                  cursor: "pointer",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                Back to landing
              </Link>
            </>
          )}
        </div>
      ) : null}

      {/* failed-state raw error (collapsed, available but out of the way) */}
      {state === "failed" && error ? (
        <details
          style={{
            margin: 0,
            padding: "10px 16px 14px",
            background: "var(--surface)",
            borderTop: "1px solid var(--border)",
            fontSize: 11.5,
            color: "var(--fg-3)",
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              listStyle: "revert",
            }}
          >
            raw error
          </summary>
          <pre
            style={{
              margin: "8px 0 0",
              padding: 0,
              font: "500 11px/1.5 'Geist Mono', monospace",
              color: "var(--fg-2)",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap",
              maxHeight: 200,
              overflowY: "auto",
            }}
          >
            {error}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

// Human QA sign-off — the dedicated step before anything executes. Lists every
// operation to be run, requires an explicit acknowledgment and a typed
// last-4-char confirmation (with a short unlock delay), then triggers execution.
// This replaces the old stacked high-value + typed-confirmation modals.
// The combined Review step — the clean "here is what will happen". Plan
// overview, every operation grouped, destination + account snapshot. No
// cautions or warnings (those are acknowledged in the Resolve step); the final
// gate is the typed-confirmation dialog opened by "Demolish account".
function ReviewPanel({
  planGroups,
  totalXlm,
  activeCount,
  destination,
  network,
  snapshot,
  onBack,
  onDemolish,
}: {
  readonly planGroups: ReadonlyArray<{ phase: string; nodes: readonly PlanNode[] }>;
  readonly totalXlm: string;
  readonly activeCount: number;
  readonly destination: string;
  readonly network: NetworkConfig;
  readonly snapshot: {
    readonly pkShort: string;
    readonly sub: number;
    readonly trustlines: number;
    readonly offers: number;
    readonly data: number;
    readonly claimable: number;
  } | null;
  readonly onBack: () => void;
  readonly onDemolish: () => void;
}): React.JSX.Element {
  const required = destination.length >= 4 ? destination.slice(-4) : destination;
  const destHead = destination.length > 4 ? destination.slice(0, -4) : "";

  // flatten for numbering + total network cost
  const allNodes = planGroups.flatMap((g) => g.nodes);
  const totalFeeStroops = allNodes.reduce((sum, n) => sum + nodeFeeStroops(n), 0);
  const indexOf = new Map(allNodes.map((n, i) => [n.id, i + 1]));

  return (
    <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ marginBottom: 12 }}>
          <Badge tone="success" dot>
            PLAN SIMULATED
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Review the close-out
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          {activeCount} {activeCount === 1 ? "step runs" : "steps run"} in order — here is exactly
          what will happen. Nothing is signed until you confirm.
        </p>
      </div>

      <StatGrid
        stats={[
          { label: "Forwarded to destination", value: `${totalXlm} XLM` },
          { label: "Reserve recovered", value: "+1.0 XLM", tone: "accent" },
          { label: "Network fees", value: `≈ ${stroopsToXlm(totalFeeStroops)} XLM` },
        ]}
      />

      {/* every operation, grouped */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
        {planGroups.map((g, gi) => {
          const irreversible = g.phase === "Merge" || g.phase === "Mediator forward";
          return (
            <div
              key={g.phase}
              style={{ borderTop: gi > 0 ? "1px solid var(--border)" : undefined }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "11px 14px 5px",
                }}
              >
                <SectionLabel>{g.phase}</SectionLabel>
                {irreversible ? <Badge tone="danger">Irreversible</Badge> : null}
              </div>
              <div style={{ padding: "0 6px 6px" }}>
                {g.nodes.map((n) => (
                  <PlanRow
                    key={n.id}
                    node={n}
                    network={network}
                    mode="plan"
                    index={indexOf.get(n.id) ?? 0}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* destination + amount + account snapshot */}
      <div
        style={{
          borderRadius: 12,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 6 }}>MERGES TO</div>
          <div style={{ font: "600 13.5px/1.5 'Geist Mono', monospace", wordBreak: "break-all" }}>
            <span style={{ color: "var(--fg-2)" }}>{destHead}</span>
            <span style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "underline" }}>
              {required}
            </span>
          </div>
          <div style={{ marginTop: 9, fontSize: 13, color: "var(--fg-2)" }}>
            Forwarding{" "}
            <span style={{ font: "600 13px 'Geist Mono', monospace", color: "var(--fg)" }}>
              {totalXlm} XLM
            </span>{" "}
            and permanently closing the account.
          </div>
        </div>
        {snapshot ? (
          <div
            style={{
              padding: "12px 16px",
              borderTop: "1px solid var(--border)",
              display: "flex",
              gap: 22,
              flexWrap: "wrap",
              alignItems: "flex-start",
            }}
          >
            <SnapStat label="Account" value={snapshot.pkShort} mono />
            <SnapStat label="Subentries" value={snapshot.sub} />
            <SnapStat label="Trustlines" value={snapshot.trustlines} />
            <SnapStat label="Offers" value={snapshot.offers} />
            <SnapStat label="Data" value={snapshot.data} />
            <SnapStat label="Claimable" value={snapshot.claimable} />
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 11 }}>
        <Button variant="secondary" onClick={onBack} data-testid="review-back">
          Back
        </Button>
        <Button
          variant="danger"
          onClick={onDemolish}
          data-testid="demolish-confirm"
          style={{ flex: 1 }}
          iconLeft={
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          }
        >
          Demolish account
        </Button>
      </div>
    </Card>
  );
}

function PlanRow({
  node,
  network,
  mode = "live",
  index,
}: {
  readonly node: PlanNode;
  readonly network: NetworkConfig;
  // "plan" = pre-execution review (numbered, shows the XLM fee, no status);
  // "live" = during/after execution (status indicator, tx link, no fee)
  readonly mode?: "plan" | "live";
  readonly index?: number;
}): React.JSX.Element {
  const isDone = node.status === "confirmed";
  const isRunning = node.status === "signed" || node.status === "submitted";
  const isSkipped = node.status === "skipped";
  const isFailed = node.status === "failed";
  const isPending = !isDone && !isRunning && !isSkipped && !isFailed;

  // plan mode surfaces the network fee up-front so cost is visible before
  // signing; live mode drops it (once submitted the fee is spent and the tx
  // link is what matters). "auth" (Soroban auth-entry count) is dev-only noise
  // and is no longer shown anywhere.
  const feeStroops = nodeFeeStroops(node);
  const showFee = mode === "plan" && feeStroops > 0;
  // live mode highlights the step that's currently signing/submitting
  const highlight = mode === "live" && isRunning;

  return (
    <div style={{ borderRadius: 10, overflow: "hidden" }}>
      <div
        style={{
          width: "100%",
          display: "flex",
          alignItems: "flex-start",
          gap: 11,
          padding: "9px 10px",
          background: highlight ? "var(--surface-2)" : "none",
          border: "none",
          borderRadius: 10,
          color: "var(--fg)",
          transition: "background .15s",
        }}
      >
        <span
          style={{
            flexShrink: 0,
            position: "relative",
            width: 24,
            height: 24,
            marginTop: 1,
          }}
        >
          {mode === "plan" ? (
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: "1.5px solid var(--border-2)",
                display: "grid",
                placeItems: "center",
                font: "600 11px/1 'Geist Mono', monospace",
                color: "var(--fg-3)",
              }}
            >
              {index ?? ""}
            </span>
          ) : (
            <>
              {isDone ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    background: "var(--surface-2)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--success)"
                    strokeWidth={3.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
              ) : null}
              {isRunning ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    border: "2px solid var(--accent-soft)",
                    borderTopColor: "var(--accent)",
                    animation: "spin .8s linear infinite",
                  }}
                />
              ) : null}
              {isPending ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 3,
                    borderRadius: "50%",
                    border: "1.5px solid var(--border-2)",
                  }}
                />
              ) : null}
              {isSkipped ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    background: "var(--surface-2)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--warning)"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v4l3 2" />
                  </svg>
                </span>
              ) : null}
              {isFailed ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    background: "var(--surface-2)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--danger)"
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </span>
              ) : null}
            </>
          )}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontWeight: 600,
                fontSize: 13,
                color: isFailed ? "var(--danger)" : "var(--fg)",
              }}
            >
              {nodeLabel(node)}
            </span>
            {isSkipped ? (
              <span
                style={{
                  padding: "2px 6px",
                  borderRadius: 5,
                  background: "var(--surface-2)",
                  font: "600 9.5px/1.2 Geist, sans-serif",
                  color: "var(--warning)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                skipped
              </span>
            ) : null}
            {showFee ? (
              <span
                style={{
                  marginLeft: "auto",
                  font: "500 11px/1 'Geist Mono', monospace",
                  color: "var(--fg-3)",
                  whiteSpace: "nowrap",
                }}
              >
                fee <span style={{ color: "var(--fg-2)" }}>{stroopsToXlm(feeStroops)} XLM</span>
              </span>
            ) : null}
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-3)",
              marginTop: 3,
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={node.description}
            >
              {node.description}
            </span>
            {node.executed?.txHash ? (
              <a
                href={explorerTxUrl(network, node.executed.txHash)}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  font: "500 11px/1 'Geist Mono', monospace",
                  color: "var(--fg-3)",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  whiteSpace: "nowrap",
                }}
                title={node.executed.txHash}
                onClick={(e) => e.stopPropagation()}
              >
                <span>tx {truncateHash(node.executed.txHash)}</span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M7 17 17 7M9 7h8v8" />
                </svg>
              </a>
            ) : null}
          </div>
          {node.error ? (
            <div
              style={{
                marginTop: 5,
                font: "500 11px/1.45 'Geist Mono', monospace",
                color: isSkipped ? "var(--warning)" : "var(--danger)",
                wordBreak: "break-word",
              }}
            >
              {node.error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const DEMO_DESTINATION_ADDRESS = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";

function ConfigurePanel({
  form,
  setForm,
  cex,
  hasMemo,
  formError,
  isBusy,
  canStart,
  onGeneratePlan,
  audit,
  isDemo,
}: {
  readonly form: FormState;
  readonly setForm: React.Dispatch<React.SetStateAction<FormState>>;
  readonly cex: CexInfo | null;
  readonly hasMemo: boolean;
  readonly formError: string | null;
  readonly isBusy: boolean;
  readonly canStart: boolean;
  readonly onGeneratePlan: () => void;
  readonly audit: AccountAudit | null;
  readonly isDemo: boolean;
}): React.JSX.Element {
  const claimables = audit?.claimableBalances ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {claimables.length > 0 ? (
        <div
          data-testid="claimable-balance-list"
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface)",
            borderRadius: 14,
            padding: "18px 20px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: "var(--surface-2)",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--warning)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                </svg>
              </span>
              <span style={{ fontWeight: 600, fontSize: 14.5, color: "var(--fg)" }}>
                Unclaimed claimable balances
              </span>
            </div>
            <span
              style={{
                font: "600 9.5px/1 Geist, sans-serif",
                color: "var(--fg-3)",
                letterSpacing: "0.07em",
                padding: "5px 9px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                whiteSpace: "nowrap",
              }}
            >
              OPTIONAL
            </span>
          </div>
          <p
            style={{
              margin: "0 0 6px",
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--fg-2)",
            }}
          >
            These will be <strong style={{ color: "var(--fg)" }}>forfeited</strong> if you merge
            without claiming. Pick the ones to claim before merge.
          </p>
          {claimables.map((cb) => {
            const checked = form.selectedCbIds.includes(cb.id);
            return (
              <label
                key={cb.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "10px 0",
                  borderTop: "1px solid var(--border)",
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const c = e.currentTarget.checked;
                      setForm((f) =>
                        c
                          ? { ...f, selectedCbIds: [...f.selectedCbIds, cb.id] }
                          : {
                              ...f,
                              selectedCbIds: f.selectedCbIds.filter((id) => id !== cb.id),
                            },
                      );
                    }}
                    data-testid={`cb-checkbox-${cb.id}`}
                    style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
                  />
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      fontFamily: "'Geist Mono', monospace",
                      color: "var(--fg)",
                    }}
                  >
                    {cb.amount}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 11.5,
                    color: "var(--fg-3)",
                    fontFamily: "'Geist Mono', monospace",
                  }}
                >
                  {cb.id.slice(0, 16)}…
                </span>
              </label>
            );
          })}
        </div>
      ) : null}

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: 22,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h2
          style={{
            margin: "0 0 4px",
            fontSize: 19,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--fg)",
          }}
        >
          Where should the funds go?
        </h2>
        <p
          style={{
            margin: "0 0 20px",
            fontSize: 13.5,
            color: "var(--fg-2)",
            lineHeight: 1.5,
          }}
        >
          All non-XLM balances are converted to XLM, then the full reserve is merged to this
          destination.
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginBottom: 8,
          }}
        >
          <label
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: "var(--fg)",
            }}
          >
            Destination address
          </label>
          {isDemo ? (
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, destination: DEMO_DESTINATION_ADDRESS }))}
              data-testid="use-demo-destination"
              title={`Use demo destination ${DEMO_DESTINATION_ADDRESS}`}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                padding: "5px 9px",
                borderRadius: 7,
                border: "1px solid var(--accent-line)",
                background: "var(--surface-2)",
                color: "var(--accent)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Use demo address
            </button>
          ) : null}
        </div>
        <input
          type="text"
          value={form.destination}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setForm((f) => ({ ...f, destination: v }));
          }}
          placeholder="G… wallet or exchange address"
          spellCheck={false}
          autoComplete="off"
          data-testid="destination-input"
          style={{
            width: "100%",
            padding: "13px 14px",
            borderRadius: 11,
            border: "1px solid var(--border-2)",
            background: "var(--surface-2)",
            color: "var(--fg)",
            font: "500 13px/1.3 'Geist Mono', monospace",
            boxSizing: "border-box",
          }}
        />

        {cex ? (
          <div
            data-testid="cex-warning"
            role="alert"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 9,
              marginTop: 13,
              padding: "11px 13px",
              borderRadius: 11,
              background: "var(--surface-2)",
              border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--warning)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0, marginTop: 1 }}
            >
              <path d="M12 9v4M12 17h.01" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            <span style={{ fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.45 }}>
              <strong style={{ color: "var(--fg)" }}>CEX detected: {cex.name}.</strong> Mediator
              routing is on automatically.{" "}
              {cex.requiresMemo
                ? `${cex.name} requires a ${cex.memoType ?? "text"} memo. Add one below.`
                : ""}
            </span>
          </div>
        ) : null}

        <label
          style={{
            display: "block",
            fontWeight: 600,
            fontSize: 13,
            margin: "18px 0 8px",
            color: "var(--fg)",
          }}
        >
          Memo{" "}
          <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>
            , required for most exchanges
          </span>
        </label>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ minWidth: 130 }}>
            <Select
              value={form.memoType}
              onChange={(v) => setForm((f) => ({ ...f, memoType: v as FormState["memoType"] }))}
              ariaLabel="Memo type"
              data-testid="memo-type-select"
              options={[
                { value: "none", label: "None" },
                { value: "text", label: "Text" },
                { value: "id", label: "ID" },
                { value: "hash", label: "Hash" },
                { value: "return", label: "Return" },
              ]}
            />
          </div>
          <input
            type="text"
            value={form.memoValue}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setForm((f) => ({ ...f, memoValue: v }));
            }}
            disabled={form.memoType === "none"}
            placeholder={form.memoType === "id" ? "12345" : "Optional · text or ID memo"}
            spellCheck={false}
            autoComplete="off"
            data-testid="memo-value-input"
            aria-label="Memo value"
            style={{
              flex: 1,
              padding: "13px 14px",
              borderRadius: 11,
              border: "1px solid var(--border-2)",
              background: "var(--surface-2)",
              color: "var(--fg)",
              font: "500 13px/1.3 'Geist Mono', monospace",
              boxSizing: "border-box",
              opacity: form.memoType === "none" ? 0.55 : 1,
            }}
          />
        </div>

        {hasMemo ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              marginTop: 13,
              padding: "11px 13px",
              borderRadius: 11,
              background: "var(--surface-2)",
              border: "1px solid var(--accent-line)",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 16v-4M12 8h.01" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            <span style={{ fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.45 }}>
              <strong style={{ color: "var(--fg)" }}>Mediator mode.</strong> A memo signals an
              exchange destination, the merge routes through a mediator account so the memo is
              preserved.
            </span>
          </div>
        ) : null}

        <label
          style={{
            display: "block",
            fontWeight: 600,
            fontSize: 13,
            margin: "18px 0 8px",
            color: "var(--fg)",
          }}
        >
          Recovery address <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>· optional</span>
        </label>
        <input
          type="text"
          value={form.fallback}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setForm((f) => ({ ...f, fallback: v }));
          }}
          placeholder="G… (defaults to destination)"
          spellCheck={false}
          autoComplete="off"
          data-testid="fallback-input"
          style={{
            width: "100%",
            padding: "13px 14px",
            borderRadius: 11,
            border: "1px solid var(--border-2)",
            background: "var(--surface-2)",
            color: "var(--fg)",
            font: "500 13px/1.3 'Geist Mono', monospace",
            boxSizing: "border-box",
          }}
        />
        <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>
          If an exchange (mediator) transfer can&apos;t be delivered, funds are sent here instead.
          Leave blank to fall back to the destination above.
        </p>

        {formError ? (
          <p
            role="alert"
            data-testid="form-error"
            style={{
              margin: "12px 0 0",
              fontSize: 12.5,
              color: "var(--danger)",
              fontWeight: 500,
            }}
          >
            {formError}
          </p>
        ) : null}

        <div style={{ marginTop: 20 }}>
          <Button
            variant="primary"
            size="lg"
            onClick={onGeneratePlan}
            disabled={!canStart || isBusy}
            loading={isBusy}
            disabledReason="Connect an account and meet any signing threshold first"
            data-testid="demolish-start"
            style={{ width: "100%" }}
            iconRight={
              isBusy ? undefined : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              )
            }
          >
            {isBusy ? "Building plan…" : "Build & simulate plan"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// consolidated "handled automatically, no action needed" line — replaces the
// separate claimable + sponsorship notices that used to stack in Review.
function SnapStat({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          fontSize: 10,
          color: "var(--fg-3)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <span
        style={{
          font: mono ? "500 12px/1 'Geist Mono', monospace" : "600 14px/1 'Geist Mono', monospace",
          color: "var(--fg)",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// small acknowledgment control rendered in each resolution card's footer
function AckRow({
  checked,
  onChange,
  testId,
}: {
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <Checkbox
      checked={checked}
      onChange={onChange}
      data-testid={testId}
      label="I've read and understand this"
    />
  );
}

const ARROW_RIGHT = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

// The Resolve step — ACTIONS only. Blockers (balances with no XLM path) each
// need to be gone before the close-out: either return it to its issuer here, or
// dispose of it yourself elsewhere. "Rebuild plan" re-scans with whatever choices
// you've made — including none, for the dispose-it-yourself path (after which a
// fresh scan simply finds no blocker).
function ResolvePanel({
  credits,
  network,
  consented,
  onToggle,
  onRebuild,
  onBack,
}: {
  readonly credits: readonly ResidueConsentCredit[];
  readonly network: NetworkConfig;
  readonly consented: readonly string[];
  readonly onToggle: (key: string, consent: boolean) => void;
  readonly onRebuild: () => void;
  readonly onBack: () => void;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ marginBottom: 12 }}>
          <Badge tone="warning" dot>
            Action needed
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Resolve before you continue
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          This account holds balances that block the close-out. Return each to its issuer, or
          dispose of it yourself first, then rebuild the plan.
        </p>
      </div>

      <ResidueConsent
        credits={credits}
        network={network}
        consented={consented}
        onToggle={onToggle}
        onRebuild={onRebuild}
        hideRebuild
      />

      <div style={{ display: "flex", gap: 11, marginTop: 4 }}>
        <Button variant="secondary" onClick={onBack} data-testid="resolve-back">
          Back
        </Button>
        <Button
          variant="primary"
          onClick={onRebuild}
          data-testid="resolve-rebuild"
          style={{ flex: 1 }}
          iconLeft={
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
            </svg>
          }
        >
          Rebuild plan
        </Button>
      </div>
    </div>
  );
}

// The Acknowledge step — INFORMATION only. Warnings and info that don't block
// the close-out but must be read and understood. "Continue to review" is gated
// until every card is acknowledged.
function AcknowledgePanel({
  network,
  scamFindings,
  discoveryWarnings,
  autoHandled,
  highValue,
  onBack,
  onContinue,
}: {
  readonly network: NetworkConfig;
  readonly scamFindings: readonly ScamFinding[];
  readonly discoveryWarnings: readonly string[];
  readonly autoHandled: { readonly claimableCount: number; readonly sponsorshipCount: number };
  readonly highValue: { readonly totalXlm: string } | null;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}): React.JSX.Element {
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const setAck = (key: string, v: boolean) => setAcks((a) => ({ ...a, [key]: v }));

  const hasScam = scamFindings.length > 0;
  const hasDiscovery = discoveryWarnings.length > 0;
  const autoParts: string[] = [];
  if (autoHandled.claimableCount > 0) {
    const n = autoHandled.claimableCount;
    autoParts.push(
      `Collects ${n} pending payment${n === 1 ? "" : "s"} waiting for this account (a “claimable balance”) into your XLM before closing.`,
    );
  }
  if (autoHandled.sponsorshipCount > 0) {
    const n = autoHandled.sponsorshipCount;
    autoParts.push(
      `Frees ${n} XLM deposit${n === 1 ? "" : "s"} this account had locked up as a reserve (a “sponsorship”) back into your balance.`,
    );
  }
  const hasAutoHandled = autoParts.length > 0;
  const hasHighValue = highValue !== null;

  const requiredAckKeys: string[] = [
    hasScam ? "scam" : null,
    hasDiscovery ? "discovery" : null,
    hasAutoHandled ? "autoHandled" : null,
    hasHighValue ? "highValue" : null,
  ].filter((k): k is string => k !== null);
  const allAcked = requiredAckKeys.every((k) => acks[k] === true);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ marginBottom: 12 }}>
          <Badge tone="warning" dot>
            Before you continue
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Read and acknowledge
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          These don&apos;t block the close-out, but make sure you understand each one before you
          continue.
        </p>
      </div>

      {hasScam ? (
        <ScamTokenNotice
          findings={scamFindings}
          network={network}
          footer={
            <AckRow
              checked={acks.scam === true}
              onChange={(v) => setAck("scam", v)}
              testId="ack-scam"
            />
          }
        />
      ) : null}

      {hasDiscovery ? (
        <DiscoveryWarnings
          warnings={discoveryWarnings}
          footer={
            <AckRow
              checked={acks.discovery === true}
              onChange={(v) => setAck("discovery", v)}
              testId="ack-discovery"
            />
          }
        />
      ) : null}

      {hasAutoHandled ? (
        <Notice
          tone="neutral"
          role="status"
          data-testid="auto-handled-notice"
          title="Handled for you — nothing to do"
          footer={
            <AckRow
              checked={acks.autoHandled === true}
              onChange={(v) => setAck("autoHandled", v)}
              testId="ack-autohandled"
            />
          }
        >
          The close-out takes care of these automatically — you keep the value, no action needed:
          <ul
            style={{
              listStyle: "disc",
              margin: "7px 0 0",
              paddingLeft: 18,
              display: "flex",
              flexDirection: "column",
              gap: 5,
            }}
          >
            {autoParts.map((p) => (
              <li key={p} style={{ lineHeight: 1.5 }}>
                {p}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {highValue ? (
        <Notice
          tone="warning"
          title="High-value account"
          data-testid="high-value-notice"
          footer={
            <AckRow
              checked={acks.highValue === true}
              onChange={(v) => setAck("highValue", v)}
              testId="ack-highvalue"
            />
          }
        >
          This account holds {highValue.totalXlm} XLM (over {HIGH_VALUE_THRESHOLD_XLM} XLM). Once
          merged it cannot be recovered.
        </Notice>
      ) : null}

      <div style={{ display: "flex", gap: 11, marginTop: 4 }}>
        <Button variant="secondary" onClick={onBack} data-testid="acknowledge-back">
          Back
        </Button>
        <Button
          variant="primary"
          onClick={onContinue}
          disabled={!allAcked}
          disabledReason={allAcked ? undefined : "Acknowledge every item to continue"}
          data-testid="acknowledge-continue"
          style={{ flex: 1 }}
          iconRight={ARROW_RIGHT}
        >
          Continue to review
        </Button>
      </div>
    </div>
  );
}

// kept around for potential future reuse (e.g., a verbose log mode); the
// execute step now uses the plan tree directly
// parse a demolisher error string into a human-readable summary + structured
interface ParsedError {
  readonly summary: string;
  readonly txCode: string | null;
  readonly ops: readonly string[];
}
function parseDemolishError(raw: string | null): ParsedError {
  if (!raw) {
    return {
      summary: "An unknown error occurred while running the plan.",
      txCode: null,
      ops: [],
    };
  }
  // try to find an embedded result_codes json object
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const blob = raw.slice(jsonStart, jsonEnd + 1);
    try {
      const parsed = JSON.parse(blob) as {
        readonly transaction?: string;
        readonly operations?: readonly string[];
      };
      const txCode = typeof parsed.transaction === "string" ? parsed.transaction : null;
      const ops = Array.isArray(parsed.operations)
        ? (parsed.operations.filter((o) => typeof o === "string") as string[])
        : [];
      const firstBadIdx = ops.findIndex((o) => o !== "op_success");
      const summary =
        firstBadIdx >= 0
          ? `Operation ${firstBadIdx + 1} of ${ops.length} rejected with ${ops[firstBadIdx]}. ${txCode ? `Transaction status: ${txCode}.` : ""}`
          : raw.slice(0, jsonStart).trim() || (txCode ? `Transaction ${txCode}.` : raw);
      return { summary, txCode, ops };
    } catch {
      // fall through to raw
    }
  }
  return { summary: raw, txCode: null, ops: [] };
}

function CancelledPanel({ onResume }: { readonly onResume: () => void }): React.JSX.Element {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 24,
        boxShadow: "var(--shadow-sm)",
        textAlign: "center",
      }}
    >
      <p style={{ margin: "0 0 16px", fontSize: 14, color: "var(--fg-2)" }}>
        Demolition was cancelled. No transactions were signed or submitted.
      </p>
      <button
        type="button"
        onClick={onResume}
        data-testid="demolish-reset"
        style={{
          padding: "12px 18px",
          borderRadius: 11,
          border: "1px solid var(--accent-line)",
          background: "transparent",
          color: "var(--accent)",
          fontWeight: 600,
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        Start over
      </button>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseMemo(form: FormState): ClassicMemo | undefined {
  if (form.memoType === "none") return undefined;
  const value = form.memoValue.trim();
  if (value.length === 0) return undefined;
  return { type: form.memoType, value } as ClassicMemo;
}

function truncateHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}
