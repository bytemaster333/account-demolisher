// numeric scales the ui primitives share. colors live as css custom
// properties in globals.css.

export const RADIUS = {
  sm: 8,
  md: 11,
  lg: 14,
  xl: 18,
  pill: 999,
} as const;

export const MONO = '"Geist Mono", ui-monospace, monospace';

// tone → foreground token for semantic surfaces
export type Tone = "accent" | "success" | "warning" | "danger" | "neutral";

export const TONE_FG: Record<Tone, string> = {
  accent: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  neutral: "var(--fg-2)",
};

// a tone-tinted 1px border, ~30% of the tone mixed over transparent
export function toneBorder(tone: Tone): string {
  if (tone === "neutral") return "1px solid var(--border-2)";
  return `1px solid color-mix(in srgb, ${TONE_FG[tone]} 30%, transparent)`;
}

// hidden on screen, still read by screen readers
export const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;
