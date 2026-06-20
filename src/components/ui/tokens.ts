// Shared design constants for the UI primitive layer. Colors live as CSS
// custom properties in globals.css (var(--*)); these are the numeric scales
// (radius/space/font) the primitives share so the three rebuilt pages stop
// drifting on paddings and corners.

export const RADIUS = {
  sm: 8,
  md: 11,
  lg: 14,
  xl: 18,
  pill: 999,
} as const;

// 4px-based spacing scale
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const MONO = '"Geist Mono", ui-monospace, monospace';

// tone → (foreground token, soft-background token) for semantic surfaces
export type Tone = "accent" | "success" | "warning" | "danger" | "neutral";

export const TONE_FG: Record<Tone, string> = {
  accent: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  neutral: "var(--fg-2)",
};

export const TONE_SOFT: Record<Tone, string> = {
  accent: "var(--accent-soft)",
  success: "var(--success-soft)",
  warning: "var(--warning-soft)",
  danger: "var(--danger-soft)",
  neutral: "var(--pending-soft)",
};

// a tone-tinted 1px border, ~30% of the tone mixed over transparent
export function toneBorder(tone: Tone): string {
  if (tone === "neutral") return "1px solid var(--border-2)";
  return `1px solid color-mix(in srgb, ${TONE_FG[tone]} 30%, transparent)`;
}
