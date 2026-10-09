"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// a jargon term with a dotted underline that reveals a short plain-language
// definition on mouse hover, keyboard focus, or tap. Escape dismisses it.
//
// the popover is portalled with fixed positioning so an ancestor's overflow
// can't clip it; while open it re-anchors on scroll and resize so it stays on
// its term.
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
  // set by a pointer press on the term until its click (or blur). a tap focuses
  // the button before the click arrives, so a focus that opened the tip would
  // let the click close it straight away; only keyboard focus opens it.
  const pressedRef = useRef(false);
  // a press dragged off the term before release fires no click, and safari on
  // macos doesn't focus a button on press, so no blur follows either. any key
  // or a press anywhere else ends the press instead, so a later tab focus opens
  // the tip.
  const stopWatchingRef = useRef<(() => void) | null>(null);
  const endPress = useCallback((): void => {
    pressedRef.current = false;
    stopWatchingRef.current?.();
    stopWatchingRef.current = null;
  }, []);
  const startPress = (): void => {
    pressedRef.current = true;
    if (stopWatchingRef.current !== null) return;
    const onKey = (): void => endPress();
    const onPointer = (e: PointerEvent): void => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      endPress();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    stopWatchingRef.current = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  };
  useEffect(() => endPress, [endPress]);
  const tipId = useId();

  const place = useCallback((): void => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setAnchor({ top: r.top, left: r.left + r.width / 2 });
    }
  }, []);
  const show = (): void => {
    place();
    setOpen(true);
  };
  const hide = (): void => setOpen(false);

  useEffect(() => {
    if (!open) return;
    // capture phase, and the event stops here: inside a dialog that also closes
    // on Escape, the first press dismisses only the tip
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    // capture, so scrolling any scroll container moves the tip too
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

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
          endPress();
          if (open) hide();
          else show();
        }}
        onPointerDown={startPress}
        onPointerCancel={endPress}
        // hover is mouse-only: on touch, a synthetic enter before the click
        // would open the tip and the click would immediately close it again
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") show();
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") hide();
        }}
        onFocus={() => {
          if (!pressedRef.current) show();
        }}
        onBlur={() => {
          endPress();
          hide();
        }}
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
