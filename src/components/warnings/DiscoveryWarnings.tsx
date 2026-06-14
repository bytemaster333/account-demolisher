"use client";

// surfaced when a best-effort discovery step (allowance scan / DeFi position
// probe) failed. The plan can still run, but it may be incomplete — so we say
// so plainly instead of hiding the failure in the console.

export interface DiscoveryWarningsProps {
  readonly warnings: readonly string[];
}

export function DiscoveryWarnings({ warnings }: DiscoveryWarningsProps): React.JSX.Element | null {
  if (warnings.length === 0) return null;

  return (
    <div
      role="alert"
      data-testid="discovery-warnings"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 14px",
        borderRadius: 11,
        background: "color-mix(in srgb, var(--warning-soft) 60%, transparent)",
        border: "1px solid color-mix(in srgb, var(--warning) 22%, transparent)",
        color: "var(--fg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--warning)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <path d="M12 9v4M12 17h.01" />
        </svg>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>
          Discovery was incomplete — this plan may be missing some entries
        </span>
      </div>
      <ul
        style={{
          listStyle: "disc",
          margin: 0,
          paddingLeft: 30,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {warnings.map((w) => (
          <li key={w} style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-2)" }}>
            {w}
          </li>
        ))}
      </ul>
    </div>
  );
}
