// xstate machine driving /demolish. the actors live in ./actors, the notes the
// user sees before confirming in ./warnings.

import { assign, setup } from "xstate";
import { TransactionBuilder, type Operation } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import type { PlanTree, PreparePlan } from "@/lib/plan/tree";
import type { UnroutableCredit } from "@/lib/plan/classic-batcher";
import type { SignerSnapshot } from "@/lib/multisig/bundle-freshness";
import { classifyFailure, isRetryableFailure, type FailureKind } from "@/lib/orchestrator/failures";
import type { PhaseReceipt } from "@/lib/orchestrator/journal";
import { prepareTreeForExecution, previewBlockers } from "@/lib/orchestrator/retry";
import { txHashHex } from "@/lib/orchestrator/submit";
import { discoveryWarningFor } from "@/lib/orchestrator/warnings";
import { discoverActor, type DiscoverInput } from "@/lib/orchestrator/actors/discover";
import {
  previewActor,
  type EmissionForfeit,
  type PreviewInput,
  type RefusedConversion,
} from "@/lib/orchestrator/actors/preview";
import { executeActor, type ExecuteInput } from "@/lib/orchestrator/actors/execute";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicMemo, DemolishProgressEvent, DemolishResult } from "@/lib/types/plan";
import { EMPTY_POSITIONS, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { HeldToken } from "@/lib/soroban/held-tokens";
import type { ExitTrustlineGap } from "@/lib/soroban/stellar-asset";
import type { Connector } from "@/lib/wallet/connector";

export { classifyFailure, isRetryableFailure, type FailureKind };
export { previewBlockers, type PreviewBlocker } from "@/lib/orchestrator/retry";
export { discoveryWarningFor, heldTokenDispositionWarnings } from "@/lib/orchestrator/warnings";
export {
  fetchDestinationUsableKeys,
  type ConversionRefusalKind,
  type EmissionForfeit,
  type RefusedConversion,
} from "@/lib/orchestrator/actors/preview";

export interface PageFlowInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly connector: Connector;
  readonly destination: string;
  readonly useMediator: boolean;
  readonly memo?: ClassicMemo;
  // the reviewed claimable-balance ids; [] claims none. left undefined, every
  // balance the close can collect is claimed.
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly sendToDestinationAssetKeys?: readonly string[];
  // pathKey()s the user agreed to sell although the conversion is over the
  // price-impact cap or could not be priced: "CODE:ISSUER" for a credit balance,
  // "contract:C..." for a held token
  readonly acceptedPriceImpactAssetKeys?: readonly string[];
  // pools whose accrued backstop emissions the user agreed to leave unclaimed
  // because the claim can't run (see ctx.emissionForfeits)
  readonly forfeitBackstopEmissionPoolIds?: readonly string[];
  // answers to refused held-token conversions (see ctx.refusedConversions), by
  // contract id: send the token to the destination as-is, or leave it on the
  // account. accepting the new price goes in acceptedPriceImpactAssetKeys.
  readonly sendHeldTokensAsIs?: readonly string[];
  readonly leaveHeldTokens?: readonly string[];
  // standalone SEP-41 tokens the user opted in to sweep to the destination
  // (discovered tokens they ticked, plus any they added manually); none by default.
  readonly selectedHeldTokens?: readonly HeldToken[];
  // when true, opted-in held tokens are converted to XLM through the soroswap
  // router rather than transferred as-is. a token that can't be converted is
  // sent as-is instead, unless it was refused for its price, which the user
  // decides.
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

// a collected multisig close and the signer set the relay checked it against
export interface SignedBundle {
  readonly signedXdr: string;
  readonly snapshot: SignerSnapshot;
}

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
  // pool payouts this account has no usable trustline for; the preview turns
  // the ones its exits pay into blockers
  readonly exitTrustlineGaps: readonly ExitTrustlineGap[];
  readonly unroutableCredits: readonly UnroutableCredit[];
  // what the preview found that keeps the close from starting (mergeability,
  // the BLND trustline, the exchange-forward funding), in words for the user
  readonly reviewBlockers: readonly string[];
  // held-token conversions refused for their price; each needs the user's choice
  readonly refusedConversions: readonly RefusedConversion[];
  // backstop emissions claims that can't run; each needs a forfeit acknowledgement
  readonly emissionForfeits: readonly EmissionForfeit[];
  readonly tree: PlanTree | null;
  readonly progress: readonly DemolishProgressEvent[];
  readonly result: DemolishResult | null;
  readonly error: string | null;
  // typed classification of `error`, driving recovery. null without a failure.
  readonly failureKind: FailureKind | null;
  // set when a multisig close's collected bundle is submitted (SUBMIT_BUNDLE)
  readonly signedBundle: SignedBundle | null;
  // best-effort steps that did not do what the plan asked
  readonly executionNotes: readonly string[];
  // classic phases that landed, including those of a close that did not finish
  readonly landedPhases: readonly PhaseReceipt[];
  // aborted by CANCEL while executing; the close stops at the next step boundary
  readonly executionAbort: AbortController | null;
  // set in the "prepared" state: the run did every step it could, the account
  // stays open, and the close can be finished once the backstop queue unlocks
  readonly preparedClose: PreparePlan | null;
}

