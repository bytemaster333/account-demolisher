// execute: runs the reviewed tree on chain, or submits a collected multisig
// bundle as-is

import { fromPromise } from "xstate";
import { TransactionBuilder } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { isSorobanNode, type PlanNode, type PlanTree } from "@/lib/plan/tree";
import { rebuildSorobanNodeTransaction } from "@/lib/plan/hydration";
import { startMediatorFlow } from "@/lib/mediator/client";
import { FINAL_CLASSIC_TX_NODE_ID, MEDIATOR_FORWARD_NODE_ID } from "@/lib/mediator/refresh";
import {
  clearPendingForward,
  loadPendingForward,
  savePendingForward,
} from "@/lib/mediator/pending-flow";
import {
  executePlanTreeOnChain,
  type ConfirmationReceipt,
  type LandedMerge,
  type MediatorFlowControl,
  type TxLookup,
} from "@/lib/orchestrator/executor";
import {
  classifyFailure,
  CloseFailure,
  SubmitRejectedError,
  type FailureKind,
} from "@/lib/orchestrator/failures";
import { landedPhasesOf, type PhaseReceipt } from "@/lib/orchestrator/journal";
import {
  createClassicSubmitter,
  createSorobanSubmitter,
  isNotFoundError,
  txHashHex,
  txMaxTime,
} from "@/lib/orchestrator/submit";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { DemolishProgressEvent, DemolishResult } from "@/lib/types/plan";
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import type { Connector } from "@/lib/wallet/connector";

export interface ExecuteInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly connector: Connector;
  // tree from the preview pass; execute runs against this so the ui shows
  // the same steps the user reviewed
  readonly tree: PlanTree;
  // present for a multisig close: the fully-signed bundled transaction to submit
  // as-is, instead of re-building/signing the tree node by node.
  readonly signedBundleXdr?: string;
  // aborted by CANCEL; combined with the actor's own stop signal
  readonly interrupt: AbortSignal;
  readonly onProgress: (event: DemolishProgressEvent) => void;
  // fires after every node.status mutation so the page re-renders the steps
  readonly onNodeTick: () => void;
}

export interface ExecuteOutput {
  readonly result: DemolishResult;
  readonly tree: PlanTree;
  readonly failureKind?: FailureKind;
  readonly notes: readonly string[];
  readonly landedPhases: readonly PhaseReceipt[];
}

// mediator flow wiring for the executor: mint through the sign route, record the
// flow in the pending-forward store before the funding batch is signed, and clear
// that record only for the flow whose forward landed
function mediatorFlowControl(
  input: ExecuteInput,
  horizon: ReturnType<typeof getHorizon>,
): MediatorFlowControl {
  return {
    async mint(destination) {
      // this build's mint endpoint takes only the destination; the memo rides on
      // the forward
      const flow = await startMediatorFlow(destination);
      if (!flow.ok) {
        const kind: FailureKind =
          flow.code === "NETWORK_ERROR" || flow.code === "RATE_LIMITED" ? "network" : "unknown";
        throw new CloseFailure(
          kind,
          `Could not start the exchange-forward flow (${flow.code}): ${flow.reason}`,
        );
      }
      return { mediatorPublicKey: flow.mediatorPublicKey, flowToken: flow.flowToken };
    },
    persist(flow) {
      savePendingForward({
        publicKey: input.publicKey,
        mediatorPublicKey: flow.mediatorPublicKey,
        flowToken: flow.flowToken,
        ultimateDestination: flow.ultimateDestination,
        ...(flow.memo ? { memo: flow.memo } : {}),
        networkId: input.network.id,
        // the issue time, so a later run can tell how long the token has left
        savedAt: flow.issuedAt,
      });
    },
    previous() {
      const p = loadPendingForward(input.publicKey);
      if (p === null || p.networkId !== input.network.id) return null;
      return {
        mediatorPublicKey: p.mediatorPublicKey,
        flowToken: p.flowToken,
        ultimateDestination: p.ultimateDestination,
        ...(p.memo ? { memo: p.memo } : {}),
        issuedAt: p.savedAt,
      };
    },
    forwarded(mediatorPublicKey) {
      if (loadPendingForward(input.publicKey)?.mediatorPublicKey === mediatorPublicKey) {
        clearPendingForward();
      }
    },
    async findForward(mediatorPublicKey) {
      const page = await horizon
        .transactions()
        .forAccount(mediatorPublicKey)
        .order("desc")
        .limit(10)
        .call();
      const forward = page.records.find(
        (r) => r.successful && r.source_account === mediatorPublicKey,
      );
      return forward?.hash ?? null;
    },
  };
}

