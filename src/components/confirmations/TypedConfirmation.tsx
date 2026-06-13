"use client";

// destructive-action confirmation

import { useEffect, useId, useRef, useState } from "react";

export interface TypedConfirmationProps {
  // full destination g-address; the last 4 chars are the required confirmation string
  readonly destination: string;
  // delay before confirm enables. defaults to 5000ms
  readonly delayMs?: number;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly className?: string;
}

const DEFAULT_DELAY_MS = 5000;
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  const required = destination.slice(-4);
  const destHead = destination.length > 4 ? destination.slice(0, -4) : "";
  const destTail = destination.length > 0 ? destination.slice(-4) : "";

  const [typed, setTyped] = useState("");
  // elapsed ms since mount, capped at delayMs. used both for the bar fill and the unlock gate
  const [elapsedMs, setElapsedMs] = useState(delayMs <= 0 ? delayMs : 0);

  useEffect(() => {
    inputRef.current?.focus();
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
  const timerPct = delayMs > 0 ? Math.min(100, (elapsedMs / delayMs) * 100) : 100;
  const timerLeft = Math.max(0, Math.ceil((delayMs - elapsedMs) / 1000));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="typed-confirmation"
      className={className}
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
            Confirm demolition
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
        <p style={{ margin: "0 0 8px", fontSize: 13.5, color: "var(--fg-2)" }}>
          Funds will be merged to this destination:
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
            style={{
              color: "var(--accent)",
              background: "var(--accent-soft)",
              padding: "1px 3px",
              borderRadius: 4,
              fontWeight: 600,
            }}
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
          Type the last 4 characters to confirm
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          maxLength={4}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder="••••"
          aria-invalid={typed.length === 4 && !matches}
          data-testid="typed-confirmation-input"
          style={{
            width: "100%",
            padding: "14px 16px",
            borderRadius: 12,
            border: "1px solid var(--border-2)",
            background: "var(--surface-2)",
            color: "var(--fg)",
            font: "600 18px/1 'Geist Mono', monospace",
            letterSpacing: "0.3em",
            textAlign: "center",
            boxSizing: "border-box",
          }}
        />
        {canConfirm ? (
          <button
            type="button"
            onClick={onConfirm}
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
              border: "none",
              background: "var(--danger)",
              color: "var(--accent-fg)",
              fontWeight: 600,
              fontSize: 15,
              cursor: "pointer",
              boxShadow: "0 6px 20px var(--danger-soft)",
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
            Demolish account
          </button>
        ) : (
          <div
            data-testid="typed-confirmation-status"
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
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${timerPct}%`,
                background: "var(--accent-soft)",
                transition: "width .1s linear",
              }}
            />
            <div
              aria-live="polite"
              style={{
                position: "relative",
                textAlign: "center",
                fontWeight: 600,
                fontSize: 14,
                color: delayElapsed ? "var(--fg-3)" : "var(--fg-2)",
              }}
            >
              {!delayElapsed
                ? `Hold on, confirm unlocks in ${timerLeft}s`
                : "Enter the last 4 characters above"}
            </div>
          </div>
        )}
        <p
          style={{
            margin: "12px 0 0",
            fontSize: 11.5,
            color: "var(--fg-3)",
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          This is irreversible. The delay and re-typing are intentional friction.
        </p>
      </div>
    </div>
  );
}
