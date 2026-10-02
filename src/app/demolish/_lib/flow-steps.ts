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
