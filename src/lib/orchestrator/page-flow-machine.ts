// page-flow xstate machine for /demolish: wraps auditAccount + generatePlan +
// simulateNode + executeClassicDemolition. lives alongside the canonical
// orchestrator machine until all adapter streams are wired in.

import { assign, fromPromise, setup } from "xstate";
import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { type DemolishProgressEvent, type DemolishResult } from "@/lib/plan/classic-orchestrator";
import { generatePlan } from "@/lib/plan/generator";
import { simulateNode, SimulationFailedError } from "@/lib/plan/simulator";
import { topologicalOrder, type PlanNodeStatus, type PlanTree } from "@/lib/plan/tree";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { hydratePlanTransactions } from "@/lib/plan/hydration";
import { executePlanTreeOnChain, type ConfirmationReceipt } from "@/lib/orchestrator/machine";
import { auditAccount } from "@/lib/stellar/account-audit";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicMemo } from "@/lib/types/plan";
import { EMPTY_POSITIONS, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { Connector } from "@/lib/wallet/connector";

export interface PageFlowInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly connector: Connector;
  readonly destination: string;
  readonly useMediator: boolean;
  readonly memo?: ClassicMemo;
  readonly userFallbackAddress?: string;
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly positions?: ProtocolPositions;
  readonly allowances?: readonly AllowanceRecord[];
}

export interface PageFlowContext {
  readonly input: PageFlowInput | null;
  readonly audit: AccountAudit | null;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  readonly tree: PlanTree | null;
  readonly progress: readonly DemolishProgressEvent[];
  readonly result: DemolishResult | null;
  readonly error: string | null;
}

export type PageFlowEvent =
  | { type: "START"; input: PageFlowInput }
  | { type: "CONFIRM" }
  | { type: "CANCEL" }
  | { type: "RETRY" }
  | { type: "RESET" }
  | { type: "_PROGRESS"; event: DemolishProgressEvent };

interface DiscoverInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly positions?: ProtocolPositions;
  readonly allowances?: readonly AllowanceRecord[];
}

interface DiscoverOutput {
  readonly audit: AccountAudit;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
}

interface PreviewInput {
  readonly audit: AccountAudit;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  readonly network: NetworkConfig;
  readonly destination: string;
  readonly useMediator: boolean;
  readonly memo?: ClassicMemo;
  readonly userFallbackAddress?: string;
  readonly selectedClaimableBalanceIds?: readonly string[];
}

interface PreviewOutput {
  readonly tree: PlanTree;
}

interface ExecuteInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly connector: Connector;
  readonly destination: string;
  readonly useMediator: boolean;
  readonly memo?: ClassicMemo;
  readonly userFallbackAddress?: string;
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  readonly onProgress: (event: DemolishProgressEvent) => void;
}

const discoverActor = fromPromise<DiscoverOutput, DiscoverInput>(async ({ input }) => {
  const audit = await auditAccount(input.publicKey, input.network);
  return {
    audit,
    positions: input.positions ?? EMPTY_POSITIONS,
    allowances: input.allowances ?? [],
  };
});

