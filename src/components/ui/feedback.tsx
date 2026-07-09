import type { ReactNode } from "react";
import { RADIUS } from "./tokens";

export function Spinner({ size = 16 }: { readonly size?: number }): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${Math.max(2, size / 8)}px solid var(--accent-soft)`,
        borderTopColor: "var(--accent)",
        animation: "spin .8s linear infinite",
        display: "inline-block",
      }}
    />
  );
}

// Labeled progress track (X / Y weight, reserve recovered, signatures…).
// `tone="accent"` fills with the accent while collecting and flips to success
// once value reaches max, so a met threshold reads as done rather than staying a
// flat grey bar. Omitting `tone` keeps the neutral grey fill.
export function Progress({
  value,
  max,
  label,
  valueLabel,
  tone = "neutral",
  "data-testid": testId,
}: {
  readonly value: number;
  readonly max: number;
  readonly label?: ReactNode;
  readonly valueLabel?: ReactNode;
  readonly tone?: "neutral" | "accent";
  readonly "data-testid"?: string;
}): React.JSX.Element {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const complete = max > 0 && value >= max;
  const fill = complete ? "var(--success)" : tone === "accent" ? "var(--accent)" : "var(--fg-2)";
  return (
    <div>
      {label || valueLabel ? (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 9,
          }}
        >
          {label ? <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span> : <span />}
          {valueLabel ? (
            <span
              data-testid={testId}
              style={{ font: '600 13px/1 "Geist Mono", monospace', color: "var(--fg-2)" }}
            >
              {valueLabel}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        style={{
          height: 8,
          borderRadius: RADIUS.pill,
          background: "var(--surface-3)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: RADIUS.pill,
            background: fill,
            transition: "width .4s ease, background .4s ease",
          }}
        />
      </div>
    </div>
  );
}

// Centered placeholder for empty / prompt / loading states.
export function EmptyState({
  icon,
  title,
  body,
  dashed = true,
  "data-testid": testId,
}: {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly body?: ReactNode;
  readonly dashed?: boolean;
  readonly "data-testid"?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      style={{
        border: dashed ? "1px dashed var(--border-2)" : "1px solid var(--border)",
        background: dashed ? "transparent" : "var(--surface)",
        borderRadius: RADIUS.xl,
        padding: "52px 24px",
        textAlign: "center",
      }}
    >
      {icon ? (
        <div
          style={{
            width: 46,
            height: 46,
            margin: "0 auto 16px",
            borderRadius: RADIUS.md,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            display: "grid",
            placeItems: "center",
            color: "var(--fg-3)",
          }}
        >
          {icon}
        </div>
      ) : null}
      <div style={{ fontWeight: 600, fontSize: 15.5 }}>{title}</div>
      {body ? (
        <div style={{ fontSize: 13.5, color: "var(--fg-2)", marginTop: 7, lineHeight: 1.5 }}>
          {body}
        </div>
      ) : null}
    </div>
  );
}

// glyph search icon reused by several empty/scan states
export function SearchGlyph({ size = 22 }: { readonly size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
