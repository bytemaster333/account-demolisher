"use client";

// orchestrator-driven demolition UI, styled to match the dc design (lines 492-775 + modals)
// wires the page-flow xstate machine and the plan tree

import { useMachine } from "@xstate/react";
import { StrKey } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { AppShell } from "@/components/layout/AppShell";
import { HighValueWarning } from "@/components/confirmations/HighValueWarning";
import { TypedConfirmation } from "@/components/confirmations/TypedConfirmation";
import { AuthImmutableBlock } from "@/components/warnings/AuthImmutableBlock";
import { PendingClaimableBalances } from "@/components/warnings/PendingClaimableBalances";
import { SponsoringBlock } from "@/components/warnings/SponsoringBlock";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { CreateTestAccountButton } from "@/components/wallet/CreateTestAccountButton";
import { SecretKeyFallback } from "@/components/wallet/SecretKeyFallback";
import { explorerTxUrl } from "@/lib/wallet/demo-account";
import Link from "next/link";
import { getPublicEnv } from "@/lib/config/env";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { pageFlowMachine } from "@/lib/orchestrator/page-flow-machine";
import { lookupCex, type CexInfo } from "@/lib/safety/cex-registry";
import { requireMemoEnforcement } from "@/lib/safety/memo-enforcement";
import { topologicalOrder, type PlanNode } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicMemo } from "@/lib/types/plan";
import type { Connector } from "@/lib/wallet/connector";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";
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
});

type FormState = z.infer<typeof FORM_SCHEMA>;

const INITIAL_FORM: FormState = {
  destination: "",
  memoType: "none",
  memoValue: "",
  fallback: "",
  selectedCbIds: [],
};

// ─── derived helpers ────────────────────────────────────────────────────────

