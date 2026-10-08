"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AddressActions, useCopyToClipboard } from "@/components/ui";
import { PendingForwardBanner } from "@/components/wallet/PendingForwardBanner";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/explorer";
import { loadPendingForwards } from "@/lib/mediator/pending-flow";
import type { FailureKind } from "@/lib/orchestrator/page-flow-machine";
import type { PhaseReceipt } from "@/lib/orchestrator/journal";
import type { PlanTree, PreparePlan } from "@/lib/plan/tree";
import { EVENT_RETENTION_WINDOW_LEDGERS } from "@/lib/soroban/event-retention";

import { SR_ONLY } from "../_lib/a11y";
import { parseDemolishError } from "../_lib/demolish-error";
import { failureNoteFor, type FailureNote } from "../_lib/failure-note";
import { nodePlainLabel, phasePlainLabel, type PlanGroup } from "../_lib/plan-copy";
import { buildReceiptText } from "../_lib/receipt";
import { PlanRow } from "./PlanRow";
import { shortAddress } from "@/lib/safe-display";

export type DeliveredAmount =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly xlm: string }
  | { readonly status: "unavailable" };

// how the steps of this run get signed: a wallet prompts per step, a pasted or
// demo key signs in this browser with no prompt, and a collected bundle is
// already signed by everyone
export type SigningMode = "wallet" | "secret" | "bundle";

