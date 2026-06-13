"use client";

// the primary recommended path in IdleConnect

import { useCallback, useMemo, useState } from "react";

import { DemoStepList, type DemoStepRow } from "@/components/wallet/DemoStepList";
import type { NetworkConfig } from "@/lib/config/networks";
import {
  DEMO_STEPS,
  explorerTxUrl,
  runDemoSetup,
  type DemoStepId,
  type DemoStepResult,
} from "@/lib/wallet/demo-account";
import type { SecretKeyConnector } from "@/lib/wallet/secret-key";
import { useWalletStore } from "@/stores/wallet";

export interface CreateTestAccountButtonProps {
  readonly network: NetworkConfig;
  readonly onConnector: (connector: SecretKeyConnector) => void;
}

type Phase = "idle" | "running" | "done" | "failed";

interface ReadyAccount {
  readonly publicKey: string;
  readonly connector: SecretKeyConnector;
  readonly explorerUrl: string;
}

export function CreateTestAccountButton({
  network,
  onConnector,
}: CreateTestAccountButtonProps): React.JSX.Element | null {
  const setConnected = useWalletStore((s) => s.setConnected);

  const [phase, setPhase] = useState<Phase>("idle");
  const [activeId, setActiveId] = useState<DemoStepId | null>(null);
  const [results, setResults] = useState<ReadonlyMap<DemoStepId, DemoStepResult>>(new Map());
  const [ready, setReady] = useState<ReadyAccount | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = useMemo<readonly DemoStepRow[]>(
    () =>
      DEMO_STEPS.map((step) => {
        const result = results.get(step.id);
        let status: DemoStepRow["status"];
        if (result !== undefined) status = result.status;
        else if (activeId === step.id) status = "active";
        else status = "pending";

        const row: DemoStepRow = {
          id: step.id,
          label: step.label,
          description: step.description,
          status,
          ...(result?.txHash !== undefined
            ? {
                txHash: result.txHash,
                explorerTxUrl: explorerTxUrl(network, result.txHash),
              }
            : {}),
          ...(result?.detail !== undefined ? { detail: result.detail } : {}),
          ...(result?.error !== undefined ? { error: result.error } : {}),
        };
        return row;
      }),
    [results, activeId, network],
  );

  const onRun = useCallback(async () => {
    setPhase("running");
    setFatal(null);
    setResults(new Map());
    setActiveId(null);

    try {
      const result = await runDemoSetup({
        network,
        onStart: (id) => {
          setActiveId(id);
        },
        onFinish: (r) => {
          setResults((prev) => {
            const next = new Map(prev);
            next.set(r.id, r);
            return next;
          });
        },
      });
      setActiveId(null);
      setReady(result);
      setPhase("done");
    } catch (e) {
      setActiveId(null);
      setFatal(e instanceof Error ? e.message : String(e));
      setPhase("failed");
    }
  }, [network]);

  const onContinue = useCallback(() => {
    if (ready === null) return;
    setConnected(ready.publicKey, "secret", true);
    onConnector(ready.connector);
  }, [ready, setConnected, onConnector]);

  const onCopyPubkey = useCallback(async () => {
    if (ready === null) return;
    try {
      await navigator.clipboard.writeText(ready.publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard unavailable in some browsers; silently ignore
    }
  }, [ready]);

  if (network.friendbot === null) return null;

  const successfulCount = Array.from(results.values()).filter((r) => r.status === "done").length;
  const skippedCount = Array.from(results.values()).filter((r) => r.status === "skipped").length;
  const failedCount = Array.from(results.values()).filter((r) => r.status === "failed").length;

  return (
    <section
      data-testid="create-test-account-card"
      style={{
        padding: 22,
        borderRadius: 14,
        border: "1px solid var(--accent-line)",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--accent-soft) 60%, var(--surface)) 0%, var(--surface) 65%)",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <Header network={network} />

      {phase === "idle" ? <IdleBody onRun={onRun} /> : <DemoStepList rows={rows} />}

      {phase === "done" && ready !== null ? (
        <ReadyPanel
          publicKey={ready.publicKey}
          explorerUrl={ready.explorerUrl}
          successfulCount={successfulCount}
          skippedCount={skippedCount}
          failedCount={failedCount}
          copied={copied}
          onCopy={onCopyPubkey}
          onContinue={onContinue}
        />
      ) : null}

      {phase === "failed" ? (
        <FailurePanel error={fatal ?? "Unknown failure"} onRetry={onRun} />
      ) : null}
    </section>
  );
}

