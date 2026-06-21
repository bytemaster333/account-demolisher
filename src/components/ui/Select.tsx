"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { RADIUS } from "./tokens";

export interface SelectOption {
  readonly value: string;
  readonly label: ReactNode;
}

// Themed dropdown. Replaces native <select> whose open menu renders with the
// OS's own (light/blue) styling that ignores the app theme. This one is a button
// + a custom dark menu, fully theme-driven.
export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
  minWidth,
  "data-testid": testId,
}: {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly ariaLabel?: string;
  readonly size?: "sm" | "md";
  readonly minWidth?: number;
  readonly "data-testid"?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0];
  const trigger: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    width: "100%",
    minWidth,
    height: size === "sm" ? 34 : 44,
    padding: size === "sm" ? "0 10px" : "0 13px",
    borderRadius: RADIUS.md,
    border: `1px solid ${open ? "var(--fg-3)" : "var(--border-2)"}`,
    background: "transparent",
    color: "var(--fg)",
    font: `500 ${size === "sm" ? 13 : 14}px/1 Geist, sans-serif`,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  return (
    <div ref={ref} style={{ position: "relative" }} data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        style={trigger}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{current?.label}</span>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--fg-3)"
          strokeWidth={2.2}
          strokeLinecap="round"
          aria-hidden
          style={{
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform .12s",
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: "100%",
            zIndex: 60,
            padding: 5,
            borderRadius: RADIUS.md,
            background: "var(--surface)",
            border: "1px solid var(--border-2)",
            boxShadow: "var(--shadow)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            animation: "fadeUp .12s ease",
          }}
        >
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                data-value={o.value}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: RADIUS.sm,
                  border: "none",
                  background: "transparent",
                  color: selected ? "var(--accent)" : "var(--fg)",
                  font: "500 13px/1 Geist, sans-serif",
                  cursor: "pointer",
                  textAlign: "left",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span>{o.label}</span>
                {selected ? (
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