function shortPk(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
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

interface FlowStep {
  readonly num: string;
  readonly label: string;
  readonly isDone: boolean;
  readonly isActive: boolean;
  readonly isTodo: boolean;
  readonly notLast: boolean;
}

function buildFlowSteps(args: {
  readonly connected: boolean;
  readonly hasAudit: boolean;
  readonly hasTree: boolean;
  readonly isConfirming: boolean;
  readonly isExecuting: boolean;
  readonly isSucceeded: boolean;
}): readonly FlowStep[] {
  const { connected, hasAudit, hasTree, isConfirming, isExecuting, isSucceeded } = args;
  const labels = ["Connect", "Configure", "Preview", "Confirm", "Execute"];

  // determine the active index
  let activeIdx = 0;
  if (!connected) activeIdx = 0;
  else if (!hasAudit) activeIdx = 1;
  else if (!hasTree) activeIdx = 1;
  else if (!isConfirming && !isExecuting && !isSucceeded) activeIdx = 2;
  else if (isConfirming && !isExecuting) activeIdx = 3;
  else if (isExecuting) activeIdx = 4;
  else if (isSucceeded) activeIdx = 4;

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

  const network = useMemo<NetworkConfig>(() => {
    return resolveNetwork(getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK);
  }, []);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  // two-stage confirm: highvalue first (if balance > threshold), then typed. typed is never bypassable
  type ConfirmStage = "idle" | "highvalue" | "typed";
  const [confirmStage, setConfirmStage] = useState<ConfirmStage>("idle");

  const [snapshot, send] = useMachine(pageFlowMachine);
  const state = snapshot.value;
  const ctx = snapshot.context;

  const audit = ctx.audit;
  const tree = ctx.tree;

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
  const numCoverable = useMemo(() => {
    if (!audit) return 0;
    return audit.claimableBalances.filter((cb) => cb.sponsor === audit.accountId).length;
    // future: also count self-sponsored data entries / signers when those flows land
  }, [audit]);
  // hard-block only when at least one sponsorship is foreign (sponsoring entries
  const isSponsorBlock = !authImmutable && numSponsoring > numCoverable;
  const isImmutableBlock = authImmutable;
  const blocked = isImmutableBlock || isSponsorBlock;

  // configure = no tree yet (either before START, or after a CANCEL that returned us to cancelled)
  // preview = awaiting_confirmation with a tree present
  const isConfiguring = !blocked && publicKey !== null && tree === null;
  const isPreview = !blocked && tree !== null && isAwaitingConfirmation && confirmStage === "idle";
  const showFlow = !isIdle && !blocked;

  // step indicator
  const flowSteps = useMemo(
    () =>
      buildFlowSteps({
        connected: publicKey !== null,
        hasAudit: audit !== null,
        hasTree: tree !== null,
        isConfirming: confirmStage !== "idle",
        isExecuting,
        isSucceeded,
      }),
    [publicKey, audit, tree, confirmStage, isExecuting, isSucceeded],
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
  }, []);

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

    const memo = parseMemo(form);

    // hard refusal when destination is a CEX requiring a memo and the memo is missing or wrong type
    if (cex !== null) {
      const check = requireMemoEnforcement(cex, memo);
      if (!check.ok) {
        setFormError(check.reason);
        return;
      }
    }

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
      },
    });
  }, [form, publicKey, network, useMediator, cex, send]);

  const onCancel = useCallback(() => {
    setConfirmStage("idle");
    send({ type: "CANCEL" });
  }, [send]);
  const onReset = useCallback(() => {
    setConfirmStage("idle");
    setForm(INITIAL_FORM);
    setFormError(null);
    send({ type: "RESET" });
  }, [send]);
  const onRetry = useCallback(() => send({ type: "RETRY" }), [send]);

  useEffect(() => {
    return () => {
      connectorRef.current = null;
    };
  }, []);

  // pre-select all claimable balances by default so the demo flow "just works"
  const [prefilledAuditId, setPrefilledAuditId] = useState<string | null>(null);
  if (
    audit &&
    audit.claimableBalances.length > 0 &&
    prefilledAuditId !== audit.accountId &&
    form.selectedCbIds.length === 0
  ) {
    const allIds = audit.claimableBalances.map((cb) => cb.id);
    setForm((f) => ({ ...f, selectedCbIds: allIds }));
    setPrefilledAuditId(audit.accountId);
  }

  // account-side derived values used in the audit card and modals
  const totalXlm = audit ? sumNativeBalance(audit) : "0";
  const isHighValue = useMemo<boolean>(() => {
    if (!audit) return false;
    const n = Number.parseFloat(totalXlm);
    if (!Number.isFinite(n)) return false;
    return n > HIGH_VALUE_THRESHOLD_XLM;
  }, [audit, totalXlm]);

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
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "34px 28px 96px" }}>
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
                mergeHash={mergeHash ?? null}
                error={ctx.error}
                onRetry={onRetry}
                onReset={onReset}
              />
            </div>
          ) : null}

          {/* stable two-column layout — only for idle/configure/preview. */}
          {!(isDiscovering || isPreviewing) && !isExecuting && !isSucceeded && !isFailed
            ? (() => {
                // tree is the trigger for "do we need the side rail?"
                const hasSideContent = tree !== null;
                return (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: hasSideContent
                        ? "minmax(0, 1fr) 360px"
                        : "minmax(0, 640px)",
                      gap: 28,
                      alignItems: "start",
                      maxWidth: hasSideContent ? 1180 : 640,
                      margin: "0 auto",
                      justifyContent: "center",
                    }}
                  >
                    {/* MAIN panel (form / loading-transition / preview / executing / outcome) */}
                    <div>
                      {isConfiguring && !(isDiscovering || isPreviewing) ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                          {audit && numCoverable > 0 ? (
                            <SponsorshipAutoRevokeNotice count={numCoverable} />
                          ) : null}
                          {audit && audit.claimableBalances.length > 0 ? (
                            <PendingClaimableBalances
                              pending={audit.claimableBalances.map((cb) => ({
                                id: cb.id,
                                amount: cb.amount,
                                assetLabel:
                                  cb.asset.kind === "native"
                                    ? "XLM"
                                    : cb.asset.kind === "credit"
                                      ? cb.asset.code
                                      : "POOL",
                              }))}
                            />
                          ) : null}
                          <ConfigurePanel
                            form={form}
                            setForm={setForm}
                            cex={cex}
                            hasMemo={hasMemo}
                            formError={formError}
                            isBusy={false}
                            canStart={publicKey !== null && hasConnector}
                            onGeneratePlan={onStart}
                            audit={audit}
                            isDemo={isDemo}
                          />
                        </div>
                      ) : null}

                      {isPreview ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                          {audit ? (
                            <CompactAuditBar
                              pkShort={acctPkShort}
                              xlm={totalXlm}
                              sub={acctSub}
                              trustlines={acctTrustlines}
                              offers={acctOffers}
                              data={acctData}
                              claimable={acctClaimable}
                            />
                          ) : null}
                          {/* consolidate notices when the CB and the self-sponsorship
                              are the same entry (very common case: demo created a CB,
                              became its sponsor). show only the CB notice with
                              extended copy that mentions the sponsorship revoke. */}
                          {(() => {
                            if (!audit) return null;
                            const cbs = audit.claimableBalances;
                            const selfSponsoredCount = cbs.filter(
                              (cb) => cb.sponsor === audit.accountId,
                            ).length;
                            const merged =
                              cbs.length > 0 &&
                              selfSponsoredCount === cbs.length &&
                              numCoverable === selfSponsoredCount;
                            if (merged) {
                              return (
                                <PendingClaimableBalances
                                  pending={cbs.map((cb) => ({
                                    id: cb.id,
                                    amount: cb.amount,
                                    assetLabel:
                                      cb.asset.kind === "native"
                                        ? "XLM"
                                        : cb.asset.kind === "credit"
                                          ? cb.asset.code
                                          : "POOL",
                                  }))}
                                />
                              );
                            }
                            return (
                              <>
                                {numCoverable > 0 ? (
                                  <SponsorshipAutoRevokeNotice count={numCoverable} />
                                ) : null}
                                {cbs.length > 0 ? (
                                  <PendingClaimableBalances
                                    pending={cbs.map((cb) => ({
                                      id: cb.id,
                                      amount: cb.amount,
                                      assetLabel:
                                        cb.asset.kind === "native"
                                          ? "XLM"
                                          : cb.asset.kind === "credit"
                                            ? cb.asset.code
                                            : "POOL",
                                    }))}
                                  />
                                ) : null}
                              </>
                            );
                          })()}
                          <PreviewPanel
                            totalXlm={totalXlm}
                            activeCount={activeCount}
                            onBack={onCancel}
                            onContinue={() => setConfirmStage(isHighValue ? "highvalue" : "typed")}
                          />
                        </div>
                      ) : null}

                      {/* executing / succeeded / failed are handled by the
                          centered DemolishStatusWidget above this grid; the
                          grid only renders idle/configure/preview content. */}

                      {isCancelled ? (
                        <CancelledPanel onResume={() => send({ type: "RESET" })} />
                      ) : null}
                    </div>

                    {/* SIDE rail (plan tree) — only mounted when there's tree
                        content. otherwise the layout above collapses to a
                        single centered column and we don't render a second
                        track at all. */}
                    {hasSideContent ? (
                      <div
                        style={{
                          position: "sticky",
                          top: 80,
                          display: "flex",
                          flexDirection: "column",
                          gap: 16,
                        }}
                      >
                        {tree !== null ? (
                          <LeftPlanList
                            planGroups={planGroups}
                            doneCount={doneCount}
                            activeCount={activeCount}
                            network={network}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })()
            : null}
        </>
      ) : null}

      {/* MODALS — two-stage confirm */}
      {confirmStage === "highvalue" && isHighValue && audit ? (
        <HighValueWarning
          totalXlm={totalXlm}
          threshold={HIGH_VALUE_THRESHOLD_XLM}
          onConfirm={() => setConfirmStage("typed")}
          onCancel={() => setConfirmStage("idle")}
        />
      ) : null}
      {confirmStage === "typed" ? (
        <TypedConfirmation
          destination={form.destination}
          onConfirm={() => {
            // last gate — typed input already matched and the delay elapsed
            send({ type: "CONFIRM" });
            setConfirmStage("idle");
          }}
          onCancel={() => setConfirmStage("idle")}
        />
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
  return (
    <div style={{ maxWidth: 720, margin: "36px auto 0" }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 11px",
          borderRadius: 999,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          marginBottom: 22,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--accent)",
          }}
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
        Try it on a demo account
      </h1>
      <p
        style={{
          margin: "13px 0 30px",
          fontSize: 16,
          lineHeight: 1.55,
          color: "var(--fg-2)",
          maxWidth: 540,
        }}
      >
        The demolisher is irreversible. Start with a throwaway {network.id} account loaded with
        trustlines, data, offers, signers, and a SEP-41 allowance — so you can see the whole flow
        without risking real funds. Real-wallet paths are below if you actually need to close an
        account.
      </p>

      {/* primary: demo account (testnet/futurenet only) */}
      <CreateTestAccountButton network={network} onConnector={onSecretConnector} />

      {/* divider */}
      {isTestnetLike ? (
        <div
          style={{
            margin: "24px 0 16px",
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
          <span>or use a real account</span>
          <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
        </div>
      ) : null}

      {/* secondary: real wallet via stellar-wallets-kit */}
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
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>
            Connect a real wallet
          </span>
          <span style={{ fontSize: 12, color: "var(--fg-3)" }}>
            Freighter, xBull, Albedo, Rabet, Lobstr, Hana, WalletConnect.
          </span>
        </div>
        <ConnectButton network={network} onConnector={onKitConnector} />
      </div>

      {/* tertiary, collapsed: legacy/advanced seed paste */}
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
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>Advanced, paste a secret key</span>
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
              border: st.isActive ? "1px solid var(--accent-line)" : "1px solid var(--border)",
              background: st.isActive ? "var(--accent-soft)" : "var(--surface)",
            }}
          >
            {st.isDone ? (
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "var(--success)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#fff"
                  strokeWidth={3.5}
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
                  background: "var(--accent)",
                  color: "var(--accent-fg)",
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

// kept for potential future reuse (full-detail view); preview uses CompactAuditBar
// instead. lint exemption via the underscore prefix
function _AuditCard({
  pkShort,
  xlm,
  sub,
  threshold,
  trustlines,
  offers,
  data,
  claimable,
  authImmutable,
}: {
  readonly pkShort: string;
  readonly xlm: string;
  readonly sub: number;
  readonly threshold: string;
  readonly trustlines: number;
  readonly offers: number;
  readonly data: number;
  readonly claimable: number;
  readonly authImmutable: boolean;
}): React.JSX.Element {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "15px 17px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface-2)",
        }}
      >
        <span
          style={{
            font: "600 11px/1 Geist, sans-serif",
            color: "var(--fg-3)",
            letterSpacing: "0.05em",
          }}
        >
          ACCOUNT
        </span>
      </div>
      <div style={{ padding: "18px 17px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--fg-2)",
            marginBottom: 16,
          }}
        >
          <span style={{ font: "500 12.5px/1 'Geist Mono', monospace" }}>{pkShort}</span>
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-3)", marginBottom: 4 }}>Total balance</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginBottom: 18 }}>
          <span
            style={{
              fontSize: 30,
              fontWeight: 600,
              letterSpacing: "-0.03em",
              fontFamily: "'Geist Mono', monospace",
              color: "var(--fg)",
            }}
          >
            {xlm}
          </span>
          <span style={{ fontSize: 15, color: "var(--fg-3)", fontWeight: 500 }}>XLM</span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 1,
            background: "var(--border)",
            border: "1px solid var(--border)",
            borderRadius: 11,
            overflow: "hidden",
          }}
        >
          <StatCell label="Subentries" value={sub} />
          <StatCell label="Threshold" value={threshold} />
          <StatCell label="Trustlines" value={trustlines} />
          <StatCell label="Open offers" value={offers} />
          <StatCell label="Data entries" value={data} />
          <StatCell label="Claimable" value={claimable} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            marginTop: 14,
            padding: "11px 13px",
            borderRadius: 11,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
          }}
        >
          {authImmutable ? (
            <>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--danger)"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M5.6 5.6l12.8 12.8" />
              </svg>
              <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>
                AUTH_IMMUTABLE — cannot be merged
              </span>
            </>
          ) : (
            <>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--success)"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>
                Mergeable, no blocking conditions
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCell({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number | string;
}): React.JSX.Element {
  return (
    <div style={{ background: "var(--surface)", padding: "11px 13px" }}>
      <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{label}</div>
      <div
        style={{
          fontWeight: 600,
          fontSize: 15,
          fontFamily: "'Geist Mono', monospace",
          marginTop: 3,
          color: "var(--fg)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// shown before audit data exists. keeps the side rail occupied so the
// main column doesn't shift when audit/plan loads
function _SideRailPlaceholder(): React.JSX.Element {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px dashed var(--border-2)",
        borderRadius: 16,
        padding: "22px 20px",
        boxShadow: "var(--shadow-sm)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        color: "var(--fg-3)",
      }}
      aria-label="Plan preview placeholder"
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          display: "grid",
          placeItems: "center",
        }}
      >
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
          <rect x="4" y="5" width="16" height="3" rx="1" />
          <rect x="4" y="11" width="11" height="3" rx="1" />
          <rect x="4" y="17" width="7" height="3" rx="1" />
        </svg>
      </div>
      <div>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--fg-2)",
            letterSpacing: "-0.005em",
          }}
        >
          Plan appears here
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: 1.5 }}>
          Once you start, every step the demolisher will execute shows up here in dependency order.
          You can expand any step to inspect its simulation before signing.
        </p>
      </div>
    </div>
  );
}

