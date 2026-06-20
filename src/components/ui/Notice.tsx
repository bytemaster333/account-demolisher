import type { ReactNode } from "react";
import { RADIUS, TONE_FG, toneBorder, type Tone } from "./tokens";

// icon glyphs (stroke paths) per tone — the app's Feather-style vocabulary
const ICONS: Record<Tone, string> = {
  accent: "M12 16v-4M12 8h.01",
  neutral: "M12 16v-4M12 8h.01",
  success: "M20 6L9 17l-5-5",
  warning:
    "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  danger:
    "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
};

// The app's signature semantic callout: tinted card, leading icon, title,
// body, optional child rows/actions. Replaces the many hand-rolled notice
// cards (scam tokens, discovery warnings, claimable, residue, etc.).
export function Notice({
  tone = "neutral",
  title,
  children,
  icon,
  "data-testid": testId,
  role = "note",
}: {
  readonly tone?: Tone;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly icon?: ReactNode;
  readonly "data-testid"?: string;
  readonly role?: "note" | "alert" | "status";
}): React.JSX.Element {
  const iconNode = icon ?? (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={TONE_FG[tone]}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {tone === "warning" || tone === "danger" ? (
        <>
          <path d={ICONS[tone]} />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d={ICONS[tone]} />
        </>
      )}
    </svg>
  );

  return (
    <div
      role={role === "note" ? undefined : role}
      data-testid={testId}
      style={{
        display: "flex",
        gap: 13,
        padding: "15px 17px",
        borderRadius: RADIUS.lg,
        // flat: neutral surface, tone carried by the tinted border + icon/title
        background: "var(--surface)",
        border: toneBorder(tone),
        borderLeft: `3px solid ${TONE_FG[tone]}`,
        color: "var(--fg)",
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 1 }}>{iconNode}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title ? (
          <div style={{ fontSize: 13.5, fontWeight: 600, color: TONE_FG[tone] }}>{title}</div>
        ) : null}
        {children ? (
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--fg-2)",
              marginTop: title ? 5 : 0,
            }}
          >
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