// the merge that deleted the account, read from its operation history (horizon
// keeps it after the account is gone)
async function findLandedMerge(
  horizon: ReturnType<typeof getHorizon>,
  publicKey: string,
): Promise<LandedMerge | null> {
  const page = await horizon.operations().forAccount(publicKey).order("desc").limit(20).call();
  const merge = page.records.find(
    (r) =>
      String(r.type) === "account_merge" &&
      r.transaction_successful &&
      r.source_account === publicKey,
  );
  if (merge === undefined || !("into" in merge) || typeof merge.into !== "string") return null;
  const tx = await horizon.transactions().transaction(merge.transaction_hash).call();
  return { txHash: merge.transaction_hash, ledger: tx.ledger_attr, into: merge.into };
}

async function lookupHorizonTransaction(
  horizon: ReturnType<typeof getHorizon>,
  hash: string,
  maxTime: number | null,
): Promise<TxLookup> {
  try {
    const record = await horizon.transactions().transaction(hash).call();
    return record.successful
      ? { status: "success", ledger: record.ledger_attr }
      : { status: "failed" };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  if (maxTime === null) return { status: "pending" };
  const page = await horizon.ledgers().order("desc").limit(1).call();
  const closed = page.records[0]?.closed_at;
  const closedAt = typeof closed === "string" ? Math.floor(Date.parse(closed) / 1000) : null;
  return closedAt !== null && closedAt > maxTime ? { status: "expired" } : { status: "pending" };
}

async function lookupRpcTransaction(
  rpc: ReturnType<typeof getRpc>,
  hash: string,
  maxTime: number | null,
): Promise<TxLookup> {
  const res = await rpc.getTransaction(hash);
  if (res.status === "SUCCESS") return { status: "success", ledger: res.ledger };
  if (res.status === "FAILED") return { status: "failed" };
  const closedAt = Number(res.latestLedgerCloseTime);
  if (maxTime !== null && Number.isFinite(closedAt) && closedAt > maxTime) {
    return { status: "expired" };
  }
  return { status: "pending" };
}

// aborts when either source aborts (AbortSignal.any is missing from older
// safari releases)
function eitherSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const both = new AbortController();
  const abort = () => both.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return both.signal;
}

// steps a signed multisig bundle can't contain: any soroban node or the forward
function bundleStray(tree: PlanTree): PlanNode | undefined {
  return [...tree.allNodes.values()].find(
    (n) => n.kind !== "FinalClassicTx" && (isSorobanNode(n) || n.kind === "MediatorForward"),
  );
}

