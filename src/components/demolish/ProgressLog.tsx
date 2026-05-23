// live log of DemolishProgressEvents, append order, per-kind icon + color

import type { DemolishProgressEvent } from "@/lib/plan/classic-orchestrator";
import { cn } from "@/lib/utils";

export interface ProgressLogProps {
  readonly events: readonly DemolishProgressEvent[];
  readonly className?: string;
}

export function ProgressLog({ events, className }: ProgressLogProps): React.JSX.Element {
  if (events.length === 0) {
    return (
      <p className={cn("text-sm text-slate-500 italic", className)}>
        No progress yet. Start the demolition to see events here.
      </p>
    );
  }
  return (
    <section
      className={cn(
        "flex max-h-96 flex-col gap-1 overflow-y-auto rounded-md border border-slate-300 bg-slate-50 p-3 text-sm",
        className,
      )}
      aria-live="polite"
      aria-atomic="false"
      aria-label="Demolition progress log"
      data-testid="progress-log"
    >
      <ol className="flex flex-col gap-1">
        {events.map((event, i) => (
          <li
            key={i}
            data-event-kind={event.kind}
            className={cn(
              "flex flex-col rounded-sm border-l-2 bg-white px-2 py-1",
              colorFor(event.kind),
            )}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-wide text-slate-500">
                {labelFor(event.kind)}
                {event.batchIndex !== undefined && event.totalBatches !== undefined
                  ? ` [${event.batchIndex + 1}/${event.totalBatches}]`
                  : ""}
              </span>
              {event.txHash ? (
                <code
                  className="truncate font-mono text-[10px] text-slate-600"
                  title={event.txHash}
                >
                  {truncateHash(event.txHash)}
                </code>
              ) : null}
            </div>
            <span className="text-sm">{event.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function labelFor(kind: DemolishProgressEvent["kind"]): string {
  switch (kind) {
    case "audit":
      return "audit";
    case "batch-built":
      return "batch";
    case "submitting":
      return "submit";
    case "submitted":
      return "ok";
    case "rebatching":
      return "re-audit";
    case "mediator-cosign":
      return "mediator";
    case "complete":
      return "done";
    case "blocked":
      return "blocked";
  }
}

function colorFor(kind: DemolishProgressEvent["kind"]): string {
  switch (kind) {
    case "submitted":
    case "complete":
      return "border-emerald-500";
    case "blocked":
      return "border-red-500";
    case "mediator-cosign":
      return "border-amber-500";
    case "submitting":
    case "rebatching":
      return "border-sky-500";
    case "batch-built":
    case "audit":
    default:
      return "border-slate-400";
  }
}

function truncateHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}