const previewActor = fromPromise<PreviewOutput, PreviewInput>(async ({ input }) => {
  // build the real batches so FinalClassicTx carries the real op count.
  const batches = batchClassicDemolition(
    input.audit,
    {
      destination: input.destination,
      useMediator: input.useMediator,
      ...(input.selectedClaimableBalanceIds
        ? { claimableBalanceIds: input.selectedClaimableBalanceIds }
        : {}),
      ...(input.userFallbackAddress ? { userFallbackAddress: input.userFallbackAddress } : {}),
      ...(input.memo ? { memo: input.memo } : {}),
    },
    new Map(),
  );

  const tree = generatePlan(input.audit, input.positions, input.allowances, input.destination, {
    useMediator: input.useMediator,
    ...(input.memo ? { memo: input.memo } : {}),
    ...(input.userFallbackAddress ? { userFallbackAddress: input.userFallbackAddress } : {}),
    ...(input.selectedClaimableBalanceIds
      ? { selectedClaimableBalanceIds: input.selectedClaimableBalanceIds }
      : {}),
  });

  // splice batches onto FinalClassicTx; metadata is readonly at the type
  // level but documented as a hydration point.
  for (const node of tree.allNodes.values()) {
    if (node.kind === "FinalClassicTx") {
      const md = node.metadata as { batches: readonly (typeof batches)[number][] };
      md.batches = batches;
    }
  }

  const rpcServer = getRpc(input.network);
  const horizon = getHorizon(input.network);
  for (const node of topologicalOrder(tree)) {
    try {
      const outcome = await simulateNode(node, {
        server: rpcServer,
        network: input.network,
        fetchSourceAccount: async (pk) => horizon.loadAccount(pk),
      });
      node.simulated = outcome;
      node.status = "simulated";
    } catch (err) {
      if (err instanceof SimulationFailedError) {
        node.status = "failed";
        node.error = err.upstreamError;
      } else if (err instanceof Error && err.message.includes("has no built transaction")) {
        // unhydrated soroban node: mark skipped so the UI tells the truth.
        node.status = "skipped";
        node.error = `Adapter integration for ${node.kind} is not yet wired; skipping.`;
      } else {
        node.status = "failed";
        node.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return { tree };
});

const executeActor = fromPromise<DemolishResult, ExecuteInput>(async ({ input }) => {
  // re-discover so hydration sees accurate sequence numbers.
  const audit = await auditAccount(input.publicKey, input.network);
  const rpc = getRpc(input.network);
  const horizon = getHorizon(input.network);

  const positions: ProtocolPositions = input.positions;
  const allowances: readonly AllowanceRecord[] = input.allowances;

  const tree = generatePlan(audit, positions, allowances, input.destination, {
    useMediator: input.useMediator,
    ...(input.memo ? { memo: input.memo } : {}),
    ...(input.userFallbackAddress ? { userFallbackAddress: input.userFallbackAddress } : {}),
    ...(input.selectedClaimableBalanceIds
      ? { selectedClaimableBalanceIds: input.selectedClaimableBalanceIds }
      : {}),
  });

  const ledger = await rpc.getLatestLedger();
  await hydratePlanTransactions(tree, input.publicKey, {
    rpc,
    horizon,
    network: input.network,
    currentLedger: ledger.sequence,
    fetchSourceAccount: (pk) => horizon.loadAccount(pk),
  });

  const submitClassic = async (signedXdr: string): Promise<ConfirmationReceipt> => {
    const signed = TransactionBuilder.fromXDR(signedXdr, input.network.passphrase) as Transaction;
    try {
      const res = (await horizon.submitTransaction(signed)) as {
        readonly hash?: string;
        readonly ledger?: number;
      };
      return { txHash: res.hash ?? "<unknown-classic-hash>", ledger: res.ledger ?? 0 };
    } catch (err) {
      const anyErr = err as { response?: { data?: { extras?: { result_codes?: unknown } } } };
      const codes = anyErr.response?.data?.extras?.result_codes;
      throw new Error(
        `submitClassic rejected: ${codes ? JSON.stringify(codes) : "<no result_codes>"}`,
      );
    }
  };
  const submitSoroban = async (signedXdr: string): Promise<ConfirmationReceipt> => {
    const signed = TransactionBuilder.fromXDR(signedXdr, input.network.passphrase) as Transaction;
    const send = await rpc.sendTransaction(signed);
    if (send.status !== "PENDING" && send.status !== "DUPLICATE") {
      throw new Error(`submitSoroban: sendTransaction returned ${send.status}`);
    }
    const result = await rpc.pollTransaction(send.hash, { attempts: 30 });
    if (result.status !== "SUCCESS") {
      throw new Error(`submitSoroban: pollTransaction returned ${result.status}`);
    }
    return { txHash: send.hash, ledger: result.ledger };
  };

  input.onProgress({
    kind: "submitting",
    message: "Executing demolition plan…",
  });

  try {
    const output = await executePlanTreeOnChain(
      { publicKey: input.publicKey, tree, previousReceipts: {} },
      {
        network: input.network,
        connector: input.connector,
        horizon,
        submitClassic,
        submitSoroban,
      },
    );
    // final receipt = FinalClassicTx merge, else last confirmed.
    const finalNode = output.tree.allNodes.get("final-classic-tx");
    const mergedTxHash = finalNode?.executed?.txHash;
    const forwardNode = output.tree.allNodes.get("mediator-forward");
    const forwardTxHash = forwardNode?.executed?.txHash;
    input.onProgress({
      kind: "complete",
      message: "Demolition complete.",
      ...(mergedTxHash ? { txHash: mergedTxHash } : {}),
    });
    return {
      ok: true,
      errors: [],
      ...(mergedTxHash ? { mergedTxHash } : {}),
      ...(forwardTxHash ? { forwardTxHash } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.onProgress({ kind: "blocked", message });
    return { ok: false, errors: [message] };
  }
});

const initialContext: PageFlowContext = {
  input: null,
  audit: null,
  positions: EMPTY_POSITIONS,
  allowances: [],
  tree: null,
  progress: [],
  result: null,
  error: null,
};

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
            input: ({ event }) => event.input,
            audit: null,
            tree: null,
            progress: [],
            result: null,
            error: null,
          }),
        },
      },
    },
    discovering: {
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
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ error: ({ event }) => describeError(event.error) }),
        },
      },
    },
    previewing: {
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
            network: i.network,
            destination: i.destination,
            useMediator: i.useMediator,
            ...(i.memo ? { memo: i.memo } : {}),
            ...(i.userFallbackAddress ? { userFallbackAddress: i.userFallbackAddress } : {}),
            ...(i.selectedClaimableBalanceIds
              ? { selectedClaimableBalanceIds: i.selectedClaimableBalanceIds }
              : {}),
          };
        },
        onDone: {
          target: "awaiting_confirmation",
          actions: assign({ tree: ({ event }) => event.output.tree }),
        },
        onError: {
          target: "failed",
          actions: assign({ error: ({ event }) => describeError(event.error) }),
        },
      },
    },
    awaiting_confirmation: {
      on: {
        CONFIRM: "executing",
        CANCEL: "cancelled",
      },
    },
    executing: {
      invoke: {
        src: "execute",
        input: ({ context, self }): ExecuteInput => {
          const i = context.input;
          if (!i) throw new Error("executing: missing input");
          return {
            publicKey: i.publicKey,
            network: i.network,
            connector: i.connector,
            destination: i.destination,
            useMediator: i.useMediator,
            positions: context.positions,
            allowances: context.allowances,
            ...(i.memo ? { memo: i.memo } : {}),
            ...(i.userFallbackAddress ? { userFallbackAddress: i.userFallbackAddress } : {}),
            ...(i.selectedClaimableBalanceIds
              ? { selectedClaimableBalanceIds: i.selectedClaimableBalanceIds }
              : {}),
            onProgress: (event: DemolishProgressEvent) => {
              self.send({ type: "_PROGRESS", event });
            },
          };
        },
        onDone: [
          {
            target: "succeeded",
            guard: ({ event }) => event.output.ok,
            actions: assign({
              result: ({ event }) => event.output,
              tree: ({ context }) => markFinalNode(context.tree, "confirmed"),
            }),
          },
          {
            target: "failed",
            actions: assign({
              result: ({ event }) => event.output,
              error: ({ event }) => event.output.errors.join("; "),
              tree: ({ context }) => markFinalNode(context.tree, "failed"),
            }),
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => describeError(event.error),
            tree: ({ context }) => markFinalNode(context.tree, "failed"),
          }),
        },
      },
      on: {
        _PROGRESS: {
          actions: assign({
            progress: ({ context, event }) => [...context.progress, event.event],
            tree: ({ context, event }) => applyProgressToTree(context.tree, event.event),
          }),
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
        RETRY: "discovering",
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

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// reflect progress events onto the final-classic-tx / mediator-forward nodes.
// shallow-clones the tree so react notices a new reference.
function applyProgressToTree(tree: PlanTree | null, event: DemolishProgressEvent): PlanTree | null {
  if (!tree) return tree;
  const finalNode = tree.allNodes.get("final-classic-tx");
  if (finalNode) {
    switch (event.kind) {
      case "batch-built":
        finalNode.status = "simulated";
        break;
      case "submitting":
        finalNode.status = "signed";
        break;
      case "submitted":
        if (!finalNode.executed) {
          finalNode.status = "submitted";
          if (event.txHash) finalNode.executed = { txHash: event.txHash, ledger: 0 };
        }
        break;
      case "complete":
        if (finalNode.status !== "failed") finalNode.status = "confirmed";
        break;
      case "blocked":
        finalNode.status = "failed";
        finalNode.error = event.message;
        break;
      case "mediator-cosign":
        finalNode.status = "signed";
        break;
      default:
        break;
    }
  }
  const mediatorNode = tree.allNodes.get("mediator-forward");
  if (
    mediatorNode &&
    event.kind === "submitted" &&
    event.txHash &&
    finalNode?.executed?.txHash &&
    event.txHash !== finalNode.executed.txHash
  ) {
    mediatorNode.status = "confirmed";
    mediatorNode.executed = { txHash: event.txHash, ledger: 0 };
  }
  return { ...tree };
}

function markFinalNode(tree: PlanTree | null, status: PlanNodeStatus): PlanTree | null {
  if (!tree) return tree;
  const finalNode = tree.allNodes.get("final-classic-tx");
  if (finalNode) finalNode.status = status;
  return { ...tree };
}
