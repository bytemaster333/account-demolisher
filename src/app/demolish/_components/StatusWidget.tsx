"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AddressActions } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/explorer";
import type { PlanNode } from "@/lib/plan/tree";

import { parseDemolishError } from "../_lib/demolish-error";
import { truncateHash } from "../_lib/format";
import { nodeLabel, phasePlainLabel } from "../_lib/plan-copy";
import { PlanRow } from "./PlanRow";

// single, evolving widget that covers execute / succeeded / failed
export function DemolishStatusWidget({
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
