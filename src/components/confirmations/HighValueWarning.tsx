"use client";

// secondary confirmation modal shown before the typed confirmation when balance > threshold
// styled to match the dc design (lines 957-975)

import { useEffect, useId, useRef } from "react";

export interface HighValueWarningProps {
  // total XLM balance, decimal string
  readonly totalXlm: string;
  // threshold above which this modal renders. defaults to 1000
  readonly threshold?: number;
  // optional usd estimate, rendered as-is
  readonly dollarEstimate?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly className?: string;
}

const DEFAULT_THRESHOLD_XLM = 1000;

export function HighValueWarning({
  totalXlm,
  threshold = DEFAULT_THRESHOLD_XLM,
  dollarEstimate,
  onConfirm,
  onCancel,
  className,
}: HighValueWarningProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="high-value-warning"
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
          maxWidth: 480,
          background: "var(--surface)",
          border: "1px solid var(--border-2)",
          borderRadius: 20,
          padding: "34px 32px",
          boxShadow: "var(--shadow)",
          animation: "fadeUp .2s both",
        }}
      >
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: 15,
            background: "var(--warning-soft)",
            border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
            display: "grid",
            placeItems: "center",
            marginBottom: 20,
          }}
        >
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--warning)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
        </div>
        <h2
          id={titleId}
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--fg)",
          }}
        >
          High-value account
        </h2>
        <p
          id={descriptionId}
          style={{
            margin: "12px 0 22px",
            fontSize: 14.5,
            lineHeight: 1.6,
            color: "var(--fg-2)",
          }}
        >
          This account holds a significant balance ({threshold} XLM threshold). Once merged, the
          action is irreversible, there is no way to recover the account or reverse the transfer.
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            padding: "18px 20px",
            borderRadius: 14,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            marginBottom: 24,
          }}
        >
          <span
            data-testid="high-value-warning-xlm"
            style={{
              fontSize: 32,
              fontWeight: 600,
              letterSpacing: "-0.03em",
              fontFamily: "'Geist Mono', monospace",
              color: "var(--fg)",
            }}
          >
            {totalXlm}
          </span>
          <span style={{ fontSize: 16, color: "var(--fg-3)", fontWeight: 500 }}>XLM</span>
          {dollarEstimate !== undefined ? (
            <span
              data-testid="high-value-warning-usd"
              style={{
                marginLeft: "auto",
                fontSize: 13,
                color: "var(--fg-3)",
                fontFamily: "'Geist Mono', monospace",
              }}
            >
              ≈ {dollarEstimate}
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 11 }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            data-testid="high-value-warning-cancel"
            style={{
              flex: 1,
              padding: 13,
              borderRadius: 11,
              border: "1px solid var(--border-2)",
              background: "var(--surface)",
              color: "var(--fg)",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="high-value-warning-confirm"
            style={{
              flex: 1,
              padding: 13,
              borderRadius: 11,
              border: "none",
              background: "var(--warning)",
              color: "var(--accent-fg)",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            I understand, continue
          </button>
        </div>
      </div>
    </div>
  );
}