// compact horizontal account-stat strip used in preview
function CompactAuditBar({
  pkShort,
  xlm,
  sub,
  trustlines,
  offers,
  data,
  claimable,
}: {
  readonly pkShort: string;
  readonly xlm: string;
  readonly sub: number;
  readonly trustlines: number;
  readonly offers: number;
  readonly data: number;
  readonly claimable: number;
}): React.JSX.Element {
  const stats: ReadonlyArray<{ label: string; value: string | number }> = [
    { label: "subentries", value: sub },
    { label: "trustlines", value: trustlines },
    { label: "offers", value: offers },
    { label: "data", value: data },
    { label: "claimable", value: claimable },
  ];
  return (
    <div
      data-testid="compact-audit-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "12px 16px",
        borderRadius: 12,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          paddingRight: 14,
          borderRight: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: "var(--fg-3)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Account
        </span>
        <span
          style={{
            font: "500 12.5px/1 'Geist Mono', monospace",
            color: "var(--fg-2)",
          }}
        >
          {pkShort}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontSize: 10.5,
            color: "var(--fg-3)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Balance
        </span>
        <span style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
          <span
            style={{
              font: "600 16px/1 'Geist Mono', monospace",
              color: "var(--fg)",
              letterSpacing: "-0.01em",
            }}
          >
            {xlm}
          </span>
          <span style={{ fontSize: 11, color: "var(--fg-3)" }}>XLM</span>
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <div
        style={{
          display: "flex",
          gap: 18,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {stats.map((s) => (
          <div
            key={s.label}
            style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}
          >
            <span
              style={{
                fontSize: 10.5,
                color: "var(--fg-3)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              {s.label}
            </span>
            <span
              style={{
                font: "600 14px/1 'Geist Mono', monospace",
                color: "var(--fg)",
              }}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>
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
        background: "color-mix(in srgb, var(--warning-soft) 55%, transparent)",
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
          background: "color-mix(in srgb, var(--warning) 18%, transparent)",
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
            background: "var(--accent)",
            color: "var(--accent-fg)",
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
        <div
          style={{
            fontSize: 12.5,
            color: "var(--fg-3)",
            maxWidth: 260,
            lineHeight: 1.5,
          }}
        >
          Reading on-chain state — trustlines, signers, soroban positions, allowances.
        </div>
      </div>

      {/* shimmer skeleton lines for visual rhythm */}
      <div
        aria-hidden
        style={{
          width: "100%",
          maxWidth: 240,
          display: "flex",
          flexDirection: "column",
          gap: 9,
          position: "relative",
        }}
      >
        {[68, 84, 52].map((w, i) => (
          <span
            key={i}
            style={{
              height: 9,
              width: `${w}%`,
              borderRadius: 5,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              position: "relative",
              overflow: "hidden",
              alignSelf: i % 2 === 0 ? "flex-start" : "flex-end",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                bottom: 0,
                width: "40%",
                background:
                  "linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 35%, transparent), transparent)",
                animation: "shimmer 1.8s linear infinite",
                animationDelay: `${i * 0.18}s`,
              }}
            />
          </span>
        ))}
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
      ? "var(--success-soft)"
      : state === "failed"
        ? "var(--danger-soft)"
        : "var(--accent-soft)";

  const parsed = state === "failed" ? parseDemolishError(error) : null;

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
              background: accent,
              color: "var(--accent-fg, #fff)",
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
                "Each step signs and submits in dependency order. You can watch the live status below."
              )}
            </p>
          </div>
        </div>

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
                  background: "var(--danger-soft)",
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
                    background: isFail ? "var(--danger-soft)" : "var(--success-soft)",
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
                  background: "var(--accent)",
                  color: "var(--accent-fg)",
                  fontWeight: 600,
                  fontSize: 13.5,
                  cursor: "pointer",
                }}
              >
                Start over
              </button>
            </>
          ) : (
            <Link
              href="/"
              data-testid="demolish-reset"
              style={{
                flex: 1,
                height: 40,
                padding: "0 16px",
                borderRadius: 10,
                border: "1px solid var(--accent-line)",
                background: "var(--accent)",
                color: "var(--accent-fg)",
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

function LeftPlanList({
  planGroups,
  doneCount,
  activeCount,
  network,
}: {
  readonly planGroups: ReadonlyArray<{ phase: string; nodes: readonly PlanNode[] }>;
  readonly doneCount: number;
  readonly activeCount: number;
  readonly network: NetworkConfig;
}): React.JSX.Element {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        boxShadow: "var(--shadow-sm)",
        maxHeight: "calc(100vh - 120px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "15px 17px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14, color: "var(--fg)" }}>Demolition plan</span>
        <span style={{ font: "600 11px/1 Geist, sans-serif", color: "var(--fg-3)" }}>
          {doneCount}/{activeCount}
        </span>
      </div>
      <div style={{ overflowY: "auto", padding: "8px 8px 12px" }}>
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
    </div>
  );
}

function PlanRow({
  node,
  network,
}: {
  readonly node: PlanNode;
  readonly network: NetworkConfig;
}): React.JSX.Element {
  const isDone = node.status === "confirmed";
  const isRunning = node.status === "signed" || node.status === "submitted";
  const isSkipped = node.status === "skipped";
  const isFailed = node.status === "failed";
  const isPending = !isDone && !isRunning && !isSkipped && !isFailed;
  const sim = node.simulated;
  const simFee =
    sim?.kind === "soroban"
      ? sim.minResourceFee
      : sim?.kind === "classic"
        ? sim.estimatedFee
        : null;
  const simAuth =
    sim?.kind === "soroban" ? String(sim.auth.length) : sim?.kind === "classic" ? "n/a" : null;

  return (
    <div style={{ borderRadius: 10, overflow: "hidden" }}>
      <div
        style={{
          width: "100%",
          display: "flex",
          alignItems: "flex-start",
          gap: 11,
          padding: "9px 10px",
          background: "none",
          border: "none",
          borderRadius: 10,
          color: "var(--fg)",
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
          {isDone ? (
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                background: "var(--success-soft)",
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
                background: "var(--warning-soft)",
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
                background: "var(--danger-soft)",
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
                  background: "var(--warning-soft)",
                  font: "600 9.5px/1.2 Geist, sans-serif",
                  color: "var(--warning)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                skipped
              </span>
            ) : null}
            {/* inline meta — same row, monospace, tiny — always visible
                so the user never needs to click an expand toggle. */}
            {simFee !== null || simAuth !== null ? (
              <span
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "baseline",
                  gap: 10,
                  font: "500 11px/1 'Geist Mono', monospace",
                  color: "var(--fg-3)",
                }}
              >
                {simFee !== null ? (
                  <span>
                    fee <span style={{ color: "var(--fg-2)" }}>{simFee}</span>
                  </span>
                ) : null}
                {simAuth !== null ? (
                  <span>
                    auth <span style={{ color: "var(--fg-2)" }}>{simAuth}</span>
                  </span>
                ) : null}
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
                  background: "var(--warning-soft)",
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
              onClick={() =>
                setForm((f) => ({ ...f, destination: DEMO_DESTINATION_ADDRESS }))
              }
              data-testid="use-demo-destination"
              title={`Use demo destination ${DEMO_DESTINATION_ADDRESS}`}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                padding: "5px 9px",
                borderRadius: 7,
                border: "1px solid var(--accent-line)",
                background: "var(--accent-soft)",
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
              background: "var(--warning-soft)",
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
          <select
            value={form.memoType}
            onChange={(e) => {
              const v = e.currentTarget.value as FormState["memoType"];
              setForm((f) => ({ ...f, memoType: v }));
            }}
            data-testid="memo-type-select"
            aria-label="Memo type"
            style={{
              padding: "13px 12px",
              borderRadius: 11,
              border: "1px solid var(--border-2)",
              background: "var(--surface-2)",
              color: "var(--fg)",
              font: "500 13px/1.3 Geist, sans-serif",
            }}
          >
            <option value="none">none</option>
            <option value="text">text</option>
            <option value="id">id</option>
            <option value="hash">hash</option>
            <option value="return">return</option>
          </select>
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
              background: "var(--accent-soft)",
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
          Fallback address{" "}
          <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>
            , optional for mediator route
          </span>
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

        <button
          type="button"
          onClick={onGeneratePlan}
          disabled={!canStart || isBusy}
          data-testid="demolish-start"
          style={{
            marginTop: 20,
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            padding: 14,
            borderRadius: 12,
            border: "none",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            fontWeight: 600,
            fontSize: 15,
            cursor: canStart && !isBusy ? "pointer" : "not-allowed",
            opacity: canStart && !isBusy ? 1 : 0.6,
            boxShadow: "0 6px 20px var(--accent-soft)",
          }}
        >
          {isBusy ? "Building plan…" : "Build & simulate plan"}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
        <p
          style={{
            margin: "12px 0 0",
            fontSize: 11.5,
            color: "var(--fg-3)",
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          Building the plan reads the account and runs real simulations. Nothing is signed yet.
        </p>
      </div>
    </div>
  );
}

function PreviewPanel({
  totalXlm,
  activeCount,
  onBack,
  onContinue,
}: {
  readonly totalXlm: string;
  readonly activeCount: number;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 24,
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 11px",
          borderRadius: 999,
          background: "var(--success-soft)",
          border: "1px solid color-mix(in srgb, var(--success) 26%, transparent)",
          marginBottom: 16,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)" }} />
        <span
          style={{
            font: "600 11px/1 Geist, sans-serif",
            color: "var(--success)",
            letterSpacing: "0.03em",
          }}
        >
          PLAN SIMULATED
        </span>
      </div>
      <h2
        style={{
          margin: "0 0 6px",
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          color: "var(--fg)",
        }}
      >
        Review before you commit
      </h2>
      <p
        style={{
          margin: "0 0 20px",
          fontSize: 14,
          lineHeight: 1.55,
          color: "var(--fg-2)",
          maxWidth: 520,
        }}
      >
        The full plan is on the left, <strong>{activeCount}</strong>{" "}
        {activeCount === 1 ? "transaction" : "transactions"} across discovery, DeFi unwinding,
        liquidation, cleanup and the final merge. Expand any step to inspect its simulation.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 1,
          background: "var(--border)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          overflow: "hidden",
          marginBottom: 22,
        }}
      >
        <PreviewStat label="Reserve recovered" value="+1.0 XLM" />
        <PreviewStat label="Plan steps" value={String(activeCount)} />
        <PreviewStat label="Forwarded to dest." value={`${totalXlm} XLM`} />
      </div>
      <div style={{ display: "flex", gap: 11 }}>
        <button
          type="button"
          onClick={onBack}
          data-testid="demolish-cancel"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "13px 18px",
            borderRadius: 11,
            border: "1px solid var(--border-2)",
            background: "var(--surface)",
            color: "var(--fg)",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          data-testid="demolish-confirm"
          aria-label="Open final demolition confirmation"
          style={{
            flex: 1,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            padding: "13px 20px",
            borderRadius: 11,
            border: "1px solid var(--accent-line)",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Looks good, continue
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function PreviewStat({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div style={{ background: "var(--surface)", padding: "15px 16px" }}>
      <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{label}</div>
      <div
        style={{
          fontWeight: 600,
          fontSize: 17,
          fontFamily: "'Geist Mono', monospace",
          marginTop: 4,
          color: "var(--fg)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

// kept around for potential future reuse (e.g., a verbose log mode); the
// execute step now uses the plan tree directly
// component name starts with `_` (lint-allowed unused prefix); start with
// an uppercase letter so react-hooks lint accepts the hook calls inside
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ExecutingPanel_Unused({
  events,
  doneCount,
  activeCount,
}: {
  readonly events: readonly { kind: string; message: string; txHash?: string }[];
  readonly doneCount: number;
  readonly activeCount: number;
}): React.JSX.Element {
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events.length]);

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        boxShadow: "var(--shadow-sm)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "16px 20px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: "var(--accent)",
            animation: "pulse 1.8s ease-in-out infinite",
          }}
        />
        <span style={{ fontWeight: 600, fontSize: 15, color: "var(--fg)" }}>
          Executing demolition
        </span>
        <span
          style={{
            marginLeft: "auto",
            font: "600 12px/1 Geist, sans-serif",
            color: "var(--fg-3)",
          }}
        >
          {doneCount}/{activeCount} confirmed
        </span>
      </div>
      <div
        ref={logRef}
        data-testid="progress-log"
        style={{ maxHeight: 560, overflowY: "auto", padding: "6px 8px" }}
      >
        {events.length === 0 ? (
          <div
            style={{
              padding: 20,
              textAlign: "center",
              fontSize: 13,
              color: "var(--fg-3)",
            }}
          >
            Waiting for first event…
          </div>
        ) : (
          events.map((ev, i) => (
            <div
              key={i}
              data-event-kind={ev.kind}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 11,
                padding: "10px 12px",
                borderRadius: 9,
              }}
            >
              <span
                style={{
                  font: "500 11px/1.4 'Geist Mono', monospace",
                  color: "var(--fg-3)",
                  flexShrink: 0,
                  marginTop: 1,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                {ev.kind}
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: "var(--fg)",
                }}
              >
                {ev.message}
              </span>
              {ev.txHash ? (
                <code
                  title={ev.txHash}
                  style={{
                    font: "500 11px/1.4 'Geist Mono', monospace",
                    color: "var(--accent)",
                    textDecoration: "none",
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                >
                  {truncateHash(ev.txHash)}↗
                </code>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function _SucceededPanel({
  totalXlm,
  mergeHash,
  network,
}: {
  readonly totalXlm: string;
  readonly mergeHash: string | null;
  readonly network: NetworkConfig;
}): React.JSX.Element {
  return (
    <div
      data-testid="demolish-result"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: "36px 28px",
        boxShadow: "var(--shadow)",
        textAlign: "center",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 120,
          background: "radial-gradient(closest-side at 50% 0%, var(--success-soft), transparent)",
        }}
      />
      <div style={{ position: "relative" }}>
        <div
          style={{
            width: 66,
            height: 66,
            margin: "0 auto 20px",
            borderRadius: "50%",
            background: "var(--success-soft)",
            border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)",
            display: "grid",
            placeItems: "center",
            animation: "pop .35s ease-out both",
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--success)"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <h2
          style={{
            margin: 0,
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            color: "var(--fg)",
          }}
        >
          Account closed
        </h2>
        <p
          style={{
            margin: "11px auto 0",
            maxWidth: 420,
            fontSize: 14.5,
            lineHeight: 1.55,
            color: "var(--fg-2)",
          }}
        >
          All positions unwound and the account merged.{" "}
          <strong style={{ color: "var(--fg)", fontFamily: "'Geist Mono', monospace" }}>
            {totalXlm} XLM
          </strong>
          , including the recovered base reserve, was forwarded to your destination.
        </p>
        {mergeHash ? (
          <a
            href={explorerTxUrl(network, mergeHash)}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              margin: "22px auto 0",
              maxWidth: 420,
              padding: "13px 16px",
              borderRadius: 12,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              textDecoration: "none",
              transition: "border-color .2s",
            }}
            title="View merge transaction on stellar.expert"
          >
            <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>Merge tx</span>
            <span
              style={{
                font: "600 12.5px/1 'Geist Mono', monospace",
                color: "var(--fg)",
                wordBreak: "break-all",
              }}
            >
              {truncateHash(mergeHash)}
            </span>
            <svg
              width="13"
              height="13"
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
        <div style={{ display: "flex", gap: 11, justifyContent: "center", marginTop: 24 }}>
          <Link
            href="/"
            data-testid="demolish-reset"
            style={{
              padding: "12px 18px",
              borderRadius: 11,
              border: "none",
              background: "var(--accent)",
              color: "var(--accent-fg)",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Back to landing
          </Link>
        </div>
      </div>
    </div>
  );
}

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

function _FailedPanel({
  error,
  onRetry,
  onReset,
}: {
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onReset: () => void;
}): React.JSX.Element {
  return (
    <div
      data-testid="demolish-error"
      role="alert"
      style={{
        background: "var(--surface)",
        border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
        borderRadius: 16,
        padding: 24,
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        style={{
          width: 54,
          height: 54,
          borderRadius: 15,
          background: "var(--danger-soft)",
          display: "grid",
          placeItems: "center",
          marginBottom: 16,
        }}
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--danger)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 9v4M12 17h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <h2
        style={{
          margin: 0,
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          color: "var(--fg)",
        }}
      >
        Demolition failed
      </h2>
      <p
        style={{
          margin: "10px 0 18px",
          fontSize: 13.5,
          lineHeight: 1.55,
          color: "var(--fg-2)",
        }}
      >
        {(() => {
          const parsed = parseDemolishError(error);
          return parsed.summary;
        })()}
      </p>

      {/* parsed error details — compact pill list, no JSON dump */}
      {(() => {
        const parsed = parseDemolishError(error);
        if (parsed.ops.length === 0 && parsed.txCode === null) return null;
        return (
          <div
            style={{
              marginBottom: 18,
              padding: "13px 14px",
              borderRadius: 12,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: 9,
            }}
          >
            {parsed.txCode !== null ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 12,
                  color: "var(--fg-3)",
                }}
              >
                <span style={{ letterSpacing: "0.04em", textTransform: "uppercase" }}>tx code</span>
                <code
                  style={{
                    font: "600 12px/1 'Geist Mono', monospace",
                    color: "var(--danger)",
                  }}
                >
                  {parsed.txCode}
                </code>
              </div>
            ) : null}
            {parsed.ops.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--fg-3)",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                  }}
                >
                  ops
                </span>
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
                        background: isFail ? "var(--danger-soft)" : "var(--success-soft)",
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
        );
      })()}

      {/* collapsible raw error for power users — no data lost */}
      {error ? (
        <details
          style={{
            marginBottom: 18,
            padding: "10px 12px",
            borderRadius: 10,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            fontSize: 12,
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
              margin: "10px 0 0",
              padding: 0,
              font: "500 11px/1.55 'Geist Mono', monospace",
              color: "var(--fg-2)",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap",
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            {error}
          </pre>
        </details>
      ) : null}

      <div style={{ display: "flex", gap: 11 }}>
        <button
          type="button"
          onClick={onRetry}
          data-testid="demolish-retry"
          style={{
            padding: "12px 18px",
            borderRadius: 11,
            border: "1px solid var(--border-2)",
            background: "var(--surface)",
            color: "var(--fg)",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onReset}
          data-testid="demolish-reset"
          style={{
            padding: "12px 18px",
            borderRadius: 11,
            border: "none",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Start over
        </button>
      </div>
    </div>
  );
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
          border: "none",
          background: "var(--accent)",
          color: "var(--accent-fg)",
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
