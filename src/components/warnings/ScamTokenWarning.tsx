"use client";

// surfaces tokens flagged by scam heuristics. informational only — the typed confirmation is the safety net

import { useEffect, useId, useRef } from "react";

import { cn } from "@/lib/utils";

export type ScamHeuristicKind = "lookalike" | "low-liquidity" | "unsolicited-allowance" | "other";

export interface ScamTokenFinding {
  readonly assetCode: string;
  readonly issuer: string;
  readonly heuristic: ScamHeuristicKind;
  readonly detail: string;
}

export interface ScamTokenWarningProps {
  readonly findings: readonly ScamTokenFinding[];
  readonly onAcknowledge: () => void;
  readonly onCancel: () => void;
  readonly className?: string;
}

const HEURISTIC_LABEL: Record<ScamHeuristicKind, string> = {
  lookalike: "Look-alike symbol",
  "low-liquidity": "Low liquidity",
  "unsolicited-allowance": "Unsolicited allowance",
  other: "Other",
};

export function ScamTokenWarning({
  findings,
  onAcknowledge,
  onCancel,
  className,
}: ScamTokenWarningProps): React.JSX.Element {
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
      data-testid="scam-token-warning"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4",
        className,
      )}
    >
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-lg border border-red-500 bg-white p-6 shadow-xl">
        <h2 id={titleId} className="text-lg font-semibold text-red-900">
          Suspicious tokens detected
        </h2>
        <p id={descriptionId} className="text-sm text-slate-700">
          The following tokens triggered Account Demolisher&apos;s scam heuristics. Review them
          before proceeding. Demolition will still attempt to revoke trustlines and allowances on
          these tokens.
        </p>
        <ul
          data-testid="scam-token-warning-list"
          className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md border border-red-200 bg-red-50 p-3 text-xs"
        >
          {findings.length === 0 ? (
            <li className="text-slate-600">No findings.</li>
          ) : (
            findings.map((f, i) => (
              <li
                key={`${f.assetCode}-${f.issuer}-${i}`}
                className="flex flex-col gap-0.5"
                data-testid="scam-token-warning-item"
              >
                <span className="font-mono font-semibold text-red-900">
                  {f.assetCode}:{f.issuer.slice(0, 8)}…
                </span>
                <span className="text-slate-800">
                  <span className="inline-block rounded bg-red-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-900">
                    {HEURISTIC_LABEL[f.heuristic]}
                  </span>{" "}
                  — {f.detail}
                </span>
              </li>
            ))
          )}
        </ul>

        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            data-testid="scam-token-warning-cancel"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onAcknowledge}
            data-testid="scam-token-warning-acknowledge"
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-900"
          >
            I understand, continue
          </button>
        </div>
      </div>
    </div>
  );
}