// the account and network the page showed when the user acted; an event for a
// different run than the one the machine holds is refused
export interface ExpectedRun {
  readonly publicKey: string;
  readonly networkId: string;
}

export type PageFlowEvent =
  | { type: "START"; input: PageFlowInput }
  // typed = the last-4 characters of the reviewed destination the user re-typed;
  // the machine guard re-checks it so a bare/forged CONFIRM can't execute
  | { type: "CONFIRM"; typed: string; expected: ExpectedRun }
  // the multisig bundle path has the same gates as CONFIRM, and the bundle must
  // be the request the link names (planId is its hash) and close this account
  // into the reviewed destination
  | {
      type: "SUBMIT_BUNDLE";
      signedXdr: string;
      planId: string;
      typed: string;
      expected: ExpectedRun;
      // the signer set the relay checked the signatures against (RelayPlan)
      snapshot: SignerSnapshot;
    }
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
  exitTrustlineGaps: [],
  unroutableCredits: [],
  reviewBlockers: [],
  refusedConversions: [],
  emissionForfeits: [],
  tree: null,
  progress: [],
  result: null,
  error: null,
  failureKind: null,
  signedBundle: null,
  executionNotes: [],
  landedPhases: [],
  executionAbort: null,
  preparedClose: null,
};

function storeInput(input: PageFlowInput): StoredInput {
  const { connector, ...rest } = input;
  return { ...rest, signerKind: connector.kind };
}

// everything that must be resolved before the close may start, in words for the
// user: a required step that failed preview, a balance the plan can't dispose
// of, a conversion refused for its price, an emissions claim the user has not
// agreed to forfeit, what the preview's own checks found, and any defi protocol
// discovery could not read. confirming anyway would run the steps before the
// merge and then stop at it.
export function confirmBlockers(
  context: Pick<
    PageFlowContext,
    | "tree"
    | "positions"
    | "unroutableCredits"
    | "reviewBlockers"
    | "refusedConversions"
    | "emissionForfeits"
  >,
): readonly string[] {
  const forfeitPools = new Set(context.emissionForfeits.map((f) => f.poolId));
  return [
    // a claim the user can forfeit is listed once, with its own wording below. a
    // refused conversion never reaches previewBlockers (a conversion is a
    // best-effort kind), so it is listed only from refusedConversions
    ...previewBlockers(context.tree)
      .filter((b) => !isForfeitable(context.tree, b.nodeId, forfeitPools))
      .map((b) => `${b.description}: ${b.error}`),
    ...context.unroutableCredits.map(
      (c) => `${c.amount} ${c.code} can't be disposed of as planned (${creditReason(c)}).`,
    ),
    ...context.refusedConversions.map((r) =>
      r.refusal === "no_route"
        ? `Token ${r.contractId} can't be converted: it has no route to XLM. Send it as-is or leave it.`
        : `Converting token ${r.contractId} was refused for its price (${r.reason}). Accept the price, send it as-is, or leave it.`,
    ),
    ...context.emissionForfeits.map(
      (f) =>
        `The backstop emissions claim for pool ${f.poolId} can't run (${f.reason}). Confirm that you leave ${
          f.accruedEmissions === null ? "the accrued" : formatBlnd(f.accruedEmissions)
        } BLND unclaimed to continue.`,
    ),
    ...context.reviewBlockers,
    ...context.positions.errors.map((e) => discoveryWarningFor(e)),
  ];
}

