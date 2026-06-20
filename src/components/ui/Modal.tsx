"use client";

import { useEffect, type ReactNode } from "react";
import { RADIUS, TONE_FG, TONE_SOFT, type Tone } from "./tokens";

// Centered dialog over a scrim. Esc closes; focus-trap is intentionally light
// (these are short, deliberate-friction dialogs). Never uses window.confirm.
export function Modal({
  title,
  tone = "neutral",
  icon,
  children,
  footer,
  onClose,
  "data-testid": testId,
  closeLabel = "Close",
}: {
  readonly title: ReactNode;
  readonly tone?: Tone;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose?: () => void;
  readonly "data-testid"?: string;
  readonly closeLabel?: string;
}): React.JSX.Element {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid={testId}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "grid",
        placeItems: "center",
        padding: 20,
        background: "color-mix(in srgb, var(--bg) 62%, rgba(0,0,0,0.55))",
        backdropFilter: "blur(4px)",
        animation: "fadeIn .14s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 100%)",
          background: "var(--surface)",
          border: "1px solid var(--border-2)",
          borderRadius: RADIUS.xl,
          boxShadow: "var(--shadow)",
          padding: 24,
          animation: "pop .18s cubic-bezier(0.4,0,0.2,1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          {icon ? (
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: RADIUS.md,
                background: TONE_SOFT[tone],
                color: TONE_FG[tone],
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              {icon}
            </span>
          ) : null}
          <h2
            style={{ margin: 0, flex: 1, fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em" }}
          >
            {title}
          </h2>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--fg-3)",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                padding: 2,
              }}
            >
              ×
            </button>
          ) : null}
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--fg-2)" }}>{children}</div>
        {footer ? (
          <div style={{ display: "flex", gap: 10, marginTop: 22, justifyContent: "flex-end" }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
