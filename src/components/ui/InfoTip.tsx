"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A jargon term with a dotted underline that reveals a short plain-language
// definition on hover, keyboard focus, or tap. Keyboard- and touch-reachable
// (not a bare `title=` tooltip). Use sparingly, only for terms worth a gloss.
//
// The popover is rendered in a portal with fixed positioning so it can't be
// clipped by an ancestor's `overflow: hidden` (e.g. the rounded plan-list card
// on the Review step) or lost behind a stacking context.
export function InfoTip({
  children,
  tip,
}: {
  readonly children: ReactNode;
  readonly tip: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const tipId = useId();

  const show = (): void => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setAnchor({ top: r.top, left: r.left + r.width / 2 });
    }
    setOpen(true);
  };
  const hide = (): void => setOpen(false);

  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>
      <button
        ref={ref}
        type="button"
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        onClick={(e) => {
          // self-contained control: don't let a tip toggle bubble to a parent
          // click handler (e.g. a <summary> that would also collapse a <details>)
          e.preventDefault();
          e.stopPropagation();
          if (open) hide();
          else show();
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
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
      {open && anchor && typeof document !== "undefined"
        ? createPortal(
            <span
              id={tipId}
              role="tooltip"
              style={{
                position: "fixed",
                top: anchor.top - 8,
                left: anchor.left,
                transform: "translate(-50%, -100%)",
                zIndex: 1000,
                width: "max-content",
                maxWidth: 280,
                padding: "9px 12px",
                borderRadius: 9,
                background: "var(--surface)",
                border: "1px solid var(--border-2)",
                boxShadow: "var(--shadow)",
                font: "500 12px/1.5 Geist, sans-serif",
                color: "var(--fg-2)",
                textAlign: "left",
                textDecoration: "none",
                whiteSpace: "normal",
                pointerEvents: "none",
              }}
            >
              {tip}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
