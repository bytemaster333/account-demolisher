// the step indicator model for the demolish flow

export interface FlowStep {
  readonly num: string;
  readonly label: string;
  readonly isDone: boolean;
  readonly isActive: boolean;
  readonly isTodo: boolean;
  readonly notLast: boolean;
}

export type FlowPhase = "connect" | "configure" | "resolve" | "acknowledge" | "review" | "execute";

export type ConfirmStage = "resolve" | "acknowledge" | "review";

// which step the indicator highlights. A cancelled run, or one that failed before
// a plan existed, sends the user back to Configure, so it is shown there rather
// than on whatever stage the stale tree or confirm stage last pointed at.
export function flowPhaseFor(args: {
  readonly showFlow: boolean;
  readonly state: string;
  readonly hasTree: boolean;
  readonly confirmStage: ConfirmStage;
}): FlowPhase {
  const { showFlow, state, hasTree, confirmStage } = args;
  if (!showFlow) return "connect";
  if (state === "cancelled") return "configure";
  if (state === "failed") return hasTree ? "execute" : "configure";
  // a run that only prepared the close ended like a success: its steps landed
  if (state === "executing" || state === "succeeded" || state === "prepared") return "execute";
  // a rebuild (or a retry that rediscovers) may still hold the previous tree
  // while it runs, but the user is effectively back at Configure
  if (!hasTree || state !== "awaiting_confirmation") return "configure";
  return confirmStage;
}

export function buildFlowSteps(args: {
  readonly phase: FlowPhase;
  // Resolve (blocker action) and Acknowledge (read warnings) are each shown only
  // when the built plan surfaced that kind of item; empty steps are omitted.
  readonly hasResolve: boolean;
  readonly hasAcknowledge: boolean;
  readonly isSucceeded: boolean;
  // shared accounts gain a "Signatures" step after Review, where the other
  // signers' signatures are collected before the close is submitted.
  readonly hasCollect: boolean;
  readonly collecting: boolean;
}): readonly FlowStep[] {
  const { phase, hasResolve, hasAcknowledge, isSucceeded, hasCollect, collecting } = args;
  const labels = [
    "Connect",
    "Configure",
    ...(hasResolve ? ["Fix issues"] : []),
    ...(hasAcknowledge ? ["Warnings"] : []),
    "Review",
    ...(hasCollect ? ["Signatures"] : []),
    "Close",
  ];

  const activeLabel = collecting
    ? "Signatures"
    : phase === "connect"
      ? "Connect"
      : phase === "configure"
        ? "Configure"
        : phase === "resolve"
          ? "Fix issues"
          : phase === "acknowledge"
            ? "Warnings"
            : phase === "review"
              ? "Review"
              : "Close";
  // a phase whose step was omitted (shouldn't happen) falls back to Review
  let activeIdx = labels.indexOf(activeLabel);
  if (activeIdx < 0) activeIdx = labels.indexOf("Review");

  return labels.map((label, i) => {
    const num = String(i + 1).padStart(2, "0");
    const isActive = i === activeIdx && !isSucceeded;
    const isDone = isSucceeded || i < activeIdx;
    const isTodo = !isActive && !isDone;
    const notLast = i < labels.length - 1;
    return { num, label, isDone, isActive, isTodo, notLast };
  });
}
