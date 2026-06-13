// gantt-style timeline rendering of the plan tree. flat list in topological order

import { useMemo, useState, type ReactElement } from "react";

import { topologicalOrder, type PlanNodeStatus, type PlanTree } from "@/lib/plan/tree";
import { cn } from "@/lib/utils";

import { PlanStep } from "./PlanStep";

const STATUS_LEGEND: ReadonlyArray<{ status: PlanNodeStatus; icon: string; label: string }> = [
  { status: "pending", icon: "▸", label: "pending" },
  { status: "simulated", icon: "◇", label: "simulated" },
  { status: "signed", icon: "✎", label: "signed" },
  { status: "submitted", icon: "▴", label: "submitted" },
  { status: "confirmed", icon: "✓", label: "confirmed" },
  { status: "failed", icon: "✗", label: "failed" },
  { status: "skipped", icon: "◌", label: "skipped" },
];

export interface PlanTreeProps {
  readonly tree: PlanTree | null;
  readonly className?: string;
  // shown when the tree is null
  readonly placeholder?: string;
}

export function PlanTree({
  tree,
  className,
  placeholder = "Run preview to generate the plan tree.",
}: PlanTreeProps): ReactElement {
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({});

  const nodes = useMemo(() => (tree ? topologicalOrder(tree) : []), [tree]);

  if (!tree || nodes.length === 0) {
    return (
      <p className={cn("text-sm italic text-slate-500", className)} data-testid="plan-tree-empty">
        {placeholder}
      </p>
    );
  }

  return (
    <section
      className={cn("flex flex-col gap-3", className)}
      aria-labelledby="plan-tree-heading"
      data-testid="plan-tree"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="plan-tree-heading" className="text-base font-semibold">
          Plan tree ({nodes.length} {nodes.length === 1 ? "step" : "steps"})
        </h2>
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
          {STATUS_LEGEND.map((l) => (
            <li key={l.status} className="flex items-center gap-1 font-mono">
              <span aria-hidden="true">{l.icon}</span>
              <span>{l.label}</span>
            </li>
          ))}
        </ul>
      </header>

      <ol className="flex flex-col gap-2">
        {nodes.map((node) => (
          <PlanStep
            key={node.id}
            node={node}
            expanded={Boolean(expanded[node.id])}
            onToggle={() => setExpanded((s) => ({ ...s, [node.id]: !s[node.id] }))}
          />
        ))}
      </ol>
    </section>
  );
}
