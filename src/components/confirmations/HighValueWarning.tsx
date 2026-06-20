"use client";

// secondary confirmation modal shown before the typed confirmation when balance > threshold

import { Button, Modal } from "@/components/ui";

export interface HighValueWarningProps {
  // total XLM balance, decimal string
  readonly totalXlm: string;
  // threshold above which this modal renders. defaults to 1000
  readonly threshold?: number;
  // optional usd estimate, rendered as-is
  readonly dollarEstimate?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

const DEFAULT_THRESHOLD_XLM = 1000;

export function HighValueWarning({
  totalXlm,
  threshold = DEFAULT_THRESHOLD_XLM,
  dollarEstimate,
  onConfirm,
  onCancel,
}: HighValueWarningProps): React.JSX.Element {
  return (
    <Modal
      title="High-value account"
      tone="warning"
      onClose={onCancel}
      data-testid="high-value-warning"
      icon={
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="high-value-warning-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} data-testid="high-value-warning-confirm">
            I understand, continue
          </Button>
        </>
      }
    >
      This account holds a significant balance ({threshold} XLM threshold). Once merged, the action
      is irreversible — there is no way to recover the account or reverse the transfer.
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "16px 18px",
          borderRadius: 14,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          marginTop: 16,
        }}
      >
        <span
          data-testid="high-value-warning-xlm"
          style={{
            fontSize: 30,
            fontWeight: 600,
            letterSpacing: "-0.03em",
            fontFamily: "'Geist Mono', monospace",
            color: "var(--fg)",
          }}
        >
          {totalXlm}
        </span>
        <span style={{ fontSize: 15, color: "var(--fg-3)", fontWeight: 500 }}>XLM</span>
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
    </Modal>
  );
}
