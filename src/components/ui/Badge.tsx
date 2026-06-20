import type { ReactNode } from "react";
import { RADIUS, TONE_FG, TONE_SOFT, toneBorder, type Tone } from "./tokens";

export function Badge({
  children,
  tone = "neutral",
  mono = false,
  dot = false,
  bordered = false,
}: {
  readonly children: ReactNode;
  readonly tone?: Tone;
  readonly mono?: boolean;
  readonly dot?: boolean;
  readonly bordered?: boolean;
}): React.JSX.Element {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: dot ? "5px 11px 5px 9px" : "4px 9px",
        borderRadius: RADIUS.pill,
        background: TONE_SOFT[tone],
        border: bordered ? toneBorder(tone) : "1px solid transparent",
        color: TONE_FG[tone],
        font: mono ? '600 10.5px/1 "Geist Mono", monospace' : "600 11px/1 Geist, sans-serif",
        letterSpacing: mono ? "0.04em" : "0.01em",
        whiteSpace: "nowrap",
      }}
    >
      {dot ? (
        <span
          style={{ width: 6, height: 6, borderRadius: "50%", background: TONE_FG[tone] }}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  );
}

// small status dot on its own (connected indicator, network badge)
export function Dot({ tone = "accent" }: { readonly tone?: Tone }): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{ width: 7, height: 7, borderRadius: "50%", background: TONE_FG[tone], flexShrink: 0 }}
    />
  );
}
