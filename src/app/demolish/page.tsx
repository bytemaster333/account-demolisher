"use client";

// orchestrator-driven demolition UI. wires the page-flow xstate machine and the plan tree.

import { useMachine } from "@xstate/react";
import { StrKey } from "@stellar/stellar-sdk";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { AuditCard } from "@/components/demolish/AuditCard";
import { ProgressLog } from "@/components/demolish/ProgressLog";
import { PlanTree } from "@/components/plan-tree/PlanTree";
import { HighValueWarning } from "@/components/confirmations/HighValueWarning";
import { TypedConfirmation } from "@/components/confirmations/TypedConfirmation";
import { AuthImmutableBlock } from "@/components/warnings/AuthImmutableBlock";
import { type PendingClaimableBalanceEntry } from "@/components/warnings/PendingClaimableBalances";
import { type ScamTokenFinding } from "@/components/warnings/ScamTokenWarning";
import { SponsoringBlock } from "@/components/warnings/SponsoringBlock";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { SecretKeyFallback } from "@/components/wallet/SecretKeyFallback";
import { getPublicEnv } from "@/lib/config/env";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { pageFlowMachine } from "@/lib/orchestrator/page-flow-machine";
import { lookupCex, type CexInfo } from "@/lib/safety/cex-registry";
import { applyFeeCap, defaultAdvice } from "@/lib/safety/fee-surge";
import { requireMemoEnforcement } from "@/lib/safety/memo-enforcement";
import { runScamHeuristics } from "@/lib/safety/scam-heuristics";
import type { ClaimableBalanceEntry } from "@/lib/types/account";
import type { ClassicMemo } from "@/lib/types/plan";
import { cn } from "@/lib/utils";
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

