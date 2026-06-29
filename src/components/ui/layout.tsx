import type { CSSProperties, ReactNode } from "react";
import { RADIUS } from "./tokens";

// One consistent page frame for the app pages. The default width matches the
// /demolish flow's content column so /allowances and /plan line up with it
// instead of each using a different container.
export const PAGE_CONTENT_WIDTH = 760;

export function PageContainer({
  children,
  width = PAGE_CONTENT_WIDTH,
  style,
}: {
  readonly children: ReactNode;
  readonly width?: number;
  readonly style?: CSSProperties;
}): React.JSX.Element {
  return (
    <div style={{ maxWidth: width, margin: "0 auto", padding: "40px 24px 96px", ...style }}>
      {children}
    </div>
  );
}

export function Kicker({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        font: "600 12px/1 Geist, sans-serif",
        color: "var(--accent)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  kicker,
  title,
  subtitle,
  right,
}: {
  readonly kicker?: string;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly right?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 20,
        flexWrap: "wrap",
        marginBottom: 28,
      }}
    >
      <div style={{ minWidth: 0 }}>
        {kicker ? <Kicker>{kicker}</Kicker> : null}
        <h1
          style={{
            margin: 0,
            fontSize: 34,
            fontWeight: 600,
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
          }}
        >
          {title}
        </h1>
        {subtitle ? (
          <p
            style={{
              margin: "12px 0 0",
              fontSize: 15,
              lineHeight: 1.55,
              color: "var(--fg-2)",
              maxWidth: 620,
            }}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {right ? <div style={{ flexShrink: 0 }}>{right}</div> : null}
    </div>
  );
}

export function Card({
  children,
  padding = 20,
  style,
  raised = false,
  "data-testid": testId,
}: {
  readonly children: ReactNode;
  readonly padding?: number | string;
  readonly style?: CSSProperties;
  readonly raised?: boolean;
  readonly "data-testid"?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: RADIUS.xl,
        boxShadow: raised ? "var(--shadow)" : "var(--shadow-sm)",
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// header strip inside a Card (title left, meta/actions right), divider below
export function CardHeader({
  title,
  right,
}: {
  readonly title: ReactNode;
  readonly right?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "16px 20px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 14.5, letterSpacing: "-0.01em" }}>{title}</span>
      {right}
    </div>
  );
}

export function SectionLabel({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        font: "600 10.5px/1 Geist, sans-serif",
        color: "var(--fg-3)",
        letterSpacing: "0.07em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

// evenly-split stat row (Reserve recovered · Plan steps · Forwarded…)
export function StatGrid({
  stats,
}: {
  readonly stats: ReadonlyArray<{ label: string; value: ReactNode; tone?: "default" | "accent" }>;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${stats.length}, 1fr)`,
        gap: 1,
        background: "var(--border)",
        border: "1px solid var(--border)",
        borderRadius: RADIUS.lg,
        overflow: "hidden",
      }}
    >
      {stats.map((s) => (
        <div key={s.label} style={{ background: "var(--surface)", padding: "14px 16px" }}>
          <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginBottom: 6 }}>{s.label}</div>
          <div
            style={{
              font: '600 18px/1 "Geist Mono", monospace',
              color: s.tone === "accent" ? "var(--accent)" : "var(--fg)",
              letterSpacing: "-0.01em",
            }}
          >
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}
