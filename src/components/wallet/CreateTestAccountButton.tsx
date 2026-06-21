"use client";

// testnet-only convenience: spin up a throwaway account preloaded with everything
// the demolisher can clean up. Shown as a secondary path, not the primary one.

import { useCallback, useMemo, useState } from "react";

import { Badge, Button, Card, CopyableAddress } from "@/components/ui";
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
  // fires true when setup starts, so the connect screen can hand the page over
  // to this as a dedicated step
  readonly onActiveChange?: (active: boolean) => void;
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
  onActiveChange,
}: CreateTestAccountButtonProps): React.JSX.Element | null {
  const setConnected = useWalletStore((s) => s.setConnected);

  const [phase, setPhase] = useState<Phase>("idle");
  const [activeId, setActiveId] = useState<DemoStepId | null>(null);
  const [results, setResults] = useState<ReadonlyMap<DemoStepId, DemoStepResult>>(new Map());
  const [ready, setReady] = useState<ReadyAccount | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

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
    onActiveChange?.(true);
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
  }, [network, onActiveChange]);

  const onContinue = useCallback(() => {
    if (ready === null) return;
    setConnected(ready.publicKey, "secret", true);
    onConnector(ready.connector);
  }, [ready, setConnected, onConnector]);

  if (network.friendbot === null) return null;

  const successfulCount = Array.from(results.values()).filter((r) => r.status === "done").length;
  const skippedCount = Array.from(results.values()).filter((r) => r.status === "skipped").length;
  const failedCount = Array.from(results.values()).filter((r) => r.status === "failed").length;

  // idle: a compact pitch card (secondary path on the connect screen)
  if (phase === "idle") {
    return (
      <section
        data-testid="create-test-account-card"
        style={{
          padding: 22,
          borderRadius: 14,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <Header network={network} />
        <IdleBody onRun={onRun} />
      </section>
    );
  }

  // running / done / failed: a dedicated step that takes over the screen
  return (
    <div
      data-testid="create-test-account-card"
      style={{ display: "flex", flexDirection: "column", gap: 18 }}
    >
      <div>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-0.03em" }}>
          {phase === "failed"
            ? "Demo setup failed"
            : phase === "done"
              ? "Demo account ready"
              : "Setting up your demo account"}
        </h1>
        <p style={{ margin: "10px 0 0", fontSize: 14.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
          Populating a fresh {network.id} account with the trustlines, offers, signers, and Soroban
          positions the demolisher knows how to clean up — so you can walk the whole flow first.
        </p>
      </div>

      <Card padding={6}>
        <DemoStepList rows={rows} />
      </Card>

      {phase === "done" && ready !== null ? (
        <ReadyPanel
          publicKey={ready.publicKey}
          explorerUrl={ready.explorerUrl}
          successfulCount={successfulCount}
          skippedCount={skippedCount}
          failedCount={failedCount}
          onContinue={onContinue}
        />
      ) : null}

      {phase === "failed" ? (
        <FailurePanel error={fatal ?? "Unknown failure"} onRetry={onRun} />
      ) : null}
    </div>
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
          background: "var(--surface-2)",
          border: "1px solid var(--accent-line)",
          color: "var(--accent)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
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
            Try it on a demo account
          </h2>
          <Badge tone="accent">Testnet</Badge>
        </div>
        <p style={{ margin: "5px 0 0", fontSize: 13, lineHeight: 1.5, color: "var(--fg-2)" }}>
          Generate a fresh keypair, fund it via friendbot, and populate it with trustlines, data
          entries, an open offer, a co-signer, and a SEP-41 allowance — everything the demolisher
          knows how to clean up. {network.id} only, never real keys.
        </p>
      </div>
    </div>
  );
}

function IdleBody({ onRun }: { readonly onRun: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div>
        <Button
          onClick={onRun}
          data-testid="create-test-account-button"
          iconRight={
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          }
        >
          Create demo account &amp; continue
        </Button>
      </div>
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
  onContinue,
}: {
  readonly publicKey: string;
  readonly explorerUrl: string;
  readonly successfulCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly onContinue: () => void;
}) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 12,
        background: "var(--surface-2)",
        border: "1px solid color-mix(in srgb, var(--success) 32%, transparent)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        animation: "fadeUp .25s ease-out",
      }}
      data-testid="create-test-account-ready"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--success)"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
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
          <span data-testid="created-account-pk" style={{ flex: 1, minWidth: 0 }}>
            <CopyableAddress value={publicKey} head={8} tail={8} label="Demo account" />
          </span>
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
          aria-hidden
        >
          <path d="M7 17 17 7M9 7h8v8" />
        </svg>
      </a>

      <SummaryLine
        successfulCount={successfulCount}
        skippedCount={skippedCount}
        failedCount={failedCount}
      />

      <div>
        <Button
          onClick={onContinue}
          data-testid="continue-to-demolish"
          iconRight={
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          }
        >
          Continue to demolish
        </Button>
      </div>
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
    <p style={{ margin: 0, fontSize: 12, color: "var(--fg-2)" }}>
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
        background: "var(--surface)",
        border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--danger)" }}>Demo setup failed</div>
      <div
        style={{
          fontSize: 12,
          fontFamily: "'Geist Mono', ui-monospace, monospace",
          color: "var(--fg-2)",
        }}
      >
        {error}
      </div>
      <div>
        <Button variant="danger" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}
