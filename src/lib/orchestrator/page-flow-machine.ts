// xstate machine driving /demolish

import { assign, fromPromise, setup } from "xstate";
import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { generatePlan } from "@/lib/plan/generator";
import { simulateNode, SimulationFailedError } from "@/lib/plan/simulator";
import { topologicalOrder, type PlanNodeStatus, type PlanTree } from "@/lib/plan/tree";
import {
  batchClassicDemolition,
  unroutableCredits,
  type UnroutableCredit,
} from "@/lib/plan/classic-batcher";
import { hydratePlanTransactions } from "@/lib/plan/hydration";
import { executePlanTreeOnChain, type ConfirmationReceipt } from "@/lib/orchestrator/executor";
import { auditAccount } from "@/lib/stellar/account-audit";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicMemo, DemolishProgressEvent, DemolishResult } from "@/lib/types/plan";
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
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly positions?: ProtocolPositions;
  readonly allowances?: readonly AllowanceRecord[];
}

export interface PageFlowContext {
  readonly input: PageFlowInput | null;
  readonly audit: AccountAudit | null;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  readonly discoveryWarnings: readonly string[];
  readonly unroutableCredits: readonly UnroutableCredit[];
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
  // non-fatal discovery failures (allowance scan / position probe) surfaced so
  // the UI can warn that the plan may be incomplete instead of hiding them.
  readonly discoveryWarnings: readonly string[];
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
  readonly returnToIssuerAssetKeys?: readonly string[];
}

interface PreviewOutput {
  readonly tree: PlanTree;
  // positive credit balances with no XLM path and no return-to-issuer consent;
  // while any exist the account can't fully merge (surfaced in the UI).
  readonly unroutableCredits: readonly UnroutableCredit[];
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
  const discoveryWarnings: string[] = [];

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
      console.warn("[demolish] allowance enumeration skipped:", e);
      discoveryWarnings.push(
        "Token-allowance scan couldn't complete, so any active SEP-41 approvals won't appear in this plan. Review them separately on the Allowances page.",
      );
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
      discoveryWarnings.push(
        "DeFi position discovery couldn't complete, so any Blend / Aquarius / Soroswap / FxDAO positions may be missing from this plan.",
      );
    }
  }

  // per-protocol discovery failures (e.g. Soroswap has no position index) were
  // previously invisible; surface them so the user knows the plan may be partial
  for (const e of positions.errors) {
    discoveryWarnings.push(`${e.protocol}: ${e.message}`);
  }

  return { audit, positions, allowances, discoveryWarnings };
});

