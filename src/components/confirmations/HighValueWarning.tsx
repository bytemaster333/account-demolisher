"use client";

// secondary confirmation modal shown before the typed confirmation when balance > threshold

import { useEffect, useId, useRef } from "react";

import { cn } from "@/lib/utils";

export interface HighValueWarningProps {
  // total XLM balance, decimal string
  readonly totalXlm: string;
  // threshold above which this modal renders. defaults to 1000.
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
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4",
        className,
      )}
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-amber-400 bg-white p-6 shadow-xl">
        <h2 id={titleId} className="text-lg font-semibold text-amber-900">
          High-value account
        </h2>
        <p id={descriptionId} className="text-sm text-slate-700">
          This account holds more than{" "}
          <span className="font-mono font-semibold">{threshold} XLM</span>. Demolition is
          irreversible. Double-check the destination address before continuing.
        </p>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md bg-amber-50 px-3 py-2 text-sm">
          <dt className="text-xs uppercase tracking-wide text-amber-900">Total XLM</dt>
          <dd
            data-testid="high-value-warning-xlm"
            className="text-right font-mono text-sm font-semibold text-amber-900"
          >
            {totalXlm} XLM
          </dd>
          {dollarEstimate !== undefined ? (
            <>
              <dt className="text-xs uppercase tracking-wide text-amber-900">USD estimate</dt>
              <dd
                data-testid="high-value-warning-usd"
                className="text-right font-mono text-sm font-semibold text-amber-900"
              >
                {dollarEstimate}
              </dd>
            </>
          ) : null}
        </dl>

        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            data-testid="high-value-warning-cancel"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="high-value-warning-confirm"
            className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-900"
          >
            I understand, continue
          </button>
        </div>
      </div>
    </div>
  );
}
