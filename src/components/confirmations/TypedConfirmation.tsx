"use client";

// destructive-action confirmation dialog: the final gate before a demolition.
// Opened from the Review step's "Demolish account" button. Requires an unlock
// delay to elapse AND the last 4 characters of the destination to be re-typed,
// so the merge is never one careless click away.

import { useEffect, useId, useRef, useState } from "react";

export interface TypedConfirmationProps {
  // full destination g-address; the last 4 chars are the required confirmation string
  readonly destination: string;
  // delay before confirm enables. defaults to 4000ms
  readonly delayMs?: number;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly className?: string;
}

const DEFAULT_DELAY_MS = 4000;
const TICK_MS = 100;

export function TypedConfirmation({
  destination,
  delayMs = DEFAULT_DELAY_MS,
  onConfirm,
  onCancel,
  className,
}: TypedConfirmationProps): React.JSX.Element {
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const statusId = useId();
  const tailId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const required = destination.slice(-4);
  const destHead = destination.length > 4 ? destination.slice(0, -4) : "";
  const destTail = destination.length > 0 ? destination.slice(-4) : "";

  const [typed, setTyped] = useState("");
  // elapsed ms since mount, capped at delayMs. used both for the bar fill and the unlock gate
  const [elapsedMs, setElapsedMs] = useState(delayMs <= 0 ? delayMs : 0);

  useEffect(() => {
    // remember what had focus so we can restore it after the dialog closes
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, []);

  // close on Escape for keyboard users
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // trap Tab focus inside the dialog so keyboard users can't tab into the page behind it
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

  useEffect(() => {
    if (delayMs <= 0) return;
    const start = Date.now();
    const handle = setInterval(() => {
      const next = Math.min(delayMs, Date.now() - start);
      setElapsedMs(next);
      if (next >= delayMs) clearInterval(handle);
    }, TICK_MS);
    return () => clearInterval(handle);
  }, [delayMs]);

  const delayElapsed = elapsedMs >= delayMs;
  const matches = typed === required && required.length > 0;
  const canConfirm = matches && delayElapsed;
  // only flag a mismatch once the user has typed the full 4 characters
  const showMismatch = typed.length === 4 && !matches;
  const timerPct = delayMs > 0 ? Math.min(100, (elapsedMs / delayMs) * 100) : 100;
  const timerLeft = Math.max(0, Math.ceil((delayMs - elapsedMs) / 1000));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="typed-confirmation"
      className={className}
      onClick={(e) => {
        // click on the backdrop (not the panel) cancels
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(0,0,0,0.55)",
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
          maxWidth: 460,
          background: "var(--surface)",
          border: "1px solid var(--border-2)",
          borderRadius: 20,
          padding: 30,
          boxShadow: "var(--shadow)",
          animation: "fadeUp .2s both",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 18,
          }}
        >
          <h2
            id={titleId}
            style={{
              margin: 0,
              fontSize: 21,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: "var(--fg)",
            }}
          >
            Confirm closing your account
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            data-testid="typed-confirmation-cancel"
            style={{
              width: 30,
              height: 30,
              display: "grid",
              placeItems: "center",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--fg-3)",
              cursor: "pointer",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: 14.5,
            fontWeight: 600,
            lineHeight: 1.5,
            color: "var(--fg)",
          }}
        >
          This permanently closes your account and sends all its funds to the address below. It
          cannot be undone.
        </p>
        <p style={{ margin: "0 0 8px", fontSize: 13.5, color: "var(--fg-2)" }}>
          All XLM in your account will be sent to this address, and the account will be permanently
          closed:
        </p>
        <div
          style={{
            padding: "14px 16px",
            borderRadius: 12,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            font: "500 13px/1.5 'Geist Mono', monospace",
            wordBreak: "break-all",
            marginBottom: 20,
          }}
        >
          <span style={{ color: "var(--fg-2)" }}>{destHead || "(empty)"}</span>
          <span
            id={tailId}
            style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "underline" }}
          >
            {destTail}
          </span>
        </div>
        <label
          htmlFor={inputId}
          style={{
            display: "block",
            fontWeight: 600,
            fontSize: 13,
            marginBottom: 9,
            color: "var(--fg)",
          }}
        >
          Type the last 4 characters of the destination address (underlined above) to confirm.
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canConfirm) onConfirm();
          }}
          maxLength={4}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder={required || "ABCD"}
          aria-invalid={showMismatch}
          aria-describedby={
            [showMismatch ? errorId : null, !delayElapsed ? statusId : null]
              .filter(Boolean)
              .join(" ") || undefined
          }
          data-testid="typed-confirmation-input"
          style={{
            width: "100%",
            padding: "14px 16px",
            borderRadius: 12,
            border: `1px solid ${showMismatch ? "var(--danger)" : "var(--border-2)"}`,
            background: "var(--surface-2)",
            color: "var(--fg)",
            font: "600 18px/1 'Geist Mono', monospace",
            letterSpacing: "0.3em",
            textAlign: "center",
            boxSizing: "border-box",
          }}
        />
        {showMismatch ? (
          <div
            id={errorId}
            role="alert"
            data-testid="typed-confirmation-error"
            style={{
              marginTop: 8,
              fontSize: 12.5,
              fontWeight: 500,
              color: "var(--danger)",
            }}
          >
            These don&apos;t match the last 4 characters above.
          </div>
        ) : null}
        {!delayElapsed ? (
          <div
            id={statusId}
            data-testid="typed-confirmation-status"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={Math.ceil(delayMs / 1000)}
            aria-valuenow={Math.ceil(delayMs / 1000) - timerLeft}
            aria-valuetext={`Confirm unlocks in ${timerLeft} seconds`}
            style={{
              position: "relative",
              marginTop: 18,
              width: "100%",
              padding: 15,
              borderRadius: 12,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              overflow: "hidden",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${timerPct}%`,
                background: "var(--surface-3)",
                transition: "width .1s linear",
              }}
            />
            <div
              style={{
                position: "relative",
                textAlign: "center",
                fontWeight: 600,
                fontSize: 14,
                color: "var(--fg-2)",
              }}
            >
              Take a moment to be sure. Confirm unlocks in {timerLeft}s.
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            aria-disabled={!canConfirm}
            data-testid="typed-confirmation-confirm"
            style={{
              marginTop: 18,
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 9,
              padding: 15,
              borderRadius: 12,
              border: "1px solid color-mix(in srgb, var(--danger) 55%, transparent)",
              background: "transparent",
              color: "var(--danger)",
              fontWeight: 600,
              fontSize: 15,
              cursor: canConfirm ? "pointer" : "not-allowed",
              opacity: canConfirm ? 1 : 0.5,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Close account
          </button>
        )}
        {delayElapsed && !matches ? (
          <div
            aria-live="polite"
            style={{
              margin: "8px 0 0",
              textAlign: "center",
              fontWeight: 500,
              fontSize: 13,
              color: "var(--fg-2)",
            }}
          >
            Enter the last 4 characters above to enable this button.
          </div>
        ) : null}
      </div>
    </div>
  );
}
