// xstate machine driving /demolish

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
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import { enumerateAllowances, type AllowanceRecord } from "@/lib/soroban/allowances";
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
  | { type: "_PROGRESS"; event: DemolishProgressEvent }
  | { type: "_NODE_TICK" };

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
  // tree from the preview pass — execute runs against this so the ui shows
  readonly tree: PlanTree;
  readonly onProgress: (event: DemolishProgressEvent) => void;
  // fires after every node.status mutation during execution so the page can
  readonly onNodeTick: () => void;
}

interface ExecuteOutput {
  readonly result: DemolishResult;
  readonly tree: PlanTree;
}

// per-discovery-step ceiling so a hanging testnet rpc can't pin the ui in the
const DISCOVERY_TIMEOUT_MS = 30_000;
// matches the rpc's typical event-retention window
const ALLOWANCE_SCAN_WINDOW_LEDGERS = 120_960;

function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

const discoverActor = fromPromise<DiscoverOutput, DiscoverInput>(async ({ input }) => {
  const audit = await auditAccount(input.publicKey, input.network);

  // allowances: best-effort sep-41 enumeration. wrapped in a hard timeout
  // because rpc.getEvents pagination can stall on a flaky testnet endpoint
  let allowances: readonly AllowanceRecord[] = input.allowances ?? [];
  if (allowances.length === 0) {
    try {
      const rpc = getRpc(input.network);
      const latest = await withTimeout(
        "getLatestLedger",
        rpc.getLatestLedger(),
        DISCOVERY_TIMEOUT_MS,
      );
      allowances = await withTimeout(
        "enumerateAllowances",
        enumerateAllowances(rpc, input.publicKey, latest.sequence, ALLOWANCE_SCAN_WINDOW_LEDGERS),
        DISCOVERY_TIMEOUT_MS,
      );
    } catch (e) {
      // surface to the dev console; ui carries on with empty allowances
      console.warn("[demolish] allowance enumeration skipped:", e);
    }
  }

  // defi positions: direct-contract probing across blend/aquarius/soroswap/fxdao
  let positions: ProtocolPositions = input.positions ?? EMPTY_POSITIONS;
  if (positions === EMPTY_POSITIONS) {
    try {
      const provider = new DirectContractProvider();
      positions = await withTimeout(
        "getPositions",
        provider.getPositions(input.publicKey, input.network),
        DISCOVERY_TIMEOUT_MS,
      );
    } catch (e) {
      console.warn("[demolish] position discovery skipped:", e);
    }
  }

  return { audit, positions, allowances };
});

const previewActor = fromPromise<PreviewOutput, PreviewInput>(async ({ input }) => {
  // build the real batches so FinalClassicTx carries the real op count
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

  // demolition revokes every active allowance the user owns — the account is
  // being closed, there's no "keep this defi protocol" outcome
  const selectedAllowances = input.allowances.map((a) => `${a.contractId}|${a.spender}`);

  const tree = generatePlan(input.audit, input.positions, input.allowances, input.destination, {
    useMediator: input.useMediator,
    selectedAllowances,
    ...(input.memo ? { memo: input.memo } : {}),
    ...(input.userFallbackAddress ? { userFallbackAddress: input.userFallbackAddress } : {}),
    ...(input.selectedClaimableBalanceIds
      ? { selectedClaimableBalanceIds: input.selectedClaimableBalanceIds }
      : {}),
  });

  // splice batches onto FinalClassicTx; metadata is readonly at the type
  // level but documented as a hydration point
  for (const node of tree.allNodes.values()) {
    if (node.kind === "FinalClassicTx") {
      const md = node.metadata as { batches: readonly (typeof batches)[number][] };
      md.batches = batches;
    }
  }

  const rpcServer = getRpc(input.network);
  const horizon = getHorizon(input.network);

  // hydrate soroban nodes so the simulator has a built transaction to inspect
  try {
    const previewLedger = await rpcServer.getLatestLedger();
    await hydratePlanTransactions(tree, input.audit.accountId, {
      rpc: rpcServer,
      horizon,
      network: input.network,
      currentLedger: previewLedger.sequence,
      fetchSourceAccount: (pk) => horizon.loadAccount(pk),
    });
  } catch (err) {
    // hydration failures here are non-fatal — the simulate loop below will
    console.warn("[preview] hydratePlanTransactions:", err);
  }

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
        // unhydrated soroban node: mark skipped so the UI tells the truth
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

const executeActor = fromPromise<ExecuteOutput, ExecuteInput>(async ({ input }) => {
  // execute the SAME tree the preview pass produced
  const rpc = getRpc(input.network);
  const horizon = getHorizon(input.network);
  const tree = input.tree;

  // re-hydrate the tree against fresh sequence numbers / ledger state
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
      {
        publicKey: input.publicKey,
        tree,
        previousReceipts: {},
        onNodeUpdate: () => input.onNodeTick(),
      },
      {
        network: input.network,
        connector: input.connector,
        horizon,
        submitClassic,
        submitSoroban,
      },
    );
    // final receipt = FinalClassicTx merge, else last confirmed
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
      result: {
        ok: true,
        errors: [],
        ...(mergedTxHash ? { mergedTxHash } : {}),
        ...(forwardTxHash ? { forwardTxHash } : {}),
      },
      tree: output.tree,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.onProgress({ kind: "blocked", message });
    return { result: { ok: false, errors: [message] }, tree };
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
          if (!context.tree) throw new Error("executing: missing tree from preview");
          return {
            publicKey: i.publicKey,
            network: i.network,
            connector: i.connector,
            destination: i.destination,
            useMediator: i.useMediator,
            positions: context.positions,
            allowances: context.allowances,
            tree: context.tree,
            ...(i.memo ? { memo: i.memo } : {}),
            ...(i.userFallbackAddress ? { userFallbackAddress: i.userFallbackAddress } : {}),
            ...(i.selectedClaimableBalanceIds
              ? { selectedClaimableBalanceIds: i.selectedClaimableBalanceIds }
              : {}),
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
              // executor mutated nodes in place; re-assign tree to a new
              tree: ({ event }) => ({ ...event.output.tree }),
            }),
          },
          {
            target: "failed",
            actions: assign({
              result: ({ event }) => event.output.result,
              error: ({ event }) => event.output.result.errors.join("; "),
              tree: ({ event }) => ({ ...event.output.tree }),
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
        // executor mutates node.status in place on the shared tree
        _NODE_TICK: {
          actions: assign({
            tree: ({ context }) => (context.tree ? { ...context.tree } : null),
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

// reflect progress events onto the final-classic-tx / mediator-forward nodes
function applyProgressToTree(tree: PlanTree | null, event: DemolishProgressEvent): PlanTree | null {
  if (!tree) return tree;
  const finalNode = tree.allNodes.get("final-classic-tx");
  if (finalNode) {
    switch (event.kind) {
      case "complete":
        if (finalNode.status !== "failed") finalNode.status = "confirmed";
        break;
      case "blocked":
        finalNode.status = "failed";
        finalNode.error = event.message;
        break;
      default:
        // batch-built / submitting / submitted / mediator-cosign are now no-ops
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