function isForfeitable(tree: PlanTree | null, nodeId: string, pools: ReadonlySet<string>): boolean {
  const node = tree?.allNodes.get(nodeId);
  const poolId = (node?.metadata as { readonly poolId?: unknown } | undefined)?.poolId;
  return (
    (node?.kind as string | undefined) === "ClaimBackstopEmissions" &&
    typeof poolId === "string" &&
    pools.has(poolId)
  );
}

function creditReason(c: UnroutableCredit): string {
  switch (c.reason) {
    case "no_path":
      return "no market path to XLM; return it to its issuer or send it to your destination";
    case "unpriced":
      return "its price can't be checked against a reference quote; accept the price to sell it";
    case "price_impact":
      return `selling it all would move the price by ${((c.priceImpactBps ?? 0) / 100).toFixed(2)}%; accept that price to sell it`;
    case "requote_worse":
      return "the market price fell below the one you reviewed";
  }
}

function formatBlnd(stroops: bigint): string {
  const frac = (stroops % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  const whole = (stroops / 10_000_000n).toString();
  return frac.length > 0 ? `${whole}.${frac}` : whole;
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

function sameRun(context: PageFlowContext, expected: ExpectedRun | undefined): boolean {
  return (
    expected !== undefined &&
    context.input !== null &&
    expected.publicKey === context.input.publicKey &&
    expected.networkId === context.input.network.id
  );
}

// the collected bundle is the request the link names and does what was reviewed:
// it closes this account into the reviewed destination, and every operation in
// it acts on this account
export function bundleMatchesReview(
  signedXdr: string,
  planId: string,
  run: { readonly publicKey: string; readonly destination: string; readonly passphrase: string },
): boolean {
  let tx;
  try {
    tx = TransactionBuilder.fromXdr(signedXdr, run.passphrase);
  } catch {
    return false;
  }
  if ("innerTransaction" in tx) return false;
  if (txHashHex(tx) !== planId) return false;
  const sourceOf = (op: Operation) => (op as { readonly source?: string }).source ?? tx.source;
  if (!tx.operations.every((op) => sourceOf(op) === run.publicKey)) return false;
  const merge = tx.operations.find((op) => op.type === "accountMerge") as
    Operation.AccountMerge | undefined;
  return merge !== undefined && merge.destination === run.destination;
}

// what a failed discovery or preview leaves: nothing from an earlier plan may be
// executed by a later RETRY
const clearedPlan = {
  tree: null,
  signedBundle: null,
  unroutableCredits: [],
  reviewBlockers: [],
  refusedConversions: [],
  emissionForfeits: [],
  progress: [],
  result: null,
  executionNotes: [],
  landedPhases: [],
  preparedClose: null,
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
    // last 4 characters of the reviewed destination and names the run on screen,
    // a wallet is connected, and nothing in confirmBlockers is open. a CONFIRM
    // dispatched outside the confirmation UI can't trigger the merge.
    confirmMatchesDestination: ({ context, event }) => {
      if (event.type !== "CONFIRM") return false;
      return (
        typedMatches(context, event.typed) &&
        sameRun(context, event.expected) &&
        context.connector !== null &&
        confirmBlockers(context).length === 0
      );
    },
    bundleConfirmed: ({ context, event }) => {
      if (event.type !== "SUBMIT_BUNDLE") return false;
      const i = context.input;
      return (
        i !== null &&
        typedMatches(context, event.typed) &&
        sameRun(context, event.expected) &&
        context.connector !== null &&
        confirmBlockers(context).length === 0 &&
        bundleMatchesReview(event.signedXdr, event.planId, {
          publicKey: i.publicKey,
          destination: i.destination,
          passphrase: i.network.passphrase,
        })
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
            exitTrustlineGaps: ({ event }) => event.output.exitTrustlineGaps,
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
            // [] is a real choice (claim none), so only undefined is left out
            ...(i.selectedClaimableBalanceIds !== undefined
              ? { selectedClaimableBalanceIds: i.selectedClaimableBalanceIds }
              : {}),
            ...(i.returnToIssuerAssetKeys
              ? { returnToIssuerAssetKeys: i.returnToIssuerAssetKeys }
              : {}),
            ...(i.sendToDestinationAssetKeys
              ? { sendToDestinationAssetKeys: i.sendToDestinationAssetKeys }
              : {}),
            ...(i.acceptedPriceImpactAssetKeys
              ? { acceptedPriceImpactAssetKeys: i.acceptedPriceImpactAssetKeys }
              : {}),
            ...(i.forfeitBackstopEmissionPoolIds
              ? { forfeitBackstopEmissionPoolIds: i.forfeitBackstopEmissionPoolIds }
              : {}),
            ...(i.sendHeldTokensAsIs ? { sendHeldTokensAsIs: i.sendHeldTokensAsIs } : {}),
            ...(i.leaveHeldTokens ? { leaveHeldTokens: i.leaveHeldTokens } : {}),
            ...(i.deterministicDisposal ? { deterministicDisposal: true } : {}),
            exitTrustlineGaps: context.exitTrustlineGaps,
          };
        },
        onDone: {
          target: "awaiting_confirmation",
          actions: assign({
            tree: ({ event }) => event.output.tree,
            unroutableCredits: ({ event }) => event.output.unroutableCredits,
            // optional in the output: a preview that found none leaves them out
            reviewBlockers: ({ event }) => event.output.reviewBlockers ?? [],
            refusedConversions: ({ event }) => event.output.refusedConversions ?? [],
            emissionForfeits: ({ event }) => event.output.emissionForfeits ?? [],
            // held-token disposition depends on the destination kind, decided at
            // preview; fold those notes and the review notes into the warnings
            // the UI shows.
            discoveryWarnings: ({ context, event }) => [
              ...context.discoveryWarnings,
              ...event.output.heldTokenWarnings,
              ...(event.output.reviewNotes ?? []),
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
            error: null,
            failureKind: null,
            ...clearedPlan,
          }),
        },
        CONFIRM: { target: "executing", guard: "confirmMatchesDestination" },
        // a multisig close: submit the collected, fully-signed bundle
        SUBMIT_BUNDLE: {
          target: "executing",
          guard: "bundleConfirmed",
          actions: assign({
            signedBundle: ({ event }) => ({ signedXdr: event.signedXdr, snapshot: event.snapshot }),
          }),
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
            ...(context.signedBundle ? { bundle: context.signedBundle } : {}),
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
            // nothing merged: the account stays open until the backstop unlocks
            target: "prepared",
            guard: ({ event }) => event.output.result.ok && event.output.prepared !== undefined,
            actions: assign({
              result: ({ event }) => event.output.result,
              preparedClose: ({ event }) => event.output.prepared ?? null,
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
    prepared: {
      on: {
        RESET: { target: "idle", actions: assign(() => initialContext) },
      },
    },
    failed: {
      on: {
        // a retryable failure re-executes the same tree with the wallet that is
        // connected now: landed steps are skipped, everything else re-runs. any
        // other failure, or a retry without a wallet, rebuilds the plan from fresh
        // discovery and drops the old tree, its error and a collected bundle so
        // none of it can be executed or shown later.
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
