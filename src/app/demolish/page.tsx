"use client";

// orchestrator-driven demolition UI, styled to match the dc design (lines 492-775 + modals)
// wires the page-flow xstate machine and the plan tree

import { useMachine } from "@xstate/react";
import { BASE_FEE, Keypair, StrKey } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { AppShell } from "@/components/layout/AppShell";
import {
  AddressActions,
  Badge,
  Button,
  Card,
  Checkbox,
  CopyableAddress,
  InfoTip,
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
import { SponsoringBlock } from "@/components/warnings/SponsoringBlock";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { CreateTestAccountButton } from "@/components/wallet/CreateTestAccountButton";
import { MultisigSigners, type AddedSigner } from "@/components/wallet/MultisigSigners";
import { SecretKeyFallback } from "@/components/wallet/SecretKeyFallback";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/explorer";
import Link from "next/link";
import { useNetworkStore } from "@/stores/network";
import { CollectSignaturesStep } from "@/components/multisig/CollectSignaturesStep";
import { CreatePlanPanel } from "@/components/multisig/CreatePlanPanel";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { pageFlowMachine } from "@/lib/orchestrator/page-flow-machine";
import { auditAccount } from "@/lib/stellar/account-audit";
import { lookupCex, requireMemoEnforcement, type CexInfo } from "@/lib/safety/cex-registry";
import { runScamHeuristics, type ScamFinding } from "@/lib/safety/scam-heuristics";
import { topologicalOrder, type PlanNode } from "@/lib/plan/tree";
import type { AccountAudit, AuditSigner } from "@/lib/types/account";
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
  sendToDestination: z.array(z.string()),
});

type FormState = z.infer<typeof FORM_SCHEMA>;

const INITIAL_FORM: FormState = {
  destination: "",
  memoType: "none",
  memoValue: "",
  fallback: "",
  selectedCbIds: [],
  returnToIssuer: [],
  sendToDestination: [],
};

// ─── derived helpers ────────────────────────────────────────────────────────

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

// plain, non-jargon primary label for a plan step. The protocol name from
// nodeLabel() is still shown as secondary text so power users keep the detail.
function nodePlainLabel(node: PlanNode): string {
  switch (node.kind) {
    case "RevokeAllowance":
      return "Cancel a token spending permission";
    case "RepayBlend":
      return "Repay a loan on Blend";
    case "PayFxDAODebt":
      return "Repay your FxDAO vault";
    case "WithdrawBlend":
      return "Withdraw from Blend (a lending app)";
    case "WithdrawAquarius":
      return "Withdraw from an Aquarius pool";
    case "WithdrawSoroswapLp":
      return "Withdraw from a Soroswap pool";
    case "ClaimBlendEmissions":
      return "Collect Blend rewards";
    case "ClaimAquariusRewards":
      return "Collect Aquarius rewards";
    case "ConvertSorobanToXLM":
      return "Turn a leftover token into XLM";
    case "TransferAsIs":
      return "Move a leftover token out";
    case "BackstopQueue":
      return "Start a Blend backstop withdrawal";
    case "FinalClassicTx":
      return "Close the account and send everything";
    case "MediatorForward":
      return "Deliver your funds to the destination";
  }
}

// a plain-language "what this step does, and is it safe" line, shown as a tooltip
// on each step in the Review so the plan reads clearly to a non-expert. Every
// step before the final one is reversible on its own; only the close is not.
function nodeExplainer(node: PlanNode): string {
  switch (node.kind) {
    case "RevokeAllowance":
      return "Cancels a permission you once gave an app to spend a token for you. The account doesn't need it to close, and leaving stray permissions around is a security risk, so we clear it.";
    case "RepayBlend":
      return "Pays back what you borrowed on Blend, using your own balance, so your deposited collateral can be released.";
    case "PayFxDAODebt":
      return "Pays off your FxDAO vault so the collateral locked inside it is returned to your account.";
    case "WithdrawBlend":
      return "Pulls your deposit back out of Blend (a lending app) and into your account, so it can be converted and sent with everything else.";
    case "WithdrawAquarius":
      return "Pulls your share of an Aquarius liquidity pool back into your account.";
    case "WithdrawSoroswapLp":
      return "Pulls your share of a Soroswap liquidity pool back into your account.";
    case "ClaimBlendEmissions":
      return "Collects the reward tokens Blend owes you before you leave, so you don't leave them behind.";
    case "ClaimAquariusRewards":
      return "Collects the reward tokens Aquarius owes you before you leave, so you don't leave them behind.";
    case "ConvertSorobanToXLM":
      return "Swaps a leftover token into XLM at the market rate, so your whole account ends up as a single XLM balance.";
    case "TransferAsIs":
      return "Moves a leftover token out of the account so its trustline can be removed.";
    case "BackstopQueue":
      return "Starts the required waiting period before a Blend backstop deposit can be withdrawn. You'll finish that withdrawal later.";
    case "FinalClassicTx":
      return "The last step. It converts anything left to XLM, sends your whole balance to the destination, and permanently deletes the account, all in one transaction. This is the irreversible one.";
    case "MediatorForward":
      return "Delivers your funds to the destination through a short-lived helper account, so your exchange deposit memo is preserved along the way.";
  }
}