function Header({ network }: { readonly network: NetworkConfig }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
      <span
        aria-hidden
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          background: "var(--accent)",
          color: "var(--accent-fg)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          boxShadow: "0 1px 0 rgba(255,255,255,0.15) inset",
        }}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2
            style={{
              margin: 0,
              fontSize: 17,
              fontWeight: 600,
              color: "var(--fg)",
              letterSpacing: "-0.02em",
            }}
          >
            Create a demo account
          </h2>
          <span
            style={{
              padding: "3px 9px",
              borderRadius: 999,
              background: "var(--accent-soft)",
              color: "var(--accent)",
              border: "1px solid var(--accent-line)",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Recommended
          </span>
        </div>
        <p
          style={{
            margin: "5px 0 0",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--fg-2)",
          }}
        >
          We&apos;ll generate a fresh stellar keypair, fund it via friendbot, and populate it with
          trustlines, data entries, an open offer, a co-signer, and a SEP-41 allowance — everything
          the demolisher knows how to clean up. {network.id} only, never use real keys.
        </p>
      </div>
    </div>
  );
}

function IdleBody({ onRun }: { readonly onRun: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <button
        type="button"
        onClick={onRun}
        data-testid="create-test-account-button"
        style={{
          height: 42,
          padding: "0 18px",
          borderRadius: 10,
          border: "none",
          background: "var(--accent)",
          color: "var(--accent-fg)",
          fontWeight: 600,
          fontSize: 14,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 9,
          alignSelf: "flex-start",
        }}
      >
        Create demo account &amp; continue
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
      <p style={{ margin: 0, fontSize: 11.5, color: "var(--fg-3)" }}>
        About 15 seconds. You&apos;ll get an explorer link to verify on-chain before signing
        anything.
      </p>
    </div>
  );
}

function ReadyPanel({
  publicKey,
  explorerUrl,
  successfulCount,
  skippedCount,
  failedCount,
  copied,
  onCopy,
  onContinue,
}: {
  readonly publicKey: string;
  readonly explorerUrl: string;
  readonly successfulCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onContinue: () => void;
}) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        background: "var(--success-soft)",
        border: "1px solid color-mix(in srgb, var(--success) 32%, transparent)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        animation: "fadeUp .25s ease-out",
      }}
      data-testid="create-test-account-ready"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "var(--success)",
            color: "white",
            display: "grid",
            placeItems: "center",
            animation: "pop .35s ease-out",
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12.5l4.5 4.5L19 7" />
          </svg>
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--success)" }}>
          Demo account ready
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 11.5, color: "var(--fg-3)", letterSpacing: "0.05em" }}>
          PUBLIC KEY
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 11px",
            borderRadius: 8,
            background: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          <code
            style={{
              flex: 1,
              fontSize: 12.5,
              fontFamily: "'Geist Mono', ui-monospace, monospace",
              color: "var(--fg)",
              wordBreak: "break-all",
            }}
            data-testid="created-account-pk"
          >
            {publicKey}
          </code>
          <button
            type="button"
            onClick={onCopy}
            title="Copy public key"
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border-2)",
              background: "var(--surface-2)",
              color: "var(--fg-2)",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <a
        href={explorerUrl}
        target="_blank"
        rel="noreferrer noopener"
        data-testid="explorer-link"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          alignSelf: "flex-start",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--accent)",
          textDecoration: "none",
        }}
      >
        View on stellar.expert
        <svg
          width="13"
          height="13"
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

      <SummaryLine
        successfulCount={successfulCount}
        skippedCount={skippedCount}
        failedCount={failedCount}
      />

      <button
        type="button"
        onClick={onContinue}
        data-testid="continue-to-demolish"
        style={{
          height: 40,
          padding: "0 18px",
          borderRadius: 10,
          border: "none",
          background: "var(--accent)",
          color: "var(--accent-fg)",
          fontWeight: 600,
          fontSize: 13.5,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          alignSelf: "flex-start",
        }}
      >
        Continue to demolish
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}

function SummaryLine({
  successfulCount,
  skippedCount,
  failedCount,
}: {
  readonly successfulCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
}) {
  const parts: string[] = [`${successfulCount} steps succeeded`];
  if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);
  return (
    <p
      style={{
        margin: 0,
        fontSize: 12,
        color: "var(--fg-2)",
      }}
    >
      {parts.join(" · ")} — the demolisher will surface every entry during preview.
    </p>
  );
}

function FailurePanel({
  error,
  onRetry,
}: {
  readonly error: string;
  readonly onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        padding: 14,
        borderRadius: 11,
        background: "var(--danger-soft)",
        border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        color: "var(--danger)",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>Demo setup failed</div>
      <div style={{ fontSize: 12, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
        {error}
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          alignSelf: "flex-start",
          height: 34,
          padding: "0 14px",
          borderRadius: 8,
          border: "1px solid color-mix(in srgb, var(--danger) 50%, transparent)",
          background: "color-mix(in srgb, var(--danger) 18%, transparent)",
          color: "var(--danger)",
          fontWeight: 600,
          fontSize: 12.5,
          cursor: "pointer",
        }}
      >
        Try again
      </button>
    </div>
  );
}
