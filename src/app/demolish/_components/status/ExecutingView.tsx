"use client";

import { useEffect, useState } from "react";

import type { SigningMode, StatusRun, StatusView } from "./types";

// seconds since the run entered executing
export function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    const h = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(h);
  }, [active]);
  return elapsed;
}

export function executingView(run: StatusRun, elapsed: number): StatusView {
  const pct = run.activeCount > 0 ? Math.round((run.doneCount / run.activeCount) * 100) : 0;
  return {
    accent: "var(--accent)",
    icon: <ArrowIcon />,
    iconAnimation: "pulse 2s ease-in-out infinite",
    title: "Closing your account",
    subtitle: <ExecutingSubtitle signingMode={run.signingMode} elapsed={elapsed} />,
    headerExtras: <ExecutingProgress pct={pct} />,
    footer: null,
    trailing: null,
  };
}

function ExecutingSubtitle({
  signingMode,
  elapsed,
}: {
  readonly signingMode: SigningMode;
  readonly elapsed: number;
}): React.JSX.Element {
  const running = elapsed > 0 ? `Running for ${elapsed}s.` : "";
  if (signingMode === "bundle") {
    return <>Submitting the collected signatures. Nothing else needs to be signed. {running}</>;
  }
  if (signingMode === "secret") {
    return (
      <>
        Signing each step with your key in this browser, so no wallet window will appear. {running}
      </>
    );
  }
  return (
    <>
      Your wallet will pop up to approve each step, click{" "}
      <strong style={{ color: "var(--fg)" }}>Sign</strong> in your wallet when it appears. If
      nothing seems to happen, check for a wallet window behind this tab. {running}
    </>
  );
}

// progress bar and a prominent "don't leave" guard
function ExecutingProgress({ pct }: { readonly pct: number }): React.JSX.Element {
  return (
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
          <strong style={{ color: "var(--warning)" }}>Keep this tab open.</strong> Leaving now could
          stop the close-out partway through, with some steps done and the account not yet closed.
        </span>
      </div>
    </>
  );
}

function ArrowIcon(): React.JSX.Element {
  return (
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
  );
}