export default function DemolishPage(): React.JSX.Element {
  const connectorRef = useRef<Connector | null>(null);
  const [hasConnector, setHasConnector] = useState(false);
  const publicKey = useWalletStore((s) => s.publicKey);
  const connectorKind = useWalletStore((s) => s.connectorKind);

  const network = useMemo<NetworkConfig>(() => {
    return resolveNetwork(getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK);
  }, []);

  const [showFallback, setShowFallback] = useState(false);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const [snapshot, send] = useMachine(pageFlowMachine);

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

  // two-stage confirm: highvalue first (if balance > threshold), then typed. typed is never bypassable.
  type ConfirmStage = "idle" | "highvalue" | "typed";
  const [confirmStage, setConfirmStage] = useState<ConfirmStage>("idle");

  // derive instead of setState-in-effect so we don't trip the react 19 purity checker
  const effectiveConfirmStage: ConfirmStage =
    snapshot.value === "awaiting_confirmation" ? confirmStage : "idle";

  const onCancel = useCallback(() => {
    setConfirmStage("idle");
    send({ type: "CANCEL" });
  }, [send]);
  const onReset = useCallback(() => send({ type: "RESET" }), [send]);
  const onRetry = useCallback(() => send({ type: "RETRY" }), [send]);

  useEffect(() => {
    return () => {
      connectorRef.current = null;
    };
  }, []);

  const state = snapshot.value;
  const ctx = snapshot.context;
  const isIdle = state === "idle";
  const isDiscovering = state === "discovering";
  const isPreviewing = state === "previewing";
  const isAwaitingConfirmation = state === "awaiting_confirmation";
  // underscore-prefixed to dodge no-unused-vars until the UI wires it up
  const _isExecuting = state === "executing";
  const isSucceeded = state === "succeeded";
  const isFailed = state === "failed";
  const isCancelled = state === "cancelled";

  const canStart = publicKey !== null && hasConnector && (isIdle || isCancelled || isSucceeded);

  const audit = ctx.audit;
  const authImmutable = audit?.flags.authImmutable === true;
  const numSponsoring = audit?.sponsorship.numSponsoring ?? 0;
  const isSponsoring = numSponsoring > 0;

  const totalXlm = useMemo<string>(() => {
    if (!audit) return "0";
    const native = audit.balances.find((b) => b.asset.kind === "native");
    return native?.amount ?? "0";
  }, [audit]);

  const isHighValue = useMemo<boolean>(() => {
    const n = Number.parseFloat(totalXlm);
    if (!Number.isFinite(n)) return false;
    return n > HIGH_VALUE_THRESHOLD_XLM;
  }, [totalXlm]);

  const scamFindings: readonly ScamTokenFinding[] = useMemo(() => {
    if (!audit) return [];
    // narrow the safety-lib finding shape down to the UI shape (assetCode + issuer)
    const findings = runScamHeuristics(audit.balances);
    return findings.flatMap<ScamTokenFinding>((f) => {
      if (f.asset.kind !== "credit") return [];
      return [
        {
          assetCode: f.asset.code,
          issuer: f.asset.issuer,
          heuristic:
            f.flag.id === "lookalike_symbol"
              ? "lookalike"
              : f.flag.id === "exact_symbol_collision"
                ? "lookalike"
                : "other",
          detail: f.flag.message,
        },
      ];
    });
  }, [audit]);

  // populated on the client after mount to avoid SSR hydration mismatch
  const [nowSecs, setNowSecs] = useState<number>(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowSecs(Math.floor(Date.now() / 1000));
  }, []);
  const pendingCbs: readonly PendingClaimableBalanceEntry[] = useMemo(() => {
    if (!audit || !publicKey || nowSecs === 0) return [];
    return audit.claimableBalances
      .filter((cb) => cb.claimants.includes(publicKey))
      .filter((cb) => isPredicateInTheFuture(cb.predicate, nowSecs))
      .map<PendingClaimableBalanceEntry>((cb) => ({
        id: cb.id,
        amount: cb.amount,
        assetLabel: claimableBalanceAssetLabel(cb),
        reason: "Predicate not yet satisfied",
      }));
  }, [audit, publicKey, nowSecs]);

  // surface the capped per-op fee even when the orchestrator picks higher
  const cappedFeeStroops = useMemo(() => {
    const advice = defaultAdvice();
    // worst case is 100 stroops × 100 ops; run it through applyFeeCap anyway
    return applyFeeCap("10000", advice);
  }, []);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Demolish account</h1>
        <Link href="/" className="text-xs underline text-slate-600 hover:text-slate-900">
          Home
        </Link>
      </header>
      <p className="text-sm text-slate-700">
        Connect a Stellar wallet, audit the account, review the plan tree, and confirm the
        demolition. Network: <code className="font-mono">{network.id}</code>.
      </p>

      <section className="flex flex-col gap-2 rounded-lg border border-slate-300 bg-white p-4">
        <h2 className="text-base font-semibold">1. Connect</h2>
        <ConnectButton
          network={network}
          onConnector={(c: WalletKitConnector | null) => setConnector(c)}
        />
        <button
          type="button"
          onClick={() => setShowFallback((v) => !v)}
          className="self-start text-xs underline text-slate-600 hover:text-slate-900"
        >
          {showFallback ? "Hide" : "Show"} advanced secret-key fallback
        </button>
        {showFallback ? (
          <SecretKeyFallback onConnector={(c: SecretKeyConnector) => setConnector(c)} />
        ) : null}
        {publicKey ? (
          <p className="text-xs text-slate-600">
            Connected as <code className="font-mono">{publicKey}</code> ({connectorKind})
          </p>
        ) : null}
        <input
          type="hidden"
          data-testid="connector-ready"
          value={hasConnector ? "true" : "false"}
          readOnly
        />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-300 bg-white p-4">
        <h2 className="text-base font-semibold">2. Configure & audit</h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Destination address</span>
          <input
            type="text"
            value={form.destination}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setForm((f) => ({ ...f, destination: v }));
            }}
            placeholder="G..."
            spellCheck={false}
            autoComplete="off"
            data-testid="destination-input"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
          />
        </label>

        {cex ? (
          <div
            role="alert"
            className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            data-testid="cex-warning"
          >
            <p className="font-semibold">CEX destination detected: {cex.name}</p>
            <p className="mt-1 text-xs">
              Mediator routing has been turned on automatically.{" "}
              {cex.requiresMemo
                ? `${cex.name} requires a deposit memo (type ${cex.memoType ?? "text"}). Add one below.`
                : ""}
              {cex.minimumDeposit ? ` Minimum deposit: ${cex.minimumDeposit} XLM.` : ""}
            </p>
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="font-medium">Memo (optional)</legend>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={form.memoType}
              onChange={(e) => {
                const v = e.currentTarget.value as FormState["memoType"];
                setForm((f) => ({ ...f, memoType: v }));
              }}
              data-testid="memo-type-select"
              aria-label="Memo type"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
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
              placeholder={form.memoType === "id" ? "12345" : "optional memo"}
              spellCheck={false}
              autoComplete="off"
              data-testid="memo-value-input"
              aria-label="Memo value"
              className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-1 font-mono text-xs disabled:opacity-50"
            />
          </div>
        </fieldset>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Fallback address (optional, for mediator route)</span>
          <input
            type="text"
            value={form.fallback}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setForm((f) => ({ ...f, fallback: v }));
            }}
            placeholder="G... (defaults to destination)"
            spellCheck={false}
            autoComplete="off"
            data-testid="fallback-input"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
          />
        </label>

        {ctx.audit && ctx.audit.claimableBalances.length > 0 ? (
          <fieldset
            className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
            data-testid="claimable-balance-list"
          >
            <legend className="px-1 font-medium">Claimable balances</legend>
            <p className="text-xs text-slate-600">
              Select the claimable balances you want to claim before merge.
            </p>
            {ctx.audit.claimableBalances.map((cb) => {
              const checked = form.selectedCbIds.includes(cb.id);
              return (
                <label key={cb.id} className="flex items-start gap-2 text-xs">
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
                  />
                  <span className="flex flex-col">
                    <span className="font-mono">{cb.id.slice(0, 16)}…</span>
                    <span className="text-slate-600">amount: {cb.amount}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : null}

        {formError ? (
          <p role="alert" className="text-xs text-red-600">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={!canStart}
            data-testid="demolish-start"
            className={cn(
              "rounded-md px-4 py-2 text-sm font-medium transition-colors",
              "bg-slate-900 text-white hover:bg-slate-800",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {isDiscovering
              ? "Auditing…"
              : isPreviewing
                ? "Building plan…"
                : "Start: Audit & preview"}
          </button>
          {isAwaitingConfirmation ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmStage(isHighValue ? "highvalue" : "typed")}
                data-testid="demolish-confirm"
                aria-label="Open final demolition confirmation"
                className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-800"
              >
                Confirm & demolish
              </button>
              <button
                type="button"
                onClick={onCancel}
                data-testid="demolish-cancel"
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100"
              >
                Cancel
              </button>
            </>
          ) : null}
          {isFailed ? (
            <button
              type="button"
              onClick={onRetry}
              data-testid="demolish-retry"
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100"
            >
              Retry
            </button>
          ) : null}
          {(isSucceeded || isFailed || isCancelled) && (
            <button
              type="button"
              onClick={onReset}
              data-testid="demolish-reset"
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100"
            >
              Reset
            </button>
          )}
          <span
            data-testid="machine-state"
            className="ml-auto rounded bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-700"
          >
            {String(state)}
          </span>
        </div>

        {ctx.audit ? <AuditCard audit={ctx.audit} /> : null}
      </section>

      {/* pending claimable balances inline alert (above plan) */}
      {pendingCbs.length > 0 ? (
        <section
          role="alert"
          aria-labelledby="pending-cb-inline-heading"
          data-testid="pending-claimable-balances-inline"
          className="flex flex-col gap-2 rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <h3 id="pending-cb-inline-heading" className="text-base font-semibold">
            Pending claimable balances will be forfeited
          </h3>
          <p className="text-xs">
            You are a claimant on{" "}
            <strong data-testid="pending-cb-count">{pendingCbs.length}</strong>{" "}
            {pendingCbs.length === 1 ? "balance" : "balances"} whose predicates are not yet
            satisfied. Merging now forfeits the claim.
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {pendingCbs.map((cb) => (
              <li key={cb.id} className="font-mono">
                {cb.amount} {cb.assetLabel} — <code>{cb.id.slice(0, 16)}…</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* inline scam-token warnings, one per flagged credit asset */}
      {scamFindings.length > 0 ? (
        <section
          aria-labelledby="scam-inline-heading"
          data-testid="scam-token-warnings-inline"
          className="flex flex-col gap-2 rounded-lg border border-red-400 bg-red-50 p-4 text-sm text-red-900"
        >
          <h3 id="scam-inline-heading" className="text-base font-semibold">
            Suspicious tokens detected
          </h3>
          <ul className="space-y-1 text-xs">
            {scamFindings.map((f, i) => (
              <li
                key={`${f.assetCode}-${f.issuer}-${i}`}
                data-testid={`scam-finding-${f.assetCode}`}
                className="rounded bg-white/60 px-2 py-1"
              >
                <span className="font-mono font-semibold">
                  {f.assetCode}:{f.issuer.slice(0, 8)}…
                </span>{" "}
                — {f.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-2 rounded-lg border border-slate-300 bg-white p-4">
        <h2 className="text-base font-semibold">3. Plan tree</h2>
        <p className="text-xs text-slate-600">
          Per-op fee cap:{" "}
          <code className="font-mono" data-testid="fee-cap-stroops">
            {cappedFeeStroops}
          </code>{" "}
          stroops
        </p>
        <PlanTree
          tree={ctx.tree}
          placeholder={
            isIdle
              ? 'Connect a wallet and click "Start" to build the plan tree.'
              : isDiscovering
                ? "Auditing account…"
                : isPreviewing
                  ? "Simulating plan…"
                  : "No plan tree yet."
          }
        />
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-slate-300 bg-white p-4">
        <h2 className="text-base font-semibold">4. Execution progress</h2>
        <ProgressLog events={ctx.progress} />
        {ctx.result ? (
          <div
            role="status"
            className={cn(
              "rounded-md border px-3 py-2 text-sm",
              ctx.result.ok
                ? "border-emerald-400 bg-emerald-50 text-emerald-900"
                : "border-red-400 bg-red-50 text-red-900",
            )}
            data-testid="demolish-result"
          >
            <p className="font-semibold">
              {ctx.result.ok ? "Demolition complete." : "Demolition completed with errors."}
            </p>
            {ctx.result.mergedTxHash ? (
              <p className="mt-1 text-xs">
                Merge tx: <code className="font-mono">{ctx.result.mergedTxHash}</code>
              </p>
            ) : null}
            {ctx.result.forwardTxHash ? (
              <p className="mt-1 text-xs">
                Forward tx: <code className="font-mono">{ctx.result.forwardTxHash}</code>
              </p>
            ) : null}
            {ctx.result.errors.length > 0 ? (
              <ul className="mt-1 list-disc pl-4 text-xs">
                {ctx.result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {ctx.error && !ctx.result ? (
          <p role="alert" className="text-xs text-red-600" data-testid="demolish-error">
            {ctx.error}
          </p>
        ) : null}
      </section>

      {/* full-screen blocks for AUTH_IMMUTABLE and sponsoring */}
      {authImmutable ? <AuthImmutableBlock onDismiss={onReset} /> : null}
      {!authImmutable && isSponsoring ? (
        <SponsoringBlock numSponsoring={numSponsoring} onDismiss={onReset} />
      ) : null}

      {/* two-stage confirm: high-value first when balance > 1000 XLM, then typed confirmation */}
      {effectiveConfirmStage === "highvalue" && isHighValue ? (
        <HighValueWarning
          totalXlm={totalXlm}
          threshold={HIGH_VALUE_THRESHOLD_XLM}
          onConfirm={() => setConfirmStage("typed")}
          onCancel={() => setConfirmStage("idle")}
        />
      ) : null}
      {effectiveConfirmStage === "typed" ? (
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
    </main>
  );
}

function isPredicateInTheFuture(predicate: unknown, now: number): boolean {
  if (predicate === null || typeof predicate !== "object") return false;
  // conservative heuristic over the small set of predicate shapes we care about
  const p = predicate as Record<string, unknown>;
  if (typeof p.abs_before_epoch === "string") {
    const n = Number(p.abs_before_epoch);
    if (Number.isFinite(n) && n > now) return true;
  }
  if (typeof p.abs_before === "string") {
    const t = Date.parse(p.abs_before);
    if (Number.isFinite(t) && t / 1000 > now) return true;
  }
  if (p.not !== undefined) {
    // not(abs_before=<future>) means claimable only after that time, so currently unclaimable
    return false;
  }
  if (Array.isArray(p.and)) {
    return p.and.some((sub) => isPredicateInTheFuture(sub, now));
  }
  return false;
}

function claimableBalanceAssetLabel(cb: ClaimableBalanceEntry): string {
  switch (cb.asset.kind) {
    case "native":
      return "XLM";
    case "credit":
      return `${cb.asset.code}:${cb.asset.issuer.slice(0, 6)}…`;
    case "liquidity_pool_shares":
      return `LP:${cb.asset.poolId.slice(0, 8)}…`;
  }
}

function parseMemo(form: FormState): ClassicMemo | undefined {
  if (form.memoType === "none") return undefined;
  const value = form.memoValue.trim();
  if (value.length === 0) return undefined;
  return { type: form.memoType, value } as ClassicMemo;
}
