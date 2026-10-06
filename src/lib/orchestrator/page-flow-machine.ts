// xstate machine driving /demolish. the actors live in ./actors, the notes the
// user sees before confirming in ./warnings.

import { assign, setup } from "xstate";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import type { PlanTree } from "@/lib/plan/tree";
import type { UnroutableCredit } from "@/lib/plan/classic-batcher";
import { classifyFailure, isRetryableFailure, type FailureKind } from "@/lib/orchestrator/failures";
import type { PhaseReceipt } from "@/lib/orchestrator/journal";
import { prepareTreeForExecution, previewBlockers } from "@/lib/orchestrator/retry";
import { discoveryWarningFor } from "@/lib/orchestrator/warnings";
import { discoverActor, type DiscoverInput } from "@/lib/orchestrator/actors/discover";
import { previewActor, type PreviewInput } from "@/lib/orchestrator/actors/preview";
import { executeActor, type ExecuteInput } from "@/lib/orchestrator/actors/execute";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicMemo, DemolishProgressEvent, DemolishResult } from "@/lib/types/plan";
import { EMPTY_POSITIONS, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { HeldToken } from "@/lib/soroban/held-tokens";
import type { Connector } from "@/lib/wallet/connector";

export { classifyFailure, isRetryableFailure, type FailureKind };
export { previewBlockers, type PreviewBlocker } from "@/lib/orchestrator/retry";
export { discoveryWarningFor, heldTokenDispositionWarnings } from "@/lib/orchestrator/warnings";
export { fetchDestinationUsableKeys } from "@/lib/orchestrator/actors/preview";

export interface PageFlowInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly connector: Connector;
  readonly destination: string;
  readonly useMediator: boolean;
  readonly memo?: ClassicMemo;
  readonly userFallbackAddress?: string;
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly sendToDestinationAssetKeys?: readonly string[];
  // standalone SEP-41 tokens the user opted in to sweep to the destination
  // (discovered tokens they ticked, plus any they added manually); none by default.
  readonly selectedHeldTokens?: readonly HeldToken[];
  // when true, opted-in held tokens are converted to XLM through the soroswap
  // router rather than transferred as-is. a token that can't be converted is
  // sent as-is instead.
  readonly convertHeldTokensToXLM?: boolean;
  readonly positions?: ProtocolPositions;
  readonly allowances?: readonly AllowanceRecord[];
  // when true, no market-conversion paths are resolved: every non-XLM balance is
  // treated as un-routable so the user must choose issuer or destination. used
  // for a multisig signing request, where a market sell could fail and sink the
  // one bundled transaction everyone signs.
  readonly deterministicDisposal?: boolean;
}

// the input as kept in context: the connector lives in its own slot so it can be
// dropped when a close ends and handed back explicitly on RETRY. signerKind
// records which kind of wallet the run started with, for display.
export type PageFlowRunInput = Omit<PageFlowInput, "connector"> & {
  readonly signerKind: Connector["kind"];
};
type StoredInput = PageFlowRunInput;

export interface PageFlowContext {
  readonly input: StoredInput | null;
  // the wallet that signs the next execution. cleared whenever a close ends, so a
  // retry after a disconnect or network switch can't sign with a stale one
  readonly connector: Connector | null;
  readonly audit: AccountAudit | null;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  // standalone SEP-41 tokens the account holds directly (event scan), offered
  // for opt-in; `unreadableHeldTokens` credited the account but their balance
  // couldn't be read
  readonly heldTokens: readonly HeldToken[];
  readonly unreadableHeldTokens: readonly string[];
  // true when the optional standalone-token scan couldn't complete (timeout/blip);
  // lets the UI still offer the manual add-a-token affordance in that case.
  readonly heldTokenScanFailed: boolean;
  readonly discoveryWarnings: readonly string[];
  // technical detail behind the discovery warnings, for a collapsed section
  readonly discoveryDiagnostics: readonly string[];
  readonly unroutableCredits: readonly UnroutableCredit[];
  readonly tree: PlanTree | null;
  readonly progress: readonly DemolishProgressEvent[];
  readonly result: DemolishResult | null;
  readonly error: string | null;
  // typed classification of `error`, driving recovery. null without a failure.
  readonly failureKind: FailureKind | null;
  // set when a multisig close's collected bundle is submitted (SUBMIT_BUNDLE)
  readonly signedBundleXdr: string | null;
  // best-effort steps that did not do what the plan asked
  readonly executionNotes: readonly string[];
  // classic phases that landed, including those of a close that did not finish
  readonly landedPhases: readonly PhaseReceipt[];
  // aborted by CANCEL while executing; the close stops at the next step boundary
  readonly executionAbort: AbortController | null;
}

