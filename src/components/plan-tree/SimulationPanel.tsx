// read-only viewer for PlanNode.simulated. soroban shows fee/ledger/auth, classic shows ops/fee/xdr

import { type ReactElement } from "react";

import type { SimulationOutcome } from "@/lib/plan/tree";
import { cn } from "@/lib/utils";

export interface SimulationPanelProps {
  readonly outcome: SimulationOutcome | undefined;
  readonly className?: string;
}

export function SimulationPanel({ outcome, className }: SimulationPanelProps): ReactElement {
  if (!outcome) {
    return (
      <p
        className={cn("text-xs italic text-slate-500", className)}
        data-testid="simulation-panel-empty"
      >
        Not yet simulated.
      </p>
    );
  }

  if (outcome.kind === "soroban") {
    const xdrPreview = previewTransactionData(outcome.transactionData);
    return (
      <section
        className={cn(
          "flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs",
          className,
        )}
        aria-label="Soroban simulation result"
        data-testid="simulation-panel-soroban"
      >
        <h4 className="text-sm font-semibold">Soroban simulation</h4>
        <dl className="grid grid-cols-2 gap-1 font-mono">
          <dt className="text-slate-600">min resource fee</dt>
          <dd>{outcome.minResourceFee}</dd>
          <dt className="text-slate-600">latest ledger</dt>
          <dd>{outcome.latestLedger}</dd>
          <dt className="text-slate-600">auth entries</dt>
          <dd>{outcome.auth.length}</dd>
          <dt className="text-slate-600">restore required</dt>
          <dd>{outcome.restorePreambleRequired ? "yes" : "no"}</dd>
        </dl>
        {outcome.retval ? (
          <details>
            <summary className="cursor-pointer text-slate-700">return value (ScVal)</summary>
            <pre className="mt-1 max-h-32 overflow-auto break-all rounded bg-white p-2 font-mono text-[10px]">
              {safeRender(() => outcome.retval?.toXDR("base64") ?? "")}
            </pre>
          </details>
        ) : null}
        {xdrPreview !== null ? (
          <details>
            <summary className="cursor-pointer text-slate-700">footprint XDR</summary>
            <pre className="mt-1 max-h-32 overflow-auto break-all rounded bg-white p-2 font-mono text-[10px]">
              {xdrPreview}
            </pre>
          </details>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs",
        className,
      )}
      aria-label="Classic transaction well-formedness result"
      data-testid="simulation-panel-classic"
    >
      <h4 className="text-sm font-semibold">Classic envelope</h4>
      <dl className="grid grid-cols-2 gap-1 font-mono">
        <dt className="text-slate-600">operations</dt>
        <dd>{outcome.operationCount}</dd>
        <dt className="text-slate-600">estimated fee</dt>
        <dd>{outcome.estimatedFee}</dd>
      </dl>
      {outcome.xdr ? (
        <details>
          <summary className="cursor-pointer text-slate-700">envelope XDR</summary>
          <pre className="mt-1 max-h-32 overflow-auto break-all rounded bg-white p-2 font-mono text-[10px]">
            {outcome.xdr}
          </pre>
        </details>
      ) : (
        <p className="text-[11px] text-slate-500">envelope built at submit time</p>
      )}
    </section>
  );
}

function previewTransactionData(data: unknown): string | null {
  if (data === null || data === undefined) return null;
  // SorobanTransactionData has a toXDR("base64") method
  if (typeof (data as { toXDR?: (s: string) => string }).toXDR === "function") {
    try {
      return (data as { toXDR: (s: string) => string }).toXDR("base64");
    } catch {
      return null;
    }
  }
  return null;
}

function safeRender(fn: () => string): string {
  try {
    return fn();
  } catch (err) {
    return err instanceof Error ? `<render error: ${err.message}>` : "<render error>";
  }
}