// single, evolving widget that covers execute / succeeded / prepared / failed
export function DemolishStatusWidget({
  state,
  tree,
  planGroups,
  doneCount,
  activeCount,
  network,
  closedAccount,
  destination,
  mergeHash,
  delivered,
  error,
  signingMode,
  retryResumes,
  retryDisabledReason,
  failureKind = null,
  executionNotes = [],
  landedPhases = [],
  discoveryDiagnostics = [],
  prepared = null,
  onRetry,
  onReset,
  onPreparedDone,
}: {
  // "prepared": every step ran but nothing merged, the account stays open until
  // the queued backstop withdrawal unlocks
  readonly state: "executing" | "succeeded" | "prepared" | "failed";
  readonly tree: PlanTree;
  readonly planGroups: readonly PlanGroup[];
  readonly doneCount: number;
  readonly activeCount: number;
  // the network this run is executing on (not the navbar's current choice)
  readonly network: NetworkConfig;
  readonly closedAccount: string;
  readonly destination: string;
  readonly mergeHash: string | null;
  readonly delivered: DeliveredAmount;
  readonly error: string | null;
  readonly signingMode: SigningMode;
  // whether RETRY re-runs the remaining steps (true) or rebuilds from a fresh
  // audit (false), so the copy never promises a resume that won't happen. the
  // retryable kinds (isRetryableFailure) are bad_seq, changed_footprint,
  // network, signing, ambiguous, forward_pending, interrupted and close_running;
  // everything else, unknown and conversion_refused included, rebuilds the plan
  readonly retryResumes: boolean;
  readonly retryDisabledReason?: string | null;
  readonly failureKind?: FailureKind | null;
  // best-effort steps that did not do what the plan asked
  readonly executionNotes?: readonly string[];
  // classic batches that landed in this run (unwind phases and close batches),
  // including those of a close that did not finish
  readonly landedPhases?: readonly PhaseReceipt[];
  // technical detail behind the discovery warnings
  readonly discoveryDiagnostics?: readonly string[];
  // the run's own prepared close (unlock time and reason), for the prepared state
  readonly prepared?: PreparePlan | null;
  readonly onRetry: () => void;
  readonly onReset: () => void;
  // leaves the prepared state for Configure, keeping the wallet connected
  readonly onPreparedDone?: () => void;
}): React.JSX.Element {
  // the run ended, either way the steps' work is final
  const ended = state === "succeeded" || state === "prepared";
  const accent =
    state === "succeeded"
      ? "var(--success)"
      : state === "failed"
        ? "var(--danger)"
        : state === "prepared"
          ? "var(--warning)"
          : "var(--accent)";
  const accentSoft = "var(--surface-2)";

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

  // the note and the landed-transaction list come from the same facts, so they
  // can't contradict each other
  const note: FailureNote | null = useMemo(
    () => (state === "failed" ? failureNoteFor(tree, landedPhases) : null),
    [state, tree, landedPhases],
  );
  const unlockDate = prepared?.unlocksAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // a plain-text receipt of an irreversible action. A closed account can't be
  // looked up later, so when the clipboard is missing or blocked the text is
  // shown for manual copy, and a download is always offered.
  const receiptText = buildReceiptText({
    closedAccount,
    destination,
    deliveredXlm: delivered.status === "ok" ? delivered.xlm : null,
    network,
    mergeHash,
    ordered: planGroups.flatMap((g) => g.nodes),
    ...(state === "prepared" && prepared !== null ? { preparedUntil: prepared.unlocksAt } : {}),
  });
  // a blocked copy (permissions, an in-app browser) shows the text instead
  const receiptCopy = useCopyToClipboard(1600);
  const copyState = receiptCopy.state;
  const copyReceipt = (): Promise<void> => receiptCopy.copy(receiptText);
  const downloadReceipt = (): void => {
    const url = URL.createObjectURL(new Blob([receiptText], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state === "prepared" ? "close-prepared" : "account-closed"}-${closedAccount.slice(0, 8)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const copied = copyState === "copied";

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
              animation: ended
                ? "pop .35s ease-out"
                : state === "executing"
                  ? "pulse 2s ease-in-out infinite"
                  : "none",
            }}
          >
            {ended ? (
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
                  : state === "prepared"
                    ? "Preparation done, account still open"
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
              {state === "prepared" ? (
                <span data-testid="prepared-note">
                  The preparation steps landed and the account is still open. Nothing was sent to
                  the destination yet.{" "}
                  {prepared !== null
                    ? `${prepared.reason} Come back on or after ${unlockDate} to finish the close.`
                    : "Come back once the queued withdrawal unlocks to finish the close."}
                </span>
              ) : state === "succeeded" ? (
                <>
                  {delivered.status === "ok" ? (
                    <>
                      <strong style={{ color: "var(--fg)", fontFamily: "'Geist Mono', monospace" }}>
                        {delivered.xlm} XLM
                      </strong>{" "}
                      was delivered to{" "}
                    </>
                  ) : (
                    // no figure until the chain confirms one: the pre-close
                    // balance ignores fees and every conversion
                    <>Your remaining balance was sent to </>
                  )}
                  <span
                    title={destination}
                    style={{ fontFamily: "'Geist Mono', monospace", color: "var(--fg-2)" }}
                  >
                    {destination.length > 10 ? shortAddress(destination) : destination}
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
                (parsed?.summary ?? "The close stopped. See the details below.")
              ) : signingMode === "bundle" ? (
                <>
                  Submitting the collected signatures. Nothing else needs to be signed.{" "}
                  {elapsed > 0 ? `Running for ${elapsed}s.` : ""}
                </>
              ) : signingMode === "secret" ? (
                <>
                  Signing each step with your key in this browser, so no wallet window will appear.{" "}
                  {elapsed > 0 ? `Running for ${elapsed}s.` : ""}
                </>
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
            <span>{shortAddress(mergeHash, 8, 6)}</span>
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

        {state === "failed" && note !== null ? (
          <FailureNoteView
            note={note}
            network={network}
            destination={destination}
            closedAccount={closedAccount}
            retryResumes={retryResumes}
          />
        ) : null}

        {state === "failed" && failureKind !== null && FAILURE_KIND_COPY[failureKind] ? (
          <p
            data-testid="failure-kind-note"
            style={{ margin: "10px 0 0", fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-2)" }}
          >
            {FAILURE_KIND_COPY[failureKind]}
          </p>
        ) : null}

        {(ended || state === "failed") && executionNotes.length > 0 ? (
          <div
            role="note"
            data-testid="execution-notes"
            style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-2)" }}
          >
            <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
              Not everything went as planned:
            </strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {executionNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {ended || state === "failed" ? (
          <p style={{ margin: "10px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "var(--fg-3)" }}>
            Token spending permissions were looked for in about the last 7 days of approve events (
            {EVENT_RETENTION_WINDOW_LEDGERS.toLocaleString("en-US")} ledgers); an older one was not
            seen.
          </p>
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
                  title={`operation ${i + 1} in the transaction: ${op}`}
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
        {planGroups.map((g, gi) => (
          <div key={`${g.phase}-${gi}`}>
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
      {ended || state === "failed" ? (
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
                disabled={Boolean(retryDisabledReason)}
                title={retryDisabledReason ?? undefined}
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
                onClick={() => void copyReceipt()}
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
                {copied ? "Copied ✓" : "Copy a receipt"}
              </button>
              <button
                type="button"
                onClick={downloadReceipt}
                data-testid="demolish-download-receipt"
                style={{
                  height: 40,
                  padding: "0 16px",
                  borderRadius: 10,
                  border: "1px solid var(--border-2)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  fontWeight: 600,
                  fontSize: 13.5,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Download .txt
              </button>
              {state === "prepared" ? (
                <button
                  type="button"
                  onClick={onPreparedDone}
                  data-testid="demolish-prepared-done"
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
                  Done
                </button>
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
              )}
            </>
          )}
        </div>
      ) : null}

      {ended ? (
        <div style={{ background: "var(--bg-2)" }}>
          <p role="status" aria-live="polite" data-testid="demolish-copy-status" style={SR_ONLY}>
            {copyState === "copied"
              ? "Receipt copied to the clipboard."
              : copyState === "failed"
                ? "Copying isn't available here. The receipt text is shown below."
                : ""}
          </p>
          {copyState === "failed" ? (
            <div style={{ padding: "0 18px 16px" }}>
              <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--fg-2)" }}>
                Copying isn&apos;t available in this browser. Select the text below to copy it, or
                use Download .txt.
              </p>
              <textarea
                readOnly
                value={receiptText}
                data-testid="demolish-receipt-text"
                aria-label="Receipt text"
                rows={Math.min(12, receiptText.split("\n").length + 1)}
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: 10,
                  borderRadius: 9,
                  border: "1px solid var(--border-2)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  font: "500 11.5px/1.5 'Geist Mono', monospace",
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {discoveryDiagnostics.length > 0 && state !== "executing" ? (
        <details
          data-testid="discovery-diagnostics"
          style={{
            margin: 0,
            padding: "10px 16px 14px",
            background: "var(--surface)",
            borderTop: "1px solid var(--border)",
            fontSize: 11.5,
            color: "var(--fg-3)",
          }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Technical details</summary>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, wordBreak: "break-all" }}>
            {discoveryDiagnostics.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
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

// the failure note, branched on what the tree's receipts prove happened. It
// never claims the balance is untouched once any step has a receipt, and after
// the merge into the helper account it points at the one recovery action.
function FailureNoteView({
  note,
  network,
  destination,
  closedAccount,
  retryResumes,
}: {
  readonly note: FailureNote;
  readonly network: NetworkConfig;
  readonly destination: string;
  readonly closedAccount: string;
  readonly retryResumes: boolean;
}): React.JSX.Element {
  const retryCopy = retryResumes
    ? "Press Retry to run the remaining steps again; steps marked done are not repeated."
    : "Retry re-checks the account and builds a fresh plan before anything else runs.";
  const warn = note.kind === "in-mediator" || note.kind === "partial" || note.kind === "closed";
  // the resume action needs this flow's own record, saved before the merge. read
  // once: a delivered forward removes the record, and the banner must stay put
  // to show the delivery. storage that can't be read is said, not taken as "no
  // record"
  const [record] = useState<{ readonly found: boolean; readonly error: string | null }>(() => {
    if (note.kind !== "in-mediator") return { found: false, error: null };
    try {
      return {
        found: loadPendingForwards(closedAccount).some(
          (r) => r.mediatorPublicKey === note.mediatorPublicKey && r.networkId === network.id,
        ),
        error: null,
      };
    } catch (err) {
      return { found: false, error: errorMessage(err) };
    }
  });
  const hadRecord = record.found;
  const [forwardDelivered, setForwardDelivered] = useState(false);
  return (
    <div
      role="note"
      data-testid="demolish-failure-note"
      data-kind={note.kind}
      style={{
        marginTop: 14,
        padding: "12px 14px",
        borderRadius: 12,
        border: `1px solid color-mix(in srgb, var(${warn ? "--warning" : "--border-2"}) 45%, transparent)`,
        fontSize: 12.5,
        lineHeight: 1.55,
        color: "var(--fg-2)",
      }}
    >
      {note.kind === "in-mediator" ? (
        <>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            {forwardDelivered
              ? "Your account was closed and the forward was delivered."
              : "Your account was closed and the funds are in a temporary forwarding account."}
          </strong>{" "}
          The merge (
          <a
            href={explorerTxUrl(network, note.mergeHash)}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--fg)" }}
          >
            {shortAddress(note.mergeHash, 8, 6)}
          </a>
          ) moved the whole balance into the helper account {shortAddress(note.mediatorPublicKey)}
          {forwardDelivered
            ? `, and the forward has now delivered it to ${shortAddress(destination)}.`
            : `, but the delivery to ${shortAddress(destination)} didn't finish.`}{" "}
          {hadRecord ? (
            <>
              {forwardDelivered
                ? null
                : "Use Resume the forward below: it sends that balance on to your destination with your memo."}
              <div style={{ marginTop: 10 }}>
                <PendingForwardBanner
                  publicKey={closedAccount}
                  mediatorPublicKey={note.mediatorPublicKey}
                  current
                  onResolved={() => setForwardDelivered(true)}
                />
              </div>
            </>
          ) : (
            // the record is written before the merge; without it (storage blocked)
            // this page has nothing to resume from
            <>
              {record.error !== null
                ? `This browser's storage couldn't be read (${record.error}), so the forward can't be resumed from here.`
                : "This browser has no saved record of the forward, so it can't be resumed from here."}{" "}
              Keep the merge link above and the helper account address:{" "}
              <code style={{ wordBreak: "break-all" }}>{note.mediatorPublicKey}</code>.
              {retryResumes ? (
                <div style={{ marginTop: 8 }}>
                  Retry runs the forward again from this tab; the merge is not repeated.
                </div>
              ) : null}
            </>
          )}
          <LandedList phases={note.landed} network={network} />
        </>
      ) : note.kind === "closed" ? (
        <>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            The account merge landed, so this account is closed.
          </strong>{" "}
          See the merge on the explorer:{" "}
          <a
            href={explorerTxUrl(network, note.mergeHash)}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--fg)" }}
          >
            {shortAddress(note.mergeHash, 8, 6)}
          </a>
          .
          <LandedList phases={note.landed} network={network} />
        </>
      ) : note.kind === "partial" ? (
        <>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            Some steps already ran and changed your balances.
          </strong>{" "}
          Your account is still open.
          {note.ran.length > 0 ? (
            <>
              {" "}
              These steps finished on chain and are not undone:
              <ul style={{ margin: "6px 0 6px", paddingLeft: 18 }}>
                {note.ran.map((n) => (
                  <li key={n.id}>{nodePlainLabel(n)}</li>
                ))}
              </ul>
            </>
          ) : null}
          <LandedList phases={note.landed} network={network} />
          <div style={{ marginTop: 6 }}>{retryCopy}</div>
        </>
      ) : (
        <>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            Your account is still open.
          </strong>{" "}
          No step of this close finished on chain.
          {note.multiBatch
            ? " The close needed more than one transaction, so an earlier one may already have run; check the account on the explorer before retrying."
            : ""}{" "}
          {retryCopy}
        </>
      )}
    </div>
  );
}

// what Retry does for each failure kind, where the generic copy isn't enough
const FAILURE_KIND_COPY: Partial<Record<FailureKind, string>> = {
  forward_pending:
    "Your balance is in the temporary forwarding account. Retry runs the forward again from this tab; the merge is not repeated.",
  bundle_stale:
    "The signed bundle can no longer land, so its signatures can't be used. Retry starts a new signing request, and every signer has to sign again.",
  interrupted:
    "The close stopped between steps, because it was cancelled or the wallet or network changed. Retry runs the steps that didn't land; the ones marked done are not repeated.",
  mediator_expired:
    "The authorization for the temporary forwarding account ran too low to sign the merge safely, so the merge was not signed. Retry builds a fresh plan.",
  ambiguous:
    "An earlier submission's outcome isn't known yet. Retry checks it on the network before anything is signed again.",
  conversion_refused:
    "The price moved since you reviewed it, so the conversion was not signed. Retry rebuilds the plan so you can decide again for each token.",
  claim_unavailable:
    "A Blend backstop rewards claim that worked at review can no longer run, so nothing more was signed. Retry rebuilds the plan, and the review then asks whether to leave those rewards unclaimed.",
  close_running:
    "A close for this account is already running in this tab. Wait for it to finish, then Retry runs only what didn't land.",
};

// the run's own classic transactions that reached the chain (an unwind phase,
// an earlier close batch, or the merge), so the user knows what is already
// final when a later one failed. Nothing is said when none landed: the failure
// note covers that.
function LandedList({
  phases,
  network,
}: {
  readonly phases: readonly PhaseReceipt[];
  readonly network: NetworkConfig;
}): React.JSX.Element | null {
  if (phases.length === 0) return null;
  return (
    <div data-testid="landed-phases" data-count={phases.length} style={{ marginTop: 6 }}>
      These transactions of this close are on chain and are not undone:
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {phases.map((p) => (
          <li key={p.txHash}>
            <a
              href={explorerTxUrl(network, p.txHash)}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: "var(--fg)" }}
            >
              {shortAddress(p.txHash, 8, 6)}
            </a>{" "}
            in ledger {p.ledger}
          </li>
        ))}
      </ul>
    </div>
  );
}