export type PageFlowEvent =
  | { type: "START"; input: PageFlowInput }
  // typed = the last-4 characters of the reviewed destination the user re-typed;
  // the machine guard re-checks it so a bare/forged CONFIRM can't execute
  | { type: "CONFIRM"; typed: string }
  // the multisig bundle path has the same typed-destination gate as CONFIRM
  | { type: "SUBMIT_BUNDLE"; signedXdr: string; typed?: string }
  | { type: "CANCEL" }
  // the wallet currently connected; without one a retry can only rediscover
  | { type: "RETRY"; connector?: Connector | null }
  | { type: "RESET" }
  | { type: "_PROGRESS"; event: DemolishProgressEvent }
  | { type: "_NODE_TICK" };

const initialContext: PageFlowContext = {
  input: null,
  connector: null,
  audit: null,
  positions: EMPTY_POSITIONS,
  allowances: [],
  heldTokens: [],
  unreadableHeldTokens: [],
  heldTokenScanFailed: false,
  discoveryWarnings: [],
  discoveryDiagnostics: [],
  unroutableCredits: [],
  tree: null,
  progress: [],
  result: null,
  error: null,
  failureKind: null,
  signedBundleXdr: null,
  executionNotes: [],
  landedPhases: [],
  executionAbort: null,
};

function storeInput(input: PageFlowInput): StoredInput {
  const { connector, ...rest } = input;
  return { ...rest, signerKind: connector.kind };
}

// everything that must be resolved before the close may start, in words for the
// user: a required step that failed preview, and any defi protocol discovery
// could not read. the merge guard refuses an unreadable protocol at merge time,
// so confirming anyway would only unwind the other positions first.
export function confirmBlockers(
  context: Pick<PageFlowContext, "tree" | "positions">,
): readonly string[] {
  return [
    ...previewBlockers(context.tree).map((b) => `${b.description}: ${b.error}`),
    ...context.positions.errors.map((e) => discoveryWarningFor(e)),
  ];
}

function typedMatches(context: PageFlowContext, typed: string | undefined): boolean {
  const dest = context.input?.destination;
  return (
    typeof dest === "string" &&
    dest.length >= 4 &&
    typeof typed === "string" &&
    typed === dest.slice(-4)
  );
}

// what a failed discovery or preview leaves: nothing from an earlier plan may be
// executed by a later RETRY
const clearedPlan = {
  tree: null,
  signedBundleXdr: null,
  progress: [],
  result: null,
  executionNotes: [],
  landedPhases: [],
} as const;

