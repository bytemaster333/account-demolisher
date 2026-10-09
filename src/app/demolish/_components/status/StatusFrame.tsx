"use client";

import type { NetworkConfig } from "@/lib/config/networks";

import { phasePlainLabel, type PlanGroup } from "../../_lib/plan-copy";
import { PlanRow } from "../PlanRow";
import type { StatusState, StatusView } from "./types";

// the card every state shares: header with the live title and step counter,
// the plan rows as the body, then the state's footer and trailing sections
export function StatusFrame({
  state,
  view,
  planGroups,
  doneCount,
  activeCount,
  network,
}: {
  readonly state: StatusState;
  readonly view: StatusView;
  readonly planGroups: readonly PlanGroup[];
  readonly doneCount: number;
  readonly activeCount: number;
  readonly network: NetworkConfig;
}): React.JSX.Element {
  const accent = view.accent;
  const accentSoft = "var(--surface-2)";
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
              animation: view.iconAnimation,
            }}
          >
            {view.icon}
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
                {view.title}
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
              {view.subtitle}
            </p>
          </div>
        </div>

        {view.headerExtras}
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

      {view.footer}
      {view.trailing}
    </div>
  );
}

// the run ended either way and the steps' work is final
export function CheckIcon(): React.JSX.Element {
  return (
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
  );
}

// the footer row the ended and failed states put their buttons in
export const FOOTER_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 10,
  padding: "16px 18px",
  borderTop: "1px solid var(--border)",
  background: "var(--bg-2)",
};

// the collapsed sections under the footer
export const DETAILS_STYLE: React.CSSProperties = {
  margin: 0,
  padding: "10px 16px 14px",
  background: "var(--surface)",
  borderTop: "1px solid var(--border)",
  fontSize: 11.5,
  color: "var(--fg-3)",
};

// technical detail behind the discovery warnings, once the run is not executing
export function DiscoveryDiagnostics({
  items,
}: {
  readonly items: readonly string[];
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <details data-testid="discovery-diagnostics" style={DETAILS_STYLE}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Technical details</summary>
      <ul style={{ margin: "8px 0 0", paddingLeft: 18, wordBreak: "break-all" }}>
        {items.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
    </details>
  );
}
