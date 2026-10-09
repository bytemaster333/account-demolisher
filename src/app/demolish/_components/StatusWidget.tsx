"use client";

import { executingView, useElapsedSeconds } from "./status/ExecutingView";
import { failedView } from "./status/FailedView";
import { preparedView } from "./status/PreparedView";
import { StatusFrame } from "./status/StatusFrame";
import { succeededView } from "./status/SucceededView";
import type { StatusRun, StatusView, StatusWidgetProps } from "./status/types";

export type { DeliveredAmount, SigningMode, StatusWidgetProps } from "./status/types";

// single, evolving widget that covers execute / succeeded / prepared / failed.
// the frame (live title, counter, plan rows) stays mounted as the run moves
// from one state to the next, so the title's live region announces the change;
// each state's view only fills the frame's slots
export function DemolishStatusWidget({
  retryDisabledReason = null,
  failureKind = null,
  executionNotes = [],
  landedPhases = [],
  discoveryDiagnostics = [],
  prepared = null,
  onPreparedDone,
  ...rest
}: StatusWidgetProps): React.JSX.Element {
  const run: StatusRun = {
    ...rest,
    retryDisabledReason,
    failureKind,
    executionNotes,
    landedPhases,
    discoveryDiagnostics,
    prepared,
    onPreparedDone,
  };
  // the views are plain functions of the run and hold no state, so the
  // executing timer runs here
  const elapsed = useElapsedSeconds(run.state === "executing");
  const view: StatusView =
    run.state === "executing"
      ? executingView(run, elapsed)
      : run.state === "succeeded"
        ? succeededView(run)
        : run.state === "prepared"
          ? preparedView(run)
          : failedView(run);

  return (
    <StatusFrame
      state={run.state}
      view={view}
      planGroups={run.planGroups}
      doneCount={run.doneCount}
      activeCount={run.activeCount}
      network={run.network}
    />
  );
}
