import { describe, it, expect } from "vitest";

import { buildFlowSteps, flowPhaseFor } from "@/app/demolish/_lib/flow-steps";

describe("flow phase for the step indicator (L-62)", () => {
  const base = { showFlow: true, hasTree: true, confirmStage: "review" as const };

  it("puts a cancelled run back on Configure, not on the stage it left", () => {
    expect(flowPhaseFor({ ...base, state: "cancelled" })).toBe("configure");
  });

  it("puts a failure before any plan existed on Configure", () => {
    expect(flowPhaseFor({ ...base, state: "failed", hasTree: false })).toBe("configure");
  });

  it("keeps a failure after the plan ran on the Close step", () => {
    expect(flowPhaseFor({ ...base, state: "failed", hasTree: true })).toBe("execute");
  });

  it("keeps a run that only prepared the close on the Close step (M-25)", () => {
    expect(flowPhaseFor({ ...base, state: "prepared" })).toBe("execute");
  });

  it("maps the confirmation stages", () => {
    expect(
      flowPhaseFor({ ...base, state: "awaiting_confirmation", confirmStage: "acknowledge" }),
    ).toBe("acknowledge");
    expect(flowPhaseFor({ ...base, state: "awaiting_confirmation" })).toBe("review");
  });

  it("highlights Configure in the steps for a cancelled run", () => {
    const steps = buildFlowSteps({
      phase: flowPhaseFor({ ...base, state: "cancelled" }),
      hasResolve: false,
      hasAcknowledge: true,
      isSucceeded: false,
      hasCollect: false,
      collecting: false,
    });
    expect(steps.find((s) => s.isActive)?.label).toBe("Configure");
  });
});