export const pageFlowMachine = setup({
  types: {
    context: {} as PageFlowContext,
    events: {} as PageFlowEvent,
  },
  actors: {
    discover: discoverActor,
    preview: previewActor,
    execute: executeActor,
  },
  guards: {
    // the irreversible execute transition refuses unless the event carries the
    // last 4 characters of the reviewed destination, a wallet is connected, and
    // nothing in confirmBlockers is open. a CONFIRM dispatched outside the
    // confirmation UI can't trigger the merge.
    confirmMatchesDestination: ({ context, event }) => {
      if (event.type !== "CONFIRM") return false;
      return (
        typedMatches(context, event.typed) &&
        context.connector !== null &&
        confirmBlockers(context).length === 0
      );
    },
    bundleConfirmed: ({ context, event }) => {
      if (event.type !== "SUBMIT_BUNDLE") return false;
      return (
        typedMatches(context, event.typed) &&
        context.connector !== null &&
        confirmBlockers(context).length === 0
      );
    },
    canResume: ({ context, event }) => {
      if (event.type !== "RETRY") return false;
      return (
        context.tree !== null &&
        isRetryableFailure(context.failureKind ?? "unknown") &&
        event.connector !== undefined &&
        event.connector !== null
      );
    },
  },
}).createMachine({
  id: "page-flow",
  initial: "idle",
  context: initialContext,
  states: {
    idle: {
      on: {
        START: {
          target: "discovering",
          actions: assign({
            input: ({ event }) => storeInput(event.input),
            connector: ({ event }) => event.input.connector,
            audit: null,
            discoveryWarnings: [],
            discoveryDiagnostics: [],
            unroutableCredits: [],
            error: null,
            failureKind: null,
            ...clearedPlan,
          }),
        },
      },
    },
    discovering: {
      // the account or network changed under the run; the scan's result is dropped
      on: {
        CANCEL: { target: "cancelled", actions: assign({ connector: null, ...clearedPlan }) },
      },
      invoke: {
        src: "discover",
        input: ({ context }): DiscoverInput => {
          const i = context.input;
          if (!i) throw new Error("discovering: missing input");
          return {
            publicKey: i.publicKey,
            network: i.network,
            ...(i.positions ? { positions: i.positions } : {}),
            ...(i.allowances ? { allowances: i.allowances } : {}),
          };
        },
        onDone: {
          target: "previewing",
          actions: assign({
            audit: ({ event }) => event.output.audit,
            positions: ({ event }) => event.output.positions,
            allowances: ({ event }) => event.output.allowances,
            heldTokens: ({ event }) => event.output.heldTokens,
            unreadableHeldTokens: ({ event }) => event.output.unreadableHeldTokens,
            heldTokenScanFailed: ({ event }) => event.output.heldTokenScanFailed,
            discoveryWarnings: ({ event }) => event.output.discoveryWarnings,
            discoveryDiagnostics: ({ event }) => event.output.discoveryDiagnostics,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => errorMessage(event.error),
            failureKind: ({ event }) => classifyFailure(event.error),
            connector: null,
            ...clearedPlan,
          }),
        },
      },
    },
    previewing: {
      on: {
        CANCEL: { target: "cancelled", actions: assign({ connector: null, ...clearedPlan }) },
      },
      invoke: {
        src: "preview",
        input: ({ context }): PreviewInput => {
          const i = context.input;
          const audit = context.audit;
          if (!i || !audit) throw new Error("previewing: missing input or audit");
          return {
            audit,
            positions: context.positions,
            allowances: context.allowances,
            // only what the user explicitly opted in to drain (default none)
            selectedHeldTokens: i.selectedHeldTokens ?? [],
            ...(i.convertHeldTokensToXLM ? { convertHeldTokensToXLM: true } : {}),
            network: i.network,
            destination: i.destination,
            useMediator: i.useMediator,
            ...(i.memo ? { memo: i.memo } : {}),
            ...(i.userFallbackAddress ? { userFallbackAddress: i.userFallbackAddress } : {}),
            ...(i.selectedClaimableBalanceIds
              ? { selectedClaimableBalanceIds: i.selectedClaimableBalanceIds }
              : {}),
            ...(i.returnToIssuerAssetKeys
              ? { returnToIssuerAssetKeys: i.returnToIssuerAssetKeys }
              : {}),
            ...(i.sendToDestinationAssetKeys
              ? { sendToDestinationAssetKeys: i.sendToDestinationAssetKeys }
              : {}),
            ...(i.deterministicDisposal ? { deterministicDisposal: true } : {}),
          };
        },
        onDone: {
          target: "awaiting_confirmation",
          actions: assign({
            tree: ({ event }) => event.output.tree,
            unroutableCredits: ({ event }) => event.output.unroutableCredits,
            // held-token disposition depends on the destination kind, decided at
            // preview; fold those notes into the discovery warnings the UI shows.
            discoveryWarnings: ({ context, event }) => [
              ...context.discoveryWarnings,
              ...(event.output.heldTokenWarnings ?? []),
            ],
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => errorMessage(event.error),
            failureKind: ({ event }) => classifyFailure(event.error),
            connector: null,
            ...clearedPlan,
          }),
        },
      },
    },
    awaiting_confirmation: {
      on: {
        // re-run discovery + preview with updated input (e.g. after the user
        // toggles return-to-issuer consent and hits "Rebuild plan").
        START: {
          target: "discovering",
          actions: assign({
            input: ({ event }) => storeInput(event.input),
            connector: ({ event }) => event.input.connector,
            audit: null,
            discoveryWarnings: [],
            discoveryDiagnostics: [],
            unroutableCredits: [],
            error: null,
            failureKind: null,
            ...clearedPlan,
          }),
        },
        CONFIRM: { target: "executing", guard: "confirmMatchesDestination" },
        // a multisig close: submit the collected, fully-signed bundle as-is
        SUBMIT_BUNDLE: {
          target: "executing",
          guard: "bundleConfirmed",
          actions: assign({ signedBundleXdr: ({ event }) => event.signedXdr }),
        },
        CANCEL: { target: "cancelled", actions: assign({ connector: null }) },
      },
    },
    executing: {
      entry: assign({
        executionAbort: () => new AbortController(),
        // anything that did not land re-runs; see prepareTreeForExecution
        tree: ({ context }) => (context.tree ? prepareTreeForExecution(context.tree) : null),
        progress: [],
        result: null,
        error: null,
        executionNotes: [],
      }),
      invoke: {
        src: "execute",
        input: ({ context, self }): ExecuteInput => {
          const i = context.input;
          if (!i) throw new Error("executing: missing input");
          if (!context.tree) throw new Error("executing: missing tree from preview");
          if (!context.connector) throw new Error("executing: no wallet connected");
          if (!context.executionAbort) throw new Error("executing: missing abort controller");
          return {
            publicKey: i.publicKey,
            network: i.network,
            connector: context.connector,
            tree: context.tree,
            interrupt: context.executionAbort.signal,
            ...(context.signedBundleXdr ? { signedBundleXdr: context.signedBundleXdr } : {}),
            onProgress: (event: DemolishProgressEvent) => {
              self.send({ type: "_PROGRESS", event });
            },
            onNodeTick: () => {
              self.send({ type: "_NODE_TICK" });
            },
          };
        },
        onDone: [
          {
            target: "succeeded",
            guard: ({ event }) => event.output.result.ok,
            actions: assign({
              result: ({ event }) => event.output.result,
              // executor mutated nodes in place; re-assign so subscribers re-render
              tree: ({ event }) => ({ ...event.output.tree }),
              error: null,
              failureKind: null,
              executionNotes: ({ event }) => event.output.notes,
              landedPhases: ({ event }) => event.output.landedPhases,
              connector: null,
              executionAbort: null,
            }),
          },
          {
            target: "failed",
            actions: assign({
              result: ({ event }) => event.output.result,
              error: ({ event }) => event.output.result.errors.join("; "),
              failureKind: ({ event }) =>
                event.output.failureKind ?? classifyFailure(event.output.result.errors.join("; ")),
              tree: ({ event }) => ({ ...event.output.tree }),
              executionNotes: ({ event }) => event.output.notes,
              landedPhases: ({ event }) => event.output.landedPhases,
              connector: null,
              executionAbort: null,
            }),
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => errorMessage(event.error),
            failureKind: ({ event }) => classifyFailure(event.error),
            tree: ({ context }) => (context.tree ? { ...context.tree } : null),
            connector: null,
            executionAbort: null,
          }),
        },
      },
      on: {
        _PROGRESS: {
          actions: assign({
            progress: ({ context, event }) => [...context.progress, event.event],
          }),
        },
        // executor mutates node.status in place on the shared tree
        _NODE_TICK: {
          actions: assign({
            tree: ({ context }) => (context.tree ? { ...context.tree } : null),
          }),
        },
        // stop at the next step boundary; the execute actor then finishes with an
        // "interrupted" failure that reports what already landed
        CANCEL: {
          actions: ({ context }) => context.executionAbort?.abort(),
        },
      },
    },
    succeeded: {
      on: {
        RESET: { target: "idle", actions: assign(() => initialContext) },
      },
    },
    failed: {
      on: {
        // a retryable failure re-executes the same tree with the wallet that is
        // connected now: landed steps are skipped, everything else re-runs. any
        // other failure, or a retry without a wallet, rebuilds the plan from fresh
        // discovery and drops the old tree so it can't be executed later.
        RETRY: [
          {
            target: "executing",
            guard: "canResume",
            actions: assign({
              connector: ({ event }) => event.connector ?? null,
              failureKind: null,
            }),
          },
          {
            target: "discovering",
            actions: assign({
              connector: ({ event }) => event.connector ?? null,
              error: null,
              failureKind: null,
              ...clearedPlan,
            }),
          },
        ],
        RESET: { target: "idle", actions: assign(() => initialContext) },
      },
    },
    cancelled: {
      on: {
        RESET: { target: "idle", actions: assign(() => initialContext) },
      },
    },
  },
});