const previewActor = fromPromise<PreviewOutput, PreviewInput>(async ({ input }) => {
  // resolve real XLM-conversion paths so credit balances convert via path
  // payment; anything without a path (and without return-to-issuer consent) is
  // reported as un-routable rather than silently paid to the issuer.
  const paths = await resolveCreditPaths(input.audit, input.network);
  const unroutable = unroutableCredits(input.audit, paths, input.returnToIssuerAssetKeys);

  // build the real batches so FinalClassicTx carries the real op count
  const batches = batchClassicDemolition(
    input.audit,
    {
      destination: input.destination,
      useMediator: input.useMediator,
      ...(input.selectedClaimableBalanceIds
        ? { claimableBalanceIds: input.selectedClaimableBalanceIds }
        : {}),
      ...(input.returnToIssuerAssetKeys
        ? { returnToIssuerAssetKeys: input.returnToIssuerAssetKeys }
        : {}),
      ...(input.userFallbackAddress ? { userFallbackAddress: input.userFallbackAddress } : {}),
      ...(input.memo ? { memo: input.memo } : {}),
    },
    paths,
  );

  // demolition revokes every active allowance the user owns — the account is
  // being closed, there's no "keep this defi protocol" outcome
  const selectedAllowances = input.allowances.map((a) => `${a.contractId}|${a.spender}`);

  const tree = generatePlan(input.audit, input.positions, input.allowances, input.destination, {
    useMediator: input.useMediator,
    selectedAllowances,
    paths,
    ...(input.memo ? { memo: input.memo } : {}),
    ...(input.userFallbackAddress ? { userFallbackAddress: input.userFallbackAddress } : {}),
    ...(input.selectedClaimableBalanceIds
      ? { selectedClaimableBalanceIds: input.selectedClaimableBalanceIds }
      : {}),
    ...(input.returnToIssuerAssetKeys
      ? { returnToIssuerAssetKeys: input.returnToIssuerAssetKeys }
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
        // the node's transaction never got built during hydration. The adapters
        // ARE wired, so this is a real upstream failure (RPC error, or the
        // contract's state is archived and needs a restore/bump) — say so
        // instead of implying the integration is missing.
        node.status = "skipped";
        node.error = `Could not build the ${node.kind} transaction (RPC error or archived contract state). This step was skipped; close the position manually if it persists.`;
      } else {
        node.status = "failed";
        node.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return { tree, unroutableCredits: unroutable };
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
    // bounded poll (~60s). the SDK short-circuits on a definitive status, so a
    // trailing NOT_FOUND means the poll ceiling was hit while the tx was still
    // pending — that is NOT the same as a hard on-chain FAILED, so report it
    // distinctly instead of asserting failure for a tx that may still confirm.
    // (kept bounded, not unbounded: the RPC's tx-retention window ages hashes
    // out of its queryable set, so polling forever is not safe either.)
    const result = await rpc.pollTransaction(send.hash, { attempts: 60 });
    if (result.status === "FAILED") {
      throw new Error(`submitSoroban: transaction ${send.hash} failed on-chain`);
    }
    if (result.status !== "SUCCESS") {
      // status is NOT_FOUND: poll ceiling reached, tx may still confirm shortly
      throw new Error(
        `submitSoroban: transaction ${send.hash} still pending after polling; ` +
          "it may confirm shortly. Verify on-chain before re-running this step.",
      );
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

    // the executor cascade-skips the merge when a dependency (a DeFi exit) fails,
    // so a non-confirmed final node means the account did NOT close — surface it
    // as a failure instead of a false "Demolition complete."
    if (finalNode !== undefined && finalNode.status !== "confirmed") {
      const reason =
        finalNode.error ??
        "the account merge did not complete because a required step was skipped or failed.";
      input.onProgress({ kind: "blocked", message: `Merge did not complete: ${reason}` });
      return { result: { ok: false, errors: [reason] }, tree: output.tree };
    }

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
  discoveryWarnings: [],
  unroutableCredits: [],
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
            discoveryWarnings: [],
            unroutableCredits: [],
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
            discoveryWarnings: ({ event }) => event.output.discoveryWarnings,
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
            ...(i.returnToIssuerAssetKeys
              ? { returnToIssuerAssetKeys: i.returnToIssuerAssetKeys }
              : {}),
          };
        },
        onDone: {
          target: "awaiting_confirmation",
          actions: assign({
            tree: ({ event }) => event.output.tree,
            unroutableCredits: ({ event }) => event.output.unroutableCredits,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ error: ({ event }) => describeError(event.error) }),
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
            input: ({ event }) => event.input,
            audit: null,
            discoveryWarnings: [],
            unroutableCredits: [],
            tree: null,
            progress: [],
            result: null,
            error: null,
          }),
        },
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
        // re-execute the already-mutated failed tree so the executor's
        // node.executed skip logic skips already-confirmed on-chain steps
        // instead of re-signing/re-submitting them; fall back to a full
        // rediscovery only when the failure happened before a tree existed.
        RETRY: [
          { target: "executing", guard: ({ context }) => context.tree !== null },
          { target: "discovering" },
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

function describeError(err: unknown): string {
  // Soroban RPC rejects with a plain `{ code, message }` object, not an Error,
  // so delegate to the shared extractor rather than falling straight through to
  // String(err) (which would surface "[object Object]" for a failed RPC exit).
  return errorMessage(err);
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
