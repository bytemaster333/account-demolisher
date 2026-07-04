"use client";

import { useId, useState, type ReactNode } from "react";

// A jargon term with a dotted underline that reveals a short plain-language
// definition on hover, keyboard focus, or tap. Use it to keep sentences short
// instead of spelling every term out inline. Keyboard- and touch-reachable
// (not a bare `title=` tooltip). Use sparingly, only for the terms worth a gloss.
export function InfoTip({
  children,
  tip,
}: {
  readonly children: ReactNode;
  readonly tip: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const tipId = useId();

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{
          font: "inherit",
          color: "inherit",
          background: "none",
          border: "none",
          padding: 0,
          margin: 0,
          cursor: "help",
          textDecoration: "underline dotted",
          textUnderlineOffset: 2,
          textDecorationColor: "var(--fg-3)",
        }}
      >
        {children}
      </button>
      {open ? (
        <span
          id={tipId}
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 40,
            width: "max-content",
            maxWidth: 260,
            padding: "9px 11px",
            borderRadius: 9,
            background: "var(--surface)",
            border: "1px solid var(--border-2)",
            boxShadow: "var(--shadow-sm)",
            font: "500 12px/1.5 Geist, sans-serif",
            color: "var(--fg-2)",
            textAlign: "left",
            textDecoration: "none",
            whiteSpace: "normal",
            pointerEvents: "none",
          }}
        >
          {tip}
        </span>
      ) : null}
    </span>
  );
}
