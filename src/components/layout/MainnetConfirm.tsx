"use client";

// Deliberate gate before switching from Testnet to Mainnet. Account Demolisher
// is a destructive tool, so moving onto the live network — where a merge is
// permanent and irreversible — should never be a stray dropdown click. Matches
// the destructive-action dialog language used by TypedConfirmation (same
// overlay, panel, danger CTA, Escape/backdrop cancel, focus trap).

import { useEffect, useId, useRef } from "react";

export interface MainnetConfirmProps {
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function MainnetConfirm({ onConfirm, onCancel }: MainnetConfirmProps): React.JSX.Element {
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // focus the primary action on open; restore focus to the switcher on close
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, []);

  // Escape cancels (stays on the safer network)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // trap Tab focus inside the dialog
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="mainnet-confirm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "var(--overlay)",
        backdropFilter: "blur(4px)",
        display: "grid",
        placeItems: "center",
        padding: 20,
        animation: "fadeIn .15s both",
      }}
    >
      <div
        ref={panelRef}
        style={{
          width: "100%",
          maxWidth: 440,
          background: "var(--surface)",
          border: "1px solid var(--border-2)",
          borderRadius: 20,
          padding: 28,
          boxShadow: "var(--shadow)",
          animation: "fadeUp .2s both",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 16 }}>
          <span
            aria-hidden
            style={{
              width: 38,
              height: 38,
              flexShrink: 0,
              display: "grid",
              placeItems: "center",
              borderRadius: 11,
              background: "var(--danger-soft)",
              border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
            }}
          >
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--danger)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            </svg>
          </span>
          <h2
            id={titleId}
            style={{
              margin: 0,
              fontSize: 19,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: "var(--fg)",
            }}
          >
            Switch to Mainnet?
          </h2>
        </div>

        <p
          style={{
            margin: "0 0 10px",
            fontSize: 14,
            fontWeight: 600,
            lineHeight: 1.5,
            color: "var(--fg)",
          }}
        >
          You&apos;re leaving Testnet. On Mainnet, every action moves{" "}
          <span style={{ color: "var(--danger)" }}>real funds</span> and is permanent.
        </p>
        <p
          id={bodyId}
          style={{ margin: "0 0 22px", fontSize: 13.5, lineHeight: 1.6, color: "var(--fg-2)" }}
        >
          Account Demolisher closes accounts by merging them away. A mainnet merge cannot be undone,
          reversed, or recovered by anyone — including us. Only continue if you mean to operate on
          real balances.
        </p>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            data-testid="mainnet-confirm-cancel"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 11,
              border: "1px solid var(--border-2)",
              background: "transparent",
              color: "var(--fg)",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Stay on Testnet
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            data-testid="mainnet-confirm-confirm"
            style={{
              flex: 1,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              borderRadius: 11,
              border: "1px solid color-mix(in srgb, var(--danger) 55%, transparent)",
              background: "transparent",
              color: "var(--danger)",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            <span
              aria-hidden
              style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--danger)" }}
            />
            Switch to Mainnet
          </button>
        </div>
      </div>
    </div>
  );
}
