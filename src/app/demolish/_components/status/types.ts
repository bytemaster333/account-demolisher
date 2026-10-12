import type { NetworkConfig } from "@/lib/config/networks";
import type { LeftBehindToken } from "@/lib/orchestrator/executor";
import type { PhaseReceipt } from "@/lib/orchestrator/journal";
import type { FailureKind } from "@/lib/orchestrator/page-flow-machine";
import type { PlanTree, PreparePlan } from "@/lib/plan/tree";

import type { PlanGroup } from "../../_lib/plan-copy";

export type DeliveredAmount =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly xlm: string }
  // reason: why the amount couldn't be read, shown in place of the figure
  | { readonly status: "unavailable"; readonly reason: string };

// how the steps of this run get signed: a wallet prompts per step, a pasted or
// demo key signs in this browser with no prompt, and a collected bundle is
// already signed by everyone
export type SigningMode = "wallet" | "secret" | "bundle";

// "prepared": every step ran but nothing merged, the account stays open until
// the queued backstop withdrawal unlocks
export type StatusState = "executing" | "succeeded" | "prepared" | "failed";

export interface StatusWidgetProps {
  readonly state: StatusState;
  readonly tree: PlanTree;
  readonly planGroups: readonly PlanGroup[];
  readonly doneCount: number;
  readonly activeCount: number;
  // the network this run is executing on (not the navbar's current choice)
  readonly network: NetworkConfig;
  readonly closedAccount: string;
  readonly destination: string;
  readonly mergeHash: string | null;
  readonly delivered: DeliveredAmount;
  readonly error: string | null;
  readonly signingMode: SigningMode;
  // whether RETRY re-runs the remaining steps (true) or rebuilds from a fresh
  // audit (false), so the copy never promises a resume that won't happen. the
  // retryable kinds (isRetryableFailure) are bad_seq, changed_footprint,
  // network, signing, ambiguous, forward_pending, interrupted and close_running;
  // everything else, unknown and conversion_refused included, rebuilds the plan
  readonly retryResumes: boolean;
  readonly retryDisabledReason?: string | null;
  readonly failureKind?: FailureKind | null;
  // best-effort steps that did not do what the plan asked
  readonly executionNotes?: readonly string[];
  // held tokens the run could not send; a close with any is not a clean close
  readonly leftBehind?: readonly LeftBehindToken[];
  // classic batches that landed in this run (unwind phases and close batches),
  // including those of a close that did not finish
  readonly landedPhases?: readonly PhaseReceipt[];
  // technical detail behind the discovery warnings
  readonly discoveryDiagnostics?: readonly string[];
  // the run's own prepared close (unlock time and reason), for the prepared state
  readonly prepared?: PreparePlan | null;
  readonly onRetry: () => void;
  readonly onReset: () => void;
  // leaves the prepared state for Configure, keeping the wallet connected
  readonly onPreparedDone?: () => void;
}

// the widget's props with the optional ones filled in, as every view reads them
export interface StatusRun extends Omit<
  StatusWidgetProps,
  | "retryDisabledReason"
  | "failureKind"
  | "executionNotes"
  | "leftBehind"
  | "landedPhases"
  | "discoveryDiagnostics"
  | "prepared"
  | "onPreparedDone"
> {
  readonly retryDisabledReason: string | null;
  readonly failureKind: FailureKind | null;
  readonly executionNotes: readonly string[];
  readonly leftBehind: readonly LeftBehindToken[];
  readonly landedPhases: readonly PhaseReceipt[];
  readonly discoveryDiagnostics: readonly string[];
  readonly prepared: PreparePlan | null;
  readonly onPreparedDone: (() => void) | undefined;
}

// what one state puts into the shared frame. the frame itself stays mounted
// across states, so only these slots change when the run moves on
export interface StatusView {
  readonly accent: string;
  readonly icon: React.ReactNode;
  readonly iconAnimation: string;
  readonly title: string;
  readonly subtitle: React.ReactNode;
  // under the title, inside the header
  readonly headerExtras: React.ReactNode;
  // after the plan rows
  readonly footer: React.ReactNode;
  readonly trailing: React.ReactNode;
}