// plain display name for a plan phase group. The grouping key stays as
// phaseForNode() so logic (e.g. the irreversible check) is unaffected.
function phasePlainLabel(phase: string): string {
  switch (phase) {
    case "Allowances":
      return "Token permissions";
    case "DeFi debt":
      return "Repay loans";
    case "DeFi withdrawals":
      return "Withdraw from apps";
    case "Claim rewards":
      return "Collect rewards";
    case "Liquidation":
      return "Convert leftovers to XLM";
    case "Queued backstop":
      return "Backstop withdrawal";
    case "Merge":
      return "Close the account";
    case "Mediator forward":
      return "Deliver to destination";
    default:
      return phase;
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

// decimal XLM string -> integer stroops (for display-side net/fee arithmetic)
function xlmToStroops(xlm: string): number {
  const [whole = "0", frac = ""] = xlm.trim().split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return Number(BigInt(whole || "0") * 10_000_000n + BigInt(fracPadded || "0"));
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
  // a shared signing plan was created and is collecting signatures: the flow is
  // past Configure and now closing, so mark "Close" active even though the
  // machine is technically still in the configure state.
  readonly planCollecting?: boolean;
}): readonly FlowStep[] {
  const { phase, hasResolve, hasAcknowledge, isSucceeded, planCollecting } = args;
  const labels = [
    "Connect",
    "Configure",
    ...(hasResolve ? ["Fix issues"] : []),
    ...(hasAcknowledge ? ["Warnings"] : []),
    "Review",
    "Close",
  ];

  const activeLabel = planCollecting
    ? "Close"
    : phase === "connect"
      ? "Connect"
      : phase === "configure"
        ? "Configure"
        : phase === "resolve"
          ? "Fix issues"
          : phase === "acknowledge"
            ? "Warnings"
            : phase === "review"
              ? "Review"
              : "Close";
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
  // the full audit from the multisig preflight. The machine's ctx.audit isn't
  // populated until the plan is generated (after signers are gathered), but the
  // "create a signing plan" path needs the audit up-front at the configure gate.
  const [preflightAudit, setPreflightAudit] = useState<AccountAudit | null>(null);
  // once a multisig signing plan is created, the close flow advances to an
  // inline "collect signatures" step (this hash), instead of navigating to /plan.
  const [planHash, setPlanHash] = useState<string | null>(null);
  // the "advanced: paste every key and sign live" path is collapsed by default;
  // the shareable plan above is the recommended, safer route.
  const [advancedSignOpen, setAdvancedSignOpen] = useState(false);
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
        setPreflightAudit(a);
      })
      .catch(() => {
        if (!cancelled) {
          setMultisig(null);
          setPreflightAudit(null);
        }
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

  // whether the account holds Soroban (smart-contract) positions. Those each need
  // their own transaction, so they can't be bundled into a single multisig
  // signing plan; the CreatePlanPanel uses this to gate the async path.
  const hasSorobanPositions =
    ctx.positions.blend.length > 0 ||
    ctx.positions.aquarius.length > 0 ||
    ctx.positions.soroswap.length > 0 ||
    ctx.positions.fxdao.length > 0;

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

  // total native balance + high-value flag, needed by the Resolve step and the
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
  const planBuilt = tree !== null;
  const flowSteps = useMemo(
    () =>
      buildFlowSteps({
        phase: flowPhase,
        hasResolve: planBuilt && hasBlocker,
        hasAcknowledge: planBuilt && hasAckItems && !hasBlocker,
        isSucceeded,
        planCollecting: planHash !== null,
      }),
    [flowPhase, planBuilt, hasBlocker, hasAckItems, isSucceeded, planHash],
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

  const setConnector = useCallback((c: Connector | null) => {
    connectorRef.current = c;
    setHasConnector(c !== null);
    // a new/cleared connection invalidates any collected multisig signers.
    // Use functional updates that return the SAME reference when already reset.
    // ConnectButton re-notifies every render, so a fresh `[]`/`null` here would
    // create a new reference each time and spin an infinite render loop.
    setMultisig((prev) => (prev === null ? prev : null));
    setPreflightAudit((prev) => (prev === null ? prev : null));
    setPlanHash((prev) => (prev === null ? prev : null));
    setExtraSigners((prev) => (prev.length === 0 ? prev : []));
  }, []);

  // once the account is closed it no longer exists, drop the connection so a
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
        ...(form.sendToDestination.length > 0
          ? { sendToDestinationAssetKeys: form.sendToDestination }
          : {}),
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
    // the account we operated on is gone (merged) or abandoned, fully drop the
    // connection so "Start over" returns to Connect, not Configure with a dead
    // account still selected.
    setConnector(null);
    setActiveConnector(null);
    disconnectWallet();
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
  // acctThreshold is no longer surfaced now that AuditCard was dropped from preview;
  // keep the derivation for potential future re-use without tripping lint
  void (audit ? thresholdLabel(audit) : "");
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

          {/* single-column flow content, configure / review / sign-off / cancelled.
              No side rail and no modals: the plan detail lives in the sign-off step. */}
          {!(isDiscovering || isPreviewing) && !isExecuting && !isSucceeded && !isFailed ? (
            <div style={{ maxWidth: 1080, margin: "0 auto" }}>
              {isConfiguring ? (
                planHash !== null ? (
                  /* a shared plan was created: watch the signatures come in, in
                     place. No navigating off to /plan and losing the flow. */
                  <CollectSignaturesStep
                    hash={planHash}
                    network={network}
                    connectedKey={publicKey}
                  />
                ) : multisigRequired && (audit ?? preflightAudit) ? (
                  /* shared account, plan-first: configure the close, then the
                     recommended shareable plan, with the live paste-all-keys
                     path tucked into an advanced disclosure. */
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <MultisigContextBar threshold={multisig?.threshold ?? 0} have={primaryWeight} />
                    {audit && numCoverable > 0 ? (
                      <SponsorshipAutoRevokeNotice count={numCoverable} />
                    ) : null}
                    <FlowSectionLabel>Set up the close</FlowSectionLabel>
                    <ConfigurePanel
                      form={form}
                      setForm={setForm}
                      cex={cex}
                      hasMemo={hasMemo}
                      formError={formError}
                      isBusy={false}
                      canStart={false}
                      startHint={null}
                      onGeneratePlan={onStart}
                      audit={audit}
                      isDemo={isDemo}
                      hideContinue
                      assetIntro="Your whole XLM balance, including the small reserve every account locks, goes to the address below and the account is permanently closed. Any tokens are returned to their issuers, since a shared close can't safely sell them on the market."
                    />
                    <FlowSectionLabel>Get it signed</FlowSectionLabel>
                    <CreatePlanPanel
                      audit={(audit ?? preflightAudit)!}
                      destination={form.destination}
                      destinationReady={destinationGate.ready}
                      network={network}
                      connectorRef={connectorRef}
                      hasConnector={hasConnector}
                      disposal={{
                        returnToIssuer: form.returnToIssuer,
                        sendToDestination: form.sendToDestination,
                      }}
                      hasSorobanPositions={hasSorobanPositions}
                      hasSelectedAllowances={false}
                      useMediator={useMediator}
                      onPlanCreated={setPlanHash}
                    />
                    <AdvancedSignSection
                      open={advancedSignOpen}
                      onToggle={() => setAdvancedSignOpen((o) => !o)}
                    >
                      {multisig ? (
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
                      <div style={{ marginTop: 14 }}>
                        <Button
                          variant="secondary"
                          size="lg"
                          style={{ width: "100%" }}
                          onClick={onStart}
                          disabled={
                            !(
                              publicKey !== null &&
                              hasConnector &&
                              multisigReady &&
                              destinationGate.ready
                            )
                          }
                          disabledReason={
                            !multisigReady
                              ? "Add signer keys above until the total weight is met"
                              : !destinationGate.ready
                                ? (destinationGate.hint ?? "Choose a valid destination above first")
                                : undefined
                          }
                          data-testid="demolish-start"
                        >
                          Continue, preview the plan
                        </Button>
                      </div>
                    </AdvancedSignSection>
                  </div>
                ) : (
                  /* single-signer account: unchanged config + live continue */
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
                      canStart={publicKey !== null && hasConnector && destinationGate.ready}
                      startHint={
                        publicKey === null || !hasConnector
                          ? "Connect a wallet to continue."
                          : destinationGate.hint
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
                  onBack={onCancel}
                  onContinue={() => setConfirmStage("review")}
                />
              ) : null}

              {/* REVIEW, the clean "here is what will happen": plan overview,
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
                />
              ) : null}

              {isCancelled ? <CancelledPanel onResume={() => send({ type: "RESET" })} /> : null}
            </div>
          ) : null}

          {/* final gate, typed-confirmation dialog, opened from Review */}
          {showConfirmDialog ? (
            <TypedConfirmation
              destination={form.destination}
              explorerUrl={explorerAccountUrl(network, form.destination)}
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
    <div style={{ maxWidth: 1080, margin: "8px auto 0" }}>
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
              STEP 1 · CONNECT
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
            }}
          >
            Connect the account you want to close. Closing it permanently removes the account from
            Stellar and sends all its XLM to an address you choose.{" "}
            <strong style={{ color: "var(--fg)", fontWeight: 600 }}>This cannot be undone.</strong>{" "}
            First we safely undo everything attached to it (trusted assets, open trades, saved data,
            extra signers, and DeFi positions). You review and approve every step in your own
            wallet, and nothing is sent without you.
            {isTestnetLike
              ? " New here? Create a free practice account below to try the whole thing first."
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
            <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 420 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>
                Connect a wallet
              </span>
              <span style={{ fontSize: 12.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
                Works with Freighter, xBull, Albedo, Rabet, Lobstr, Hana and WalletConnect.
                Connecting only shares your public address, you approve each step in your wallet,
                and we never see your secret key.
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
              aria-expanded={advancedOpen}
              aria-controls="advanced-secret-panel"
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
                textAlign: "left",
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                  Advanced: paste a secret key
                </span>
                <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 400 }}>
                  For advanced users without a wallet extension. Less safe.
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
                aria-hidden
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {advancedOpen ? (
              <div id="advanced-secret-panel" style={{ padding: "0 17px 17px" }}>
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

      {/* demo setup, takes over as a dedicated step once it starts */}
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

// visually hidden but read by screen readers
const SR_ONLY: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

function StepIndicator({ steps }: { readonly steps: readonly FlowStep[] }): React.JSX.Element {
  return (
    <nav aria-label="Progress">
      <ol
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          flexWrap: "wrap",
          listStyle: "none",
          padding: 0,
          margin: "0 0 26px",
        }}
      >
        {steps.map((st) => (
          <li
            key={st.num}
            aria-current={st.isActive ? "step" : undefined}
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
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
              <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>
                <span style={SR_ONLY}>
                  {st.isDone
                    ? "Completed step: "
                    : st.isActive
                      ? "Current step: "
                      : "Upcoming step: "}
                </span>
                {st.label}
              </span>
            </div>
            {st.notLast ? (
              <span aria-hidden style={{ width: 18, height: 1, background: "var(--border-2)" }} />
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
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
          We&apos;ll release {count === 1 ? "it" : "them"} automatically while closing the account.
          Nothing for you to do.
        </div>
      </div>
    </div>
  );
}

// playful, meaningless-but-fun status quips that cycle under the real message
const LOADING_QUIPS = [
  "Prying open trustlines…",
  "Counting the stardust…",
  "Shaking loose the reserves…",
  "Poking sleepy DeFi positions…",
  "Herding claimable balances…",
  "Sweeping up dust tokens…",
  "Reticulating splines…",
  "Negotiating with the ledger…",
  "Untangling the multisig…",
  "Dusting off forgotten offers…",
  "Warming up the wrecking ball…",
  "Checking under the floorboards…",
];

// a thin (2px) concentric ring stroke: a conic-gradient with one bright accent
// sweep fading to transparent, cut to a ring by a radial mask, rotating slowly.
const RING_MASK =
  "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1px))";
function ArcRing({
  inset,
  sweepDeg,
  dim,
  duration,
  reverse = false,
}: {
  readonly inset: number;
  readonly sweepDeg: number;
  readonly dim: number;
  readonly duration: number;
  readonly reverse?: boolean;
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        inset,
        borderRadius: "50%",
        background: `conic-gradient(from 0deg, color-mix(in srgb, var(--accent) ${dim}%, transparent), transparent ${sweepDeg}deg, transparent 360deg)`,
        maskImage: RING_MASK,
        WebkitMaskImage: RING_MASK,
        animation: `spin ${duration}s linear infinite${reverse ? " reverse" : ""}`,
      }}
    />
  );
}

// one glowing dot placed on an orbit of the given radius at a given angle. The
// lead dot is full accent with a glow; the rest are dimmer accent mixes.
function OrbitDot({
  angle,
  radius,
  size,
  lead = false,
  dim = 100,
}: {
  readonly angle: number;
  readonly radius: number;
  readonly size: number;
  readonly lead?: boolean;
  readonly dim?: number;
}): React.JSX.Element {
  return (
    <span
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: size,
        height: size,
        borderRadius: "50%",
        transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-${radius}px)`,
        background: lead
          ? "var(--accent)"
          : `color-mix(in srgb, var(--accent) ${dim}%, transparent)`,
        ...(lead
          ? { boxShadow: "0 0 8px 1px color-mix(in srgb, var(--accent) 70%, transparent)" }
          : {}),
      }}
    />
  );
}

function LeftLoadingCard({ message }: { readonly message: string }): React.JSX.Element {
  // cycle the fun sub-line; setState lives in the interval callback (async), so
  // it never runs synchronously in the effect body
  const [quipIdx, setQuipIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setQuipIdx((i) => (i + 1) % LOADING_QUIPS.length), 1700);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: "transparent",
        border: "none",
        padding: "60px 28px",
        minHeight: 420,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 30,
        position: "relative",
      }}
    >
      {/* proving stage: a breathing glow, two counter-rotating ring strokes, two
          counter-rotating particle orbits, and a breathing diamond core with a
          search glyph. Calm continuous rotation, never a ping/ripple. The 152px
          stage is drawn to spec, then scaled up (the wrapper reserves layout). */}
      <div
        aria-hidden
        style={{
          width: 228,
          height: 228,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "relative",
            width: 152,
            height: 152,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: "scale(1.5)",
          }}
        >
          {/* ambient glow, breathing */}
          <span
            style={{
              position: "absolute",
              inset: 22,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, color-mix(in srgb, var(--accent) 30%, transparent), transparent 68%)",
              animation: "loaderGlowBreathe 4s ease-in-out infinite",
            }}
          />
          {/* outer ring stroke (faint, longer sweep), clockwise */}
          <ArcRing inset={0} sweepDeg={90} dim={55} duration={4.6} />
          {/* inner ring stroke (brighter, shorter sweep), counter-clockwise */}
          <ArcRing inset={16} sweepDeg={65} dim={90} duration={3.4} reverse />
          {/* outer particle orbit (3 dots), clockwise */}
          <div style={{ position: "absolute", inset: 16, animation: "spin 6s linear infinite" }}>
            <OrbitDot angle={0} radius={60} size={7} lead />
            <OrbitDot angle={142} radius={60} size={5} dim={65} />
            <OrbitDot angle={255} radius={60} size={4} dim={45} />
          </div>
          {/* inner particle orbit (2 dots), counter-clockwise */}
          <div
            style={{
              position: "absolute",
              inset: 33,
              animation: "spin 4.2s linear infinite reverse",
            }}
          >
            <OrbitDot angle={60} radius={43} size={4} dim={70} />
            <OrbitDot angle={220} radius={43} size={3} dim={50} />
          </div>
          {/* diamond core, breathing */}
          <span
            style={{
              position: "relative",
              width: 58,
              height: 58,
              borderRadius: 17,
              border: "2px solid var(--accent)",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              display: "grid",
              placeItems: "center",
              animation: "loaderDiamondBreathe 3.6s ease-in-out infinite",
            }}
          >
            {/* search glyph, counter-rotated so it sits upright inside the diamond */}
            <svg
              width="27"
              height="27"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: "rotate(-45deg)" }}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          </span>
        </div>
      </div>

      <div
        style={{
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          gap: 7,
          position: "relative",
        }}
      >
        <div
          style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)", letterSpacing: "-0.01em" }}
        >
          {message}
        </div>
        {/* cycling fun quip (decorative, not announced to screen readers) */}
        <div
          key={quipIdx}
          aria-hidden
          style={{
            fontSize: 12.5,
            color: "var(--fg-3)",
            animation: "fadeIn 0.4s ease-out",
            minHeight: 18,
          }}
        >
          {LOADING_QUIPS[quipIdx]}
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

  // elapsed seconds while executing, the interval drives it (async setState is
  // fine); it's only read from the executing subtitle
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (state !== "executing") return;
    const start = Date.now();
    const h = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(h);
  }, [state]);

  // a plain-text receipt of an irreversible action, destination + every tx
  const [copied, setCopied] = useState(false);
  const copyReceipt = (): void => {
    const lines = [
      `Account Demolisher, account closed`,
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
        /* clipboard blocked, ignore */
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
                aria-live="polite"
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
                    ? "Couldn't finish closing the account"
                    : "Closing your account"}
              </h2>
              <span
                role="progressbar"
                aria-valuenow={doneCount}
                aria-valuemin={0}
                aria-valuemax={activeCount}
                aria-label={`Closing progress: ${doneCount} of ${activeCount} steps done`}
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
                  was sent to{" "}
                  <span
                    title={destination}
                    style={{ fontFamily: "'Geist Mono', monospace", color: "var(--fg-2)" }}
                  >
                    {destination.length > 10
                      ? `${destination.slice(0, 6)}…${destination.slice(-4)}`
                      : destination}
                  </span>{" "}
                  <AddressActions
                    value={destination}
                    href={explorerAccountUrl(network, destination)}
                    label="destination"
                  />
                  <span style={{ display: "block", marginTop: 7 }}>
                    This account is now permanently closed. If that&apos;s an exchange or another
                    wallet, the funds will appear there shortly.
                  </span>
                </>
              ) : state === "failed" ? (
                (parsed?.summary ??
                "Something went wrong while closing the account. Your funds are safe, try again.")
              ) : (
                <>
                  Your wallet will pop up to approve each step, click{" "}
                  <strong style={{ color: "var(--fg)" }}>Sign</strong> in your wallet when it
                  appears. If nothing seems to happen, check for a wallet window behind this tab.{" "}
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
            title="Open the public record of this transaction on a block explorer"
          >
            <span style={{ fontSize: 10, color: "var(--fg-3)" }}>PROOF</span>
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

        {state === "failed" ? (
          <div
            role="note"
            style={{
              display: "flex",
              gap: 10,
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid color-mix(in srgb, var(--success) 35%, transparent)",
              fontSize: 12.5,
              lineHeight: 1.55,
              color: "var(--fg-2)",
            }}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--success)"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0, marginTop: 1 }}
              aria-hidden
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span>
              <strong style={{ color: "var(--fg)", fontWeight: 600 }}>Your funds are safe.</strong>{" "}
              Your account is still open and its balance is untouched. Any step that already
              finished (marked ✓ above) is done and recorded on Stellar. Nothing was lost. Press
              Retry to continue from where it stopped.
            </span>
          </div>
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
                {phasePlainLabel(g.phase)}
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
                title="Copies a text record of this closure and its transaction links, keep it for your records, since a closed account can't be looked up later."
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
                {copied ? "Copied ✓" : "Save a receipt"}
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

// Human QA sign-off, the dedicated step before anything executes. Lists every
// operation to be run, requires an explicit acknowledgment and a typed
// last-4-char confirmation (with a short unlock delay), then triggers execution.
// This replaces the old stacked high-value + typed-confirmation modals.
// The combined Review step, the clean "here is what will happen". Plan
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
    readonly pk: string;
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

  // Money math the user can trust. `totalXlm` is the WHOLE native balance, the
  // locked reserve is already inside it, not on top. What the destination
  // actually receives is that balance minus network fees. The freed reserve is
  // shown only as context (part of the amount above), never as a bonus, and is
  // the real figure: Stellar locks 0.5 XLM for the account base (×2) plus 0.5
  // per subentry (trustline/offer/signer/data), all released on close.
  const reserveStroops = (2 + (snapshot?.sub ?? 0)) * 5_000_000;
  const netReceivedStroops = Math.max(0, xlmToStroops(totalXlm) - totalFeeStroops);

  return (
    <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ marginBottom: 12 }}>
          <Badge tone="success" dot>
            PLAN READY
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Review before closing
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          {activeCount} {activeCount === 1 ? "step runs" : "steps run"} in order, here is exactly
          what will happen. Nothing happens until you confirm below.
        </p>
      </div>

      <StatGrid
        stats={[
          {
            label: "Destination receives",
            value: `≈ ${stroopsToXlm(netReceivedStroops)} XLM`,
            tone: "accent",
          },
          { label: "Network fees", value: `≈ ${stroopsToXlm(totalFeeStroops)} XLM` },
          { label: "Reserve released (included)", value: `≈ ${stroopsToXlm(reserveStroops)} XLM` },
        ]}
      />
      <p style={{ margin: "-6px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--fg-3)" }}>
        Your whole balance goes to the destination, minus a small{" "}
        <InfoTip tip="A small charge the Stellar network takes to process each step. It is not paid to us.">
          network fee
        </InfoTip>
        . The{" "}
        <InfoTip tip="XLM the network keeps locked in every account while it is open. It is released when the account closes, and is already included in the amount above, not extra.">
          reserve
        </InfoTip>{" "}
        is already part of that amount.
      </p>

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
                <SectionLabel>{phasePlainLabel(g.phase)}</SectionLabel>
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
          <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 6 }}>
            SENDING EVERYTHING TO
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <div style={{ font: "600 13.5px/1.5 'Geist Mono', monospace", wordBreak: "break-all" }}>
              <span style={{ color: "var(--fg-2)" }}>{destHead}</span>
              <span
                style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "underline" }}
              >
                {required}
              </span>
            </div>
            <AddressActions
              value={destination}
              href={explorerAccountUrl(network, destination)}
              label="destination"
            />
          </div>
          <div style={{ marginTop: 9, fontSize: 13, color: "var(--fg-2)" }}>
            Your balance is sent to this address and the account is permanently closed. The
            destination receives{" "}
            <span style={{ font: "600 13px 'Geist Mono', monospace", color: "var(--fg)" }}>
              ≈ {stroopsToXlm(netReceivedStroops)} XLM
            </span>{" "}
            after network fees.
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
                Account
              </span>
              <CopyableAddress
                value={snapshot.pk}
                label="account"
                size={13}
                href={explorerAccountUrl(network, snapshot.pk)}
              />
            </div>
            <SnapStat
              label="Subentries"
              value={snapshot.sub}
              tip="Extra things attached to the account (trustlines, offers, saved data, signers). Each one locks a little XLM as a reserve; all of it is freed when the account closes."
            />
            <SnapStat
              label="Trustlines"
              value={snapshot.trustlines}
              tip="Tokens the account is set up to hold, besides XLM. Each is emptied and removed as part of closing."
            />
            <SnapStat
              label="Offers"
              value={snapshot.offers}
              tip="Open buy/sell orders on Stellar's built-in exchange. They're cancelled before the account closes."
            />
            <SnapStat
              label="Data"
              value={snapshot.data}
              tip="Small key-value notes stored on the account. They're deleted as part of closing."
            />
            <SnapStat
              label="Claimable"
              value={snapshot.claimable}
              tip="Payments set aside for this account that haven't been collected yet. They're claimed into your balance before closing."
            />
          </div>
        ) : null}
      </div>

      <div
        role="note"
        style={{
          display: "flex",
          gap: 10,
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--fg-2)",
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--danger)"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, marginTop: 1 }}
          aria-hidden
        >
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
        <span>
          This permanently deletes your Stellar account and sends all its XLM to the address above.{" "}
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>It cannot be undone.</strong>{" "}
          Double-check the address before continuing.
        </span>
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
          iconRight={
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
          }
        >
          Continue to final confirmation
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
          {mode === "live" ? (
            <span style={SR_ONLY}>
              {isDone
                ? "Done: "
                : isRunning
                  ? "In progress: "
                  : isFailed
                    ? "Failed: "
                    : isSkipped
                      ? "Skipped: "
                      : "Pending: "}
            </span>
          ) : null}
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
            {mode === "plan" ? (
              <InfoTip tip={nodeExplainer(node)}>
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: 13,
                    color: isFailed ? "var(--danger)" : "var(--fg)",
                  }}
                >
                  {nodePlainLabel(node)}
                </span>
              </InfoTip>
            ) : (
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  color: isFailed ? "var(--danger)" : "var(--fg)",
                }}
              >
                {nodePlainLabel(node)}
              </span>
            )}
            <span
              style={{
                font: "500 10.5px/1.2 'Geist Mono', monospace",
                color: "var(--fg-3)",
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
                title={`Open the public record of this step on a block explorer (${node.executed.txHash})`}
                onClick={(e) => e.stopPropagation()}
              >
                <span>proof {truncateHash(node.executed.txHash)}</span>
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

// small uppercase label that groups the multisig configure sections
function FlowSectionLabel({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        font: "600 10.5px/1 Geist, sans-serif",
        letterSpacing: "0.08em",
        color: "var(--fg-3)",
        textTransform: "uppercase",
        margin: "6px 0 -4px 2px",
      }}
    >
      {children}
    </div>
  );
}

// thin neutral orientation bar for a shared account (not an alarm)
function MultisigContextBar({
  threshold,
  have,
}: {
  readonly threshold: number;
  readonly have: number;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        padding: "12px 16px",
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--fg-2)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        Shared account
      </span>
      <span style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
        Signatures needed:{" "}
        <strong style={{ color: "var(--fg-2)", fontWeight: 600 }}>{threshold}</strong> · you have{" "}
        <strong style={{ color: "var(--fg-2)", fontWeight: 600 }}>{have}</strong>
      </span>
    </div>
  );
}

// collapsed disclosure for the "paste every key and sign live" path, honestly
// framed as the less-safe fallback to the recommended shareable plan
function AdvancedSignSection({
  open,
  onToggle,
  children,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 14,
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="multisig-advanced-toggle"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "15px 18px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--fg)",
          textAlign: "left",
        }}
      >
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            Advanced: I hold all the keys, sign here now
          </span>
          <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 400, lineHeight: 1.45 }}>
            Only if every required key is on this device. That means one browser briefly holds them
            all, which is why the shared plan above is safer.
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
          style={{ transform: open ? "rotate(180deg)" : "none", flexShrink: 0 }}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? <div style={{ padding: "0 18px 18px" }}>{children}</div> : null}
    </div>
  );
}

function ConfigurePanel({
  form,
  setForm,
  cex,
  hasMemo,
  formError,
  isBusy,
  canStart,
  startHint,
  onGeneratePlan,
  audit,
  isDemo,
  hideContinue = false,
  assetIntro,
}: {
  readonly form: FormState;
  readonly setForm: React.Dispatch<React.SetStateAction<FormState>>;
  readonly cex: CexInfo | null;
  readonly hasMemo: boolean;
  readonly formError: string | null;
  readonly isBusy: boolean;
  readonly canStart: boolean;
  // why the Build button is disabled (bad/self destination); null = no note
  readonly startHint: string | null;
  readonly onGeneratePlan: () => void;
  readonly audit: AccountAudit | null;
  readonly isDemo: boolean;
  // multisig plan-first path: the live "Continue" CTA moves into the advanced
  // section, so this panel becomes config-only (destination + memo + backup)
  readonly hideContinue?: boolean;
  // override the "every asset is swapped to XLM…" intro (multisig returns tokens
  // to their issuer instead)
  readonly assetIntro?: React.ReactNode;
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
                Payments waiting to be collected
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
              AUTO-COLLECTED
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
            These are payments set aside for this account that you haven&apos;t collected yet. We
            collect all of them into your balance automatically before closing.{" "}
            <strong style={{ color: "var(--fg)" }}>You don&apos;t need to do anything.</strong>{" "}
            Untick any you&apos;d rather leave behind; unticked ones are lost when the account
            closes.
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
          {assetIntro ??
            "Every other asset in this account is swapped to XLM, then your whole XLM balance, including the small amount Stellar keeps locked in every account, is sent to the address below and this account is permanently closed."}
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
            htmlFor="demolish-destination"
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
          id="demolish-destination"
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
          aria-describedby="demolish-destination-help"
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
        <p
          id="demolish-destination-help"
          style={{ margin: "7px 0 0", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}
        >
          Paste the Stellar address (it starts with{" "}
          <strong style={{ color: "var(--fg-2)" }}>G</strong>) of the wallet or exchange account
          that should receive everything. Double-check it. Funds sent to the wrong address cannot be
          recovered.
        </p>

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
              <strong style={{ color: "var(--fg)" }}>Exchange detected: {cex.name}.</strong>{" "}
              We&apos;ll route the transfer so your deposit memo reaches {cex.name} correctly.{" "}
              {cex.requiresMemo
                ? `${cex.name} needs a ${cex.memoType ?? "text"} memo/tag, paste yours below, or your deposit could be lost.`
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
          <InfoTip tip="A tag exchanges use to know a deposit is yours. Exchanges share one deposit address across all customers, so the memo is how they credit it to you.">
            Memo
          </InfoTip>{" "}
          <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>
            {cex?.requiresMemo ? "· required by your exchange" : "· required by most exchanges"}
          </span>
        </label>
        <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>
          If your exchange gave you a deposit memo or tag, paste it here. Sending to an exchange
          without it usually means the funds are lost. Most exchanges use Text or ID.
        </p>
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
            placeholder={
              cex?.requiresMemo
                ? "Required, your exchange deposit memo"
                : form.memoType === "id"
                  ? "12345"
                  : "Your exchange deposit memo or tag"
            }
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
              <strong style={{ color: "var(--fg)" }}>Memo added.</strong> Because a plain account
              close-out can&apos;t carry a memo, we hop the funds through a temporary helper account
              so your exchange still sees the memo and credits your deposit. Nothing extra for you
              to do.
            </span>
          </div>
        ) : null}

        <label
          htmlFor="demolish-fallback"
          style={{
            display: "block",
            fontWeight: 600,
            fontSize: 13,
            margin: "18px 0 8px",
            color: "var(--fg)",
          }}
        >
          <InfoTip tip="A safety net: in the rare case an exchange transfer can't be delivered, your funds go here instead of getting stuck. Leave blank to use the destination above. If you're sending to an exchange, consider your own personal wallet here.">
            Backup address
          </InfoTip>{" "}
          <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>· optional</span>
        </label>
        <input
          id="demolish-fallback"
          type="text"
          value={form.fallback}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setForm((f) => ({ ...f, fallback: v }));
          }}
          placeholder="G… (defaults to the destination above)"
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

        {!hideContinue ? (
          <>
            {startHint !== null && !isBusy ? (
              <p
                role="status"
                data-testid="demolish-start-hint"
                style={{
                  margin: "12px 0 0",
                  fontSize: 12.5,
                  color: "var(--warning)",
                  lineHeight: 1.5,
                }}
              >
                {startHint}
              </p>
            ) : null}

            <div style={{ marginTop: startHint !== null && !isBusy ? 10 : 20 }}>
              <Button
                variant="primary"
                size="lg"
                onClick={onGeneratePlan}
                disabled={!canStart || isBusy}
                loading={isBusy}
                disabledReason={
                  startHint ?? "Connect an account and meet any signing threshold first"
                }
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
                {isBusy ? "Checking your account…" : "Continue, preview the plan"}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// consolidated "handled automatically, no action needed" line, replaces the
// separate claimable + sponsorship notices that used to stack in Review.
function SnapStat({
  label,
  value,
  mono = false,
  tip,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly mono?: boolean;
  readonly tip?: string;
}): React.JSX.Element {
  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    color: "var(--fg-3)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    fontWeight: 600,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {tip ? (
        <InfoTip tip={tip}>
          <span style={labelStyle}>{label}</span>
        </InfoTip>
      ) : (
        <span style={labelStyle}>{label}</span>
      )}
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
  label = "I've read and understand this",
}: {
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly testId: string;
  readonly label?: string;
}): React.JSX.Element {
  return <Checkbox checked={checked} onChange={onChange} data-testid={testId} label={label} />;
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

// The Resolve step, ACTIONS only. Blockers (balances with no XLM path) each
// need to be gone before the close-out: either return it to its issuer here, or
// dispose of it yourself elsewhere. "Rebuild plan" re-scans with whatever choices
// you've made, including none, for the dispose-it-yourself path (after which a
// fresh scan simply finds no blocker).
function ResolvePanel({
  credits,
  network,
  returnToIssuer,
  sendToDestination,
  onSetDisposal,
  onRebuild,
  onBack,
}: {
  readonly credits: readonly ResidueConsentCredit[];
  readonly network: NetworkConfig;
  readonly returnToIssuer: readonly string[];
  readonly sendToDestination: readonly string[];
  readonly onSetDisposal: (key: string, mode: "none" | "issuer" | "destination") => void;
  readonly onRebuild: () => void;
  readonly onBack: () => void;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ marginBottom: 12 }}>
          <Badge tone="warning" dot>
            You need to do something here
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Fix these before continuing
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          A few things on this account have to be cleared before it can close. Handle each one
          below, then re-check.
        </p>
      </div>

      <ResidueConsent
        credits={credits}
        network={network}
        returnToIssuer={returnToIssuer}
        sendToDestination={sendToDestination}
        onSetDisposal={onSetDisposal}
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
          Re-check and continue
        </Button>
      </div>
    </div>
  );
}

// The Acknowledge step, INFORMATION only. Warnings and info that don't block
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
            Just read, nothing to fix
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          A few things to know
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          None of these stop you from closing the account. Please read each one so nothing surprises
          you, then confirm you understand.
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
          title="Handled for you, nothing to do"
          footer={
            <AckRow
              checked={acks.autoHandled === true}
              onChange={(v) => setAck("autoHandled", v)}
              testId="ack-autohandled"
              label="Got it"
            />
          }
        >
          Closing the account takes care of these automatically. You keep the value, and there is
          nothing for you to do:
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
          title="Large balance, double-check before closing"
          data-testid="high-value-notice"
          footer={
            <AckRow
              checked={acks.highValue === true}
              onChange={(v) => setAck("highValue", v)}
              testId="ack-highvalue"
            />
          }
        >
          This account holds {highValue.totalXlm} XLM, a large balance (over{" "}
          {HIGH_VALUE_THRESHOLD_XLM} XLM). Closing it moves this XLM to your destination and
          permanently deletes this account. Double-check the amount and the destination before you
          continue. This can&apos;t be undone.
        </Notice>
      ) : null}

      {!allAcked ? (
        <p
          role="status"
          data-testid="acknowledge-hint"
          style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--warning)", lineHeight: 1.5 }}
        >
          Tick every box above to continue.
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 11, marginTop: 4 }}>
        <Button variant="secondary" onClick={onBack} data-testid="acknowledge-back">
          Back
        </Button>
        <Button
          variant="primary"
          onClick={onContinue}
          disabled={!allAcked}
          disabledReason={allAcked ? undefined : "Tick every box above to continue"}
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
// plain-language cause for a Stellar result code, so the failure summary reads
// like a sentence instead of a raw protocol code. Unknown codes fall through to
// a generic phrase (the raw code is still available in the technical details).
function plainResultCode(code: string): string {
  // wording verified against the official Stellar result-code reference
  // (developers.stellar.org … /errors/result-codes).
  const map: Record<string, string> = {
    // tx_insufficient_fee: source account can't pay the minimum fee
    tx_insufficient_fee: "the fee offered was below the network's minimum",
    // tx_bad_seq: sequence number does not match the source account
    tx_bad_seq: "the account's transaction number was out of date",
    // tx_too_late: the ledger close time was after the transaction's maxTime
    tx_too_late: "the time window to submit it passed",
    // tx_failed: one of the operations failed and none were applied
    tx_failed: "one of the steps was rejected, so nothing was applied",
    // op_underfunded: not enough balance to send while keeping the min reserve
    op_underfunded: "there wasn't enough balance to cover it",
    // op_low_reserve: the result would drop below the minimum reserve
    op_low_reserve: "it would drop the account below its minimum reserve",
    // payment_no_trust: destination has no trustline for the asset
    op_no_trust: "the destination can't hold that asset (no trustline)",
    // payment_src_no_trust: source no longer holds that asset
    op_src_no_trust: "the account no longer holds the asset this step tried to send",
    // op_line_full: destination is at its limit for the asset
    op_line_full: "the destination can't hold any more of that asset",
    // op_no_destination: destination account does not exist
    op_no_destination: "the destination account doesn't exist",
    // path_payment_strict_send_under_dest_min: swap would fall short of destMin
    op_under_dest_min: "the swap would have returned less than allowed, the price moved",
    // op_malformed: the operation's input was invalid
    op_malformed: "the step was built incorrectly",
    // payment_no_issuer: the asset's issuer does not exist
    op_no_issuer: "the token's issuer no longer exists",
  };
  return map[code] ?? "the network rejected it";
}

function parseDemolishError(raw: string | null): ParsedError {
  if (!raw) {
    return {
      summary: "Something went wrong while closing the account. Your funds are safe, try again.",
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
          ? `Step ${firstBadIdx + 1} of ${ops.length} couldn't complete, ${plainResultCode(ops[firstBadIdx]!)}.`
          : txCode
            ? `The transaction couldn't complete, ${plainResultCode(txCode)}.`
            : raw.slice(0, jsonStart).trim() || raw;
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
      <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 600, color: "var(--fg)" }}>
        Nothing was changed
      </h2>
      <p style={{ margin: "0 0 16px", fontSize: 14, color: "var(--fg-2)", lineHeight: 1.5 }}>
        You cancelled before anything was signed, so your account is completely untouched. You can
        safely leave, or start over whenever you&apos;re ready.
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
