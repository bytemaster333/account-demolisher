// numbered render of every BlendExitStep. each step is one soroban tx

import type { BlendExitStep, BlendStepStatus } from "@/lib/adapters/blend/types";
import { cn } from "@/lib/utils";

export interface BlendPlanListProps {
  readonly steps: readonly BlendExitStep[];
  // same shape as PlanList's statusByBatchIndex, one entry per step
  readonly statusByStepIndex?: readonly BlendStepStatus[];
  readonly className?: string;
}

export function BlendPlanList({
  steps,
  statusByStepIndex,
  className,
}: BlendPlanListProps): React.JSX.Element {
  if (steps.length === 0) {
    return (
      <p className={cn("text-sm text-slate-600", className)} data-testid="blend-plan-empty">
        No Blend positions to unwind.
      </p>
    );
  }

  return (
    <section
      className={cn("flex flex-col gap-3", className)}
      aria-labelledby="blend-plan-list-heading"
      data-testid="blend-plan-list"
    >
      <h2 id="blend-plan-list-heading" className="text-base font-semibold">
        Blend unwind ({steps.length} {steps.length === 1 ? "transaction" : "transactions"})
      </h2>
      <ol className="flex flex-col gap-2">
        {steps.map((step, idx) => {
          const status: BlendStepStatus = statusByStepIndex?.[idx] ?? "pending";
          return (
            <li
              key={idx}
              className={cn(
                "rounded-md border p-3",
                status === "done" && "border-emerald-400 bg-emerald-50",
                status === "failed" && "border-red-400 bg-red-50",
                status === "active" && "border-slate-500 bg-slate-50",
                status === "pending" && "border-slate-200 bg-white",
              )}
              data-testid={`blend-step-${String(idx)}`}
              data-status={status}
              data-kind={step.kind}
            >
              <header className="mb-1 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  <span aria-hidden="true" className="mr-2 font-mono">
                    {indicatorFor(status)}
                  </span>
                  Step {idx + 1}
                </h3>
                <span className="rounded-sm bg-slate-200 px-1 py-0.5 font-mono text-[10px] uppercase">
                  {labelForKind(step.kind)}
                </span>
              </header>
              <p className="font-mono text-xs">{describeStep(step)}</p>
              {step.kind === "backstop_queue_withdraw" ? (
                <p
                  className="mt-1 text-[11px] text-amber-800"
                  data-testid={`blend-step-${String(idx)}-warning`}
                >
                  Backstop unwind requires returning after the 17-day queue closes. This tool will
                  not attempt to complete the withdrawal in the current session.
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// per-step human description
function describeStep(step: BlendExitStep): string {
  const poolLabel = poolDisplayName(step.pool);
  switch (step.kind) {
    case "repay":
      return `Repay ${step.amount} ${step.asset.code} on pool ${poolLabel}`;
    case "withdraw_collateral":
      return `Withdraw ${step.amount} ${step.asset.code} collateral from pool ${poolLabel}`;
    case "withdraw_supply":
      return `Withdraw ${step.amount} ${step.asset.code} supply from pool ${poolLabel}`;
    case "claim_emissions":
      return `Claim ${step.rewardAsset.code} emissions on pool ${poolLabel}`;
    case "backstop_queue_withdraw":
      return `Initiate Blend backstop withdrawal — completes ${step.queueEndDate}`;
  }
}

function labelForKind(kind: BlendExitStep["kind"]): string {
  switch (kind) {
    case "repay":
      return "Repay";
    case "withdraw_collateral":
      return "Withdraw Coll.";
    case "withdraw_supply":
      return "Withdraw Supply";
    case "claim_emissions":
      return "Claim";
    case "backstop_queue_withdraw":
      return "Backstop Queue";
  }
}

// pool name from registry, else a c...XXXX truncation of the contract id
function poolDisplayName(pool: { readonly id: string; readonly name: string }): string {
  const trimmed = pool.name.trim();
  if (trimmed.length > 0) return trimmed;
  if (pool.id.length <= 11) return pool.id;
  return `${pool.id.slice(0, 6)}...${pool.id.slice(-4)}`;
}

function indicatorFor(status: BlendStepStatus): string {
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
