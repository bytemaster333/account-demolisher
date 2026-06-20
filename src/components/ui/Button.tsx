"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { RADIUS } from "./tokens";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly variant?: Variant;
  readonly size?: Size;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  // reason shown as a tooltip when disabled — makes a blocked CTA legible
  readonly disabledReason?: string | undefined;
  readonly iconLeft?: ReactNode;
  readonly iconRight?: ReactNode;
  readonly fullWidth?: boolean;
  readonly type?: "button" | "submit";
  readonly style?: CSSProperties;
  readonly "data-testid"?: string;
  readonly "aria-label"?: string;
}

const SIZES: Record<Size, CSSProperties> = {
  sm: { height: 34, padding: "0 13px", fontSize: 13, borderRadius: RADIUS.sm, gap: 7 },
  md: { height: 42, padding: "0 18px", fontSize: 14, borderRadius: RADIUS.md, gap: 8 },
  lg: { height: 50, padding: "0 22px", fontSize: 15, borderRadius: RADIUS.md, gap: 9 },
};

// flat / outline aesthetic — no colored fills anywhere. Emphasis comes from
// border strength and text color, not a tinted background.
function surfaceFor(variant: Variant, hover: boolean): CSSProperties {
  switch (variant) {
    case "primary":
      return {
        background: hover ? "var(--surface-2)" : "transparent",
        color: "var(--accent)",
        border: `1px solid ${hover ? "var(--accent)" : "var(--accent-line)"}`,
      };
    case "danger":
      return {
        background: hover ? "var(--surface-2)" : "transparent",
        color: "var(--danger)",
        border: `1px solid color-mix(in srgb, var(--danger) ${hover ? "60%" : "40%"}, transparent)`,
      };
    case "ghost":
      return {
        background: hover ? "var(--surface-2)" : "transparent",
        color: "var(--fg)",
        border: "1px solid transparent",
      };
    case "secondary":
    default:
      return {
        background: hover ? "var(--surface-2)" : "transparent",
        color: "var(--fg)",
        border: `1px solid ${hover ? "var(--fg-3)" : "var(--border-2)"}`,
      };
  }
}

export function Button({
  children,
  onClick,
  variant = "primary",
  size = "md",
  disabled = false,
  loading = false,
  disabledReason,
  iconLeft,
  iconRight,
  fullWidth = false,
  type = "button",
  style,
  "data-testid": testId,
  "aria-label": ariaLabel,
}: ButtonProps): React.JSX.Element {
  const [hover, setHover] = useState(false);
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      title={isDisabled ? disabledReason : undefined}
      data-testid={testId}
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        letterSpacing: "-0.01em",
        whiteSpace: "nowrap",
        cursor: isDisabled ? "not-allowed" : "pointer",
        width: fullWidth ? "100%" : undefined,
        transition: "background .13s, color .13s, border-color .13s, opacity .13s",
        ...SIZES[size],
        // disabled reads as an inert muted control — never as a live button
        ...(isDisabled
          ? {
              background: "var(--surface-2)",
              color: "var(--fg-3)",
              border: "1px solid var(--border)",
              opacity: 0.85,
            }
          : surfaceFor(variant, hover)),
        ...style,
      }}
    >
      {loading ? <Spinner /> : iconLeft}
      {children}
      {!loading ? iconRight : null}
    </button>
  );
}

function Spinner(): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 14,
        height: 14,
        borderRadius: "50%",
        border: "2px solid color-mix(in srgb, currentColor 30%, transparent)",
        borderTopColor: "currentColor",
        animation: "spin .8s linear infinite",
      }}
    />
  );
}

export interface IconButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly title: string;
  readonly "aria-label"?: string;
  readonly href?: string;
  readonly size?: number;
}

// square 1px-bordered icon control (theme toggle, github, copy, etc.)
export function IconButton({
  children,
  onClick,
  title,
  "aria-label": ariaLabel,
  href,
  size = 34,
}: IconButtonProps): React.JSX.Element {
  const shared: CSSProperties = {
    width: size,
    height: size,
    display: "grid",
    placeItems: "center",
    borderRadius: RADIUS.sm,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--fg-2)",
    cursor: "pointer",
    textDecoration: "none",
    flexShrink: 0,
  };
  if (href !== undefined) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        aria-label={ariaLabel ?? title}
        style={shared}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      style={shared}
    >
      {children}
    </button>
  );
}