export const executeActor = fromPromise<ExecuteOutput, ExecuteInput>(async ({ input, signal }) => {
  const rpc = getRpc(input.network);
  const horizon = getHorizon(input.network);
  const tree = input.tree;
  const stop = eitherSignal(signal, input.interrupt);
  const submitClassic = createClassicSubmitter(horizon, input.network.passphrase);
  const finalNode = tree.allNodes.get(FINAL_CLASSIC_TX_NODE_ID);
  const landed = (): readonly PhaseReceipt[] => (finalNode ? landedPhasesOf(finalNode) : []);

  if (input.signedBundleXdr) {
    return submitBundle(input, input.signedBundleXdr, submitClassic, horizon);
  }

  const notes: string[] = [];
  input.onProgress({ kind: "submitting", message: "Executing demolition plan…" });
  try {
    await executePlanTreeOnChain(
      {
        publicKey: input.publicKey,
        tree,
        onNodeUpdate: () => input.onNodeTick(),
        onNote: (text) => notes.push(text),
      },
      {
        network: input.network,
        connector: input.connector,
        horizon,
        submitClassic,
        submitSoroban: createSorobanSubmitter(rpc, input.network.passphrase),
        // rebuild each soroban node from fresh state right before signing
        rebuildSorobanNode: async (node, pk) => {
          const fresh = await rpc.getLatestLedger();
          await rebuildSorobanNodeTransaction(node, pk, {
            rpc,
            horizon,
            network: input.network,
            currentLedger: fresh.sequence,
            fetchSourceAccount: (p) => horizon.loadAccount(p),
          });
        },
        // re-run soroban discovery at merge time and refuse if any position remains
        reprobeSorobanPositions: (pk, net) => new DirectContractProvider().getPositions(pk, net),
        lookupClassicTransaction: (hash, maxTime) =>
          lookupHorizonTransaction(horizon, hash, maxTime),
        lookupSorobanTransaction: (hash, maxTime) => lookupRpcTransaction(rpc, hash, maxTime),
        mediatorFlow: mediatorFlowControl(input, horizon),
        findAccountMerge: (pk) => findLandedMerge(horizon, pk),
        signal: stop,
      },
    );
  } catch (err) {
    const message = errorMessage(err);
    input.onProgress({ kind: "blocked", message });
    return {
      result: { ok: false, errors: [message] },
      tree,
      failureKind: classifyFailure(err),
      notes,
      landedPhases: landed(),
    };
  }

  const mergedTxHash = finalNode?.executed?.txHash;
  // the merge did not land: a dependency was not done when the merge's turn came
  if (finalNode !== undefined && finalNode.status !== "confirmed") {
    const reason =
      finalNode.error ??
      "the account merge did not run because a step it depends on did not complete.";
    input.onProgress({ kind: "blocked", message: `Merge did not complete: ${reason}` });
    return {
      result: { ok: false, errors: [reason] },
      tree,
      failureKind: "unknown",
      notes,
      landedPhases: landed(),
    };
  }
  // an exchange close is done only once the forward out of the mediator landed;
  // until then the balance sits in the mediator and success would be false
  const forwardNode = tree.allNodes.get(MEDIATOR_FORWARD_NODE_ID);
  const forwardTxHash = forwardNode?.executed?.txHash;
  if (forwardNode !== undefined && (forwardNode.status !== "confirmed" || !forwardTxHash)) {
    const reason =
      "Your account was merged into the temporary exchange-forward account, but the forward to " +
      `the exchange has not landed${forwardNode.error ? `: ${forwardNode.error}` : "."} Retry resumes it.`;
    input.onProgress({ kind: "blocked", message: reason });
    return {
      result: { ok: false, errors: [reason], ...(mergedTxHash ? { mergedTxHash } : {}) },
      tree,
      failureKind: "forward_pending",
      notes,
      landedPhases: landed(),
    };
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
    tree,
    notes,
    landedPhases: landed(),
  };
});

// a multisig close arrives as one transaction signed to threshold in the
// signatures step. it is submitted as-is (rebuilding would void the signatures)
// and only the merge step is marked with its receipt.
async function submitBundle(
  input: ExecuteInput,
  signedBundleXdr: string,
  submitClassic: (xdr: string) => Promise<ConfirmationReceipt>,
  horizon: ReturnType<typeof getHorizon>,
): Promise<ExecuteOutput> {
  const tree = input.tree;
  const fail = (message: string, failureKind: FailureKind): ExecuteOutput => {
    input.onProgress({ kind: "blocked", message });
    return {
      result: { ok: false, errors: [message] },
      tree,
      failureKind,
      notes: [],
      landedPhases: [],
    };
  };
  input.onProgress({ kind: "submitting", message: "Submitting the signed close…" });

  // the bundle carries only classic operations; a plan with any soroban step or
  // the forward was not what everyone signed, whatever that step's status
  const stray = bundleStray(tree);
  if (stray) {
    return fail(
      `Refusing to submit: the plan contains a '${stray.kind}' step, which can't be part of a single signed transaction. Close this account with all signers present instead.`,
      "not_mergeable",
    );
  }
  const finalNode = tree.allNodes.get(FINAL_CLASSIC_TX_NODE_ID);
  if (finalNode === undefined) {
    return fail("Refusing to submit: the plan has no merge step.", "not_mergeable");
  }

  let receipt: ConfirmationReceipt;
  try {
    // an earlier submission of this bundle may have landed with its reply lost
    const signed = TransactionBuilder.fromXdr(signedBundleXdr, input.network.passphrase);
    const earlier = await lookupHorizonTransaction(horizon, txHashHex(signed), txMaxTime(signed));
    receipt =
      earlier.status === "success"
        ? { txHash: txHashHex(signed), ledger: earlier.ledger }
        : await submitClassic(signedBundleXdr);
  } catch (err) {
    // a refused bundle (stale sequence, expired timebounds, bad auth, a failed
    // operation) will be refused again: the signatures must be collected anew
    const kind = err instanceof SubmitRejectedError ? "bundle_stale" : classifyFailure(err);
    return fail(errorMessage(err), kind);
  }
  finalNode.status = "confirmed";
  finalNode.executed = receipt;
  input.onNodeTick();
  input.onProgress({ kind: "complete", message: "Demolition complete.", txHash: receipt.txHash });
  return {
    result: { ok: true, errors: [], mergedTxHash: receipt.txHash },
    tree,
    notes: [],
    landedPhases: [receipt],
  };
}
