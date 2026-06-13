// numbered render of every BatchedOperation grouped by batch. one batch = one stellar tx

import type { ClassicBatch } from "@/lib/types/plan";
import { cn } from "@/lib/utils";

export type BatchStatus = "pending" | "active" | "done" | "failed";

export interface PlanListProps {
  readonly batches: readonly ClassicBatch[];
  readonly statusByBatchIndex?: readonly BatchStatus[];
  readonly className?: string;
}

export function PlanList({
  batches,
  statusByBatchIndex,
  className,
}: PlanListProps): React.JSX.Element {
  if (batches.length === 0) {
    return <p className={cn("text-sm text-slate-600", className)}>No operations in the plan.</p>;
  }

  return (
    <section className={cn("flex flex-col gap-3", className)} aria-labelledby="plan-list-heading">
      <h2 id="plan-list-heading" className="text-base font-semibold">
        Plan ({batches.length} {batches.length === 1 ? "transaction" : "transactions"})
      </h2>
      <ol className="flex flex-col gap-3">
        {batches.map((batch, batchIdx) => {
          const status = statusByBatchIndex?.[batchIdx] ?? "pending";
          return (
            <li
              key={batchIdx}
              className={cn(
                "rounded-md border p-3",
                status === "done" && "border-emerald-400 bg-emerald-50",
                status === "failed" && "border-red-400 bg-red-50",
                status === "active" && "border-slate-500 bg-slate-50",
                status === "pending" && "border-slate-200 bg-white",
              )}
              data-testid={`plan-batch-${String(batchIdx)}`}
              data-status={status}
            >
              <header className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  <span aria-hidden="true" className="mr-2 font-mono">
                    {indicatorFor(status)}
                  </span>
                  Batch {batchIdx + 1}
                </h3>
                <span className="text-xs text-slate-600">
                  {batch.operations.length} {batch.operations.length === 1 ? "op" : "ops"}
                  {batch.mediator ? " · mediator" : ""}
                  {batch.memo ? ` · memo: ${batch.memo.type}` : ""}
                </span>
              </header>
              <ol className="ml-6 list-decimal space-y-1 text-sm">
                {batch.operations.map((op, opIdx) => (
                  <li key={opIdx} className="font-mono text-xs">
                    <span className="rounded-sm bg-slate-200 px-1 py-0.5 text-[10px] uppercase">
                      {op.kind}
                    </span>{" "}
                    <span>{op.summary}</span>
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function indicatorFor(status: BatchStatus): string {
  switch (status) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "active":
    case "pending":
      return "▸";
  }
}
