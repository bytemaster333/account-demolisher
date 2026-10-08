// execute: runs the reviewed tree on chain, or submits a collected multisig
// bundle as-is

import { fromPromise } from "xstate";
import { TransactionBuilder, type Horizon, type Transaction } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { preparedUnlocksAt, type PlanTree, type PreparePlan } from "@/lib/plan/tree";
import { rebuildSorobanNodeTransaction } from "@/lib/plan/hydration";
import { reissueMediatorFlow, startMediatorFlow } from "@/lib/mediator/client";
import { FINAL_CLASSIC_TX_NODE_ID, MEDIATOR_FORWARD_NODE_ID } from "@/lib/mediator/refresh";
import {
  latestPendingForward,
  removePendingForward,
  savePendingForward,
  tryRunWithCloseLock,
} from "@/lib/mediator/pending-flow";
import {
  feeBumpBundle,
  loadBundleFreshness,
  type SignerSnapshot,
} from "@/lib/multisig/bundle-freshness";
import { thresholdForClose, trimToThreshold } from "@/lib/multisig/signing-request";
import {
  BEST_EFFORT_KINDS,
  DEPENDENCY_SKIP_PREFIX,
  executePlanTreeOnChain,
  MAX_PER_OP_FEE,
  surgeFeeBase,
  type ConfirmationReceipt,
  type LandedMerge,
  type MediatorFlowControl,
  type TxLookup,
} from "@/lib/orchestrator/executor";
import {
  classifyFailure,
  CloseFailure,
  rejectionCodes,
  SubmitRejectedError,
  type FailureKind,
} from "@/lib/orchestrator/failures";
import { landedClassicPhases, type PhaseReceipt } from "@/lib/orchestrator/journal";
import {
  createClassicSubmitter,
  createSorobanSubmitter,
  isNotFoundError,
  txHashHex,
  txMaxTime,
} from "@/lib/orchestrator/submit";
import { withTimeout } from "@/lib/with-timeout";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { getRpc } from "@/lib/soroban/rpc-client";
import { balance as readTokenBalance } from "@/lib/soroban/sep41";
import { formatXlm } from "@/lib/soroban/fee-cap";
import type { DemolishProgressEvent, DemolishResult } from "@/lib/types/plan";
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import { openPositionCount, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { Connector } from "@/lib/wallet/connector";

export interface ExecuteInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly connector: Connector;
  // tree from the preview pass; execute runs against this so the ui shows
  // the same steps the user reviewed
  readonly tree: PlanTree;
  // present for a multisig close: the fully-signed bundled transaction to submit
  // as-is, instead of re-building/signing the tree node by node, and the signer
  // set the relay checked its signatures against
  readonly bundle?: { readonly signedXdr: string; readonly snapshot: SignerSnapshot };
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
  // set when the run only prepared the close: every step ran, nothing merged
  readonly prepared?: PreparePlan;
}

// the re-check of defi positions right before a merge must not hang the close
const REPROBE_TIMEOUT_MS = 60_000;

// mediator flow wiring for the executor: mint through the sign route with the
// terms the forward will use, record the flow in the pending-forward store before
// the funding batch is signed, and remove only this flow's record once its
// forward landed
function mediatorFlowControl(
  input: ExecuteInput,
  horizon: ReturnType<typeof getHorizon>,
): MediatorFlowControl {
  const key = (mediatorPublicKey: string) => ({
    networkId: input.network.id,
    publicKey: input.publicKey,
    mediatorPublicKey,
  });
  return {
    async mint(destination, memo) {
      const flow = await startMediatorFlow(destination, {
        network: input.network.id,
        memo: memo ?? null,
      });
      if (!flow.ok) throw flowFailure(flow);
      return { mediatorPublicKey: flow.mediatorPublicKey, flowToken: flow.flowToken };
    },
    persist(flow) {
      // a mediator close never runs without its recovery record: a storage
      // failure stops the close before the funding batch is signed
      try {
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
      } catch (err) {
        throw new CloseFailure(
          "unknown",
          `${errorMessage(err)}. Nothing was signed: without that record a stuck forward could not be resumed.`,
          { cause: err },
        );
      }
    },
    previous() {
      const p = latestPendingForward(input.publicKey, input.network.id);
      if (p === null) return null;
      return {
        mediatorPublicKey: p.mediatorPublicKey,
        flowToken: p.flowToken,
        ultimateDestination: p.ultimateDestination,
        ...(p.memo ? { memo: p.memo } : {}),
        issuedAt: p.savedAt,
      };
    },
    forwarded(mediatorPublicKey) {
      removePendingForward(key(mediatorPublicKey));
    },
    async reissue(flowToken) {
      const before = latestPendingForward(input.publicKey, input.network.id);
      const fresh = await reissueMediatorFlow(flowToken);
      if (!fresh.ok) throw flowFailure(fresh);
      // a renewal names the same temporary account; anything else is not this flow
      const expected = before?.flowToken === flowToken ? before.mediatorPublicKey : null;
      if (expected !== null && fresh.mediatorPublicKey !== expected) {
        throw new CloseFailure(
          "unknown",
          `The exchange-forward service renewed the flow for a different temporary account ` +
            `(${fresh.mediatorPublicKey}, expected ${expected}); nothing was signed.`,
        );
      }
      return { flowToken: fresh.flowToken, mediatorPublicKey: fresh.mediatorPublicKey };
    },
    async findForward(mediatorPublicKey, destination) {
      return findMediatorForward(horizon, mediatorPublicKey, destination);
    },
  };
}

function flowFailure(flow: { readonly code: string; readonly reason: string }): CloseFailure {
  const kind: FailureKind =
    flow.code === "NETWORK_ERROR" || flow.code === "RATE_LIMITED" ? "network" : "unknown";
  return new CloseFailure(
    kind,
    `Could not start the exchange-forward flow (${flow.code}): ${flow.reason}`,
  );
}

// the merge that emptied the mediator. the forward ends with account_merge
// into the destination, so that is what a landed forward looks like; a merge
// anywhere else is not this close's forward.
async function findMediatorForward(
  horizon: ReturnType<typeof getHorizon>,
  mediatorPublicKey: string,
  destination: string,
): Promise<ConfirmationReceipt | null> {
  const page = await horizon
    .operations()
    .forAccount(mediatorPublicKey)
    .order("desc")
    .limit(20)
    .call();
  const merge = page.records.find(
    (r) =>
      String(r.type) === "account_merge" &&
      r.transaction_successful &&
      r.source_account === mediatorPublicKey,
  );
  if (merge === undefined || !("into" in merge) || typeof merge.into !== "string") return null;
  if (merge.into !== destination) {
    throw new CloseFailure(
      "not_mergeable",
      `The temporary account ${mediatorPublicKey} was emptied into ${merge.into}, not into your ` +
        `destination, by transaction ${merge.transaction_hash}. Contact the operator with that hash.`,
    );
  }
  const tx = await horizon.transactions().transaction(merge.transaction_hash).call();
  return { txHash: merge.transaction_hash, ledger: tx.ledger_attr };
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

// the merge-time re-check of defi positions, bounded so a stalled rpc stops the
// close with a message instead of hanging it
async function reprobePositions(
  publicKey: string,
  network: NetworkConfig,
): Promise<ProtocolPositions> {
  try {
    return await withTimeout(
      "reprobeSorobanPositions",
      new DirectContractProvider().getPositions(publicKey, network),
      REPROBE_TIMEOUT_MS,
    );
  } catch (err) {
    throw new CloseFailure(
      "network",
      `account_merge blocked: could not re-check DeFi positions before the merge (${errorMessage(err)}). ` +
        "Retry once the network is responsive.",
      { cause: err },
    );
  }
}

// one close per account and network runs in this tab at a time. a restarted
// actor (a remount while the first run still signs) is refused rather than
// started a second time over the same tree.
const inFlight = new Set<string>();

export const executeActor = fromPromise<ExecuteOutput, ExecuteInput>(async ({ input, signal }) => {
  const runKey = `${input.network.id}:${input.publicKey}`;
  if (inFlight.has(runKey)) {
    const message =
      "A close for this account is still running in this tab. Wait for it to finish, then retry.";
    input.onProgress({ kind: "blocked", message });
    return {
      result: { ok: false, errors: [message] },
      tree: input.tree,
      failureKind: "close_running",
      notes: [],
      landedPhases: [],
    };
  }
  inFlight.add(runKey);
  try {
    // the lock tells other tabs a close for this account is running, so they
    // don't offer to resume or dismiss its recovery record meanwhile. a close in
    // another tab holds it; waiting would hang this tab with no word, and
    // stopping can't end a lock wait, so the lock is only taken when it is free
    const attempt = await tryRunWithCloseLock(input.publicKey, () => runClose(input, signal));
    if (!attempt.ran) {
      const message =
        "A close for this account is running in another tab. Let it finish there, then retry here.";
      input.onProgress({ kind: "blocked", message });
      return {
        result: { ok: false, errors: [message] },
        tree: input.tree,
        failureKind: "close_running",
        notes: [],
        landedPhases: [],
      };
    }
    return attempt.value;
  } finally {
    inFlight.delete(runKey);
  }
});

async function runClose(input: ExecuteInput, signal: AbortSignal): Promise<ExecuteOutput> {
  const rpc = getRpc(input.network);
  const horizon = getHorizon(input.network);
  const tree = input.tree;
  const stop = eitherSignal(signal, input.interrupt);
  const submitClassic = createClassicSubmitter(horizon, input.network.passphrase);
  const finalNode = tree.allNodes.get(FINAL_CLASSIC_TX_NODE_ID);
  const landed = (): readonly PhaseReceipt[] => landedClassicPhases(tree);

  if (input.bundle) {
    return submitBundle(input, input.bundle, submitClassic, horizon, stop);
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
        reprobeSorobanPositions: reprobePositions,
        readTokenBalance: (contractId, holder) =>
          readTokenBalance(rpc, contractId, holder, holder, input.network),
        onSigning: (node, fee) =>
          input.onProgress({
            kind: "submitting",
            message: `Sign "${node.description}": network fee up to ${formatXlm(fee)} XLM.`,
          }),
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

  // a plan that only prepares the close has no merge: it is done once every
  // step ran, and the account stays open until the backstop queue unlocks
  if (tree.prepareOnly !== undefined) {
    return prepared(input, tree, tree.prepareOnly, notes, landed());
  }
  if (finalNode === undefined) {
    const reason = "The plan has no merge step, so the account was not closed.";
    input.onProgress({ kind: "blocked", message: reason });
    return {
      result: { ok: false, errors: [reason] },
      tree,
      failureKind: "unknown",
      notes,
      landedPhases: landed(),
    };
  }

  const mergedTxHash = finalNode.executed?.txHash;
  // the merge did not land: a dependency was not done when the merge's turn came
  if (finalNode.status !== "confirmed") {
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
}

// the end of a prepare-only run. every step must have run (a best-effort step
// skipped on purpose counts); anything else is reported as not prepared.
function prepared(
  input: ExecuteInput,
  tree: PlanTree,
  plan: PreparePlan,
  notes: readonly string[],
  landedPhases: readonly PhaseReceipt[],
): ExecuteOutput {
  const open = [...tree.allNodes.values()].filter(
    (n) =>
      n.status !== "confirmed" &&
      !(
        n.status === "skipped" &&
        BEST_EFFORT_KINDS.has(n.kind) &&
        n.error?.startsWith(DEPENDENCY_SKIP_PREFIX) !== true
      ),
  );
  if (open.length > 0) {
    const reason =
      `The close was not prepared: ${open.map((n) => `"${n.description}"`).join(", ")} did not ` +
      "complete.";
    input.onProgress({ kind: "blocked", message: reason });
    return {
      result: { ok: false, errors: [reason] },
      tree,
      failureKind: "unknown",
      notes,
      landedPhases,
    };
  }
  // the review dated a new queue from review time; its lock starts when it
  // lands, and the queue built right before signing read that unlock
  const unlocksAt = preparedUnlocksAt(tree) ?? plan.unlocksAt;
  // the run is complete, the close is not: no merge hash, and the message says so
  input.onProgress({
    kind: "complete",
    message:
      "Preparation complete. The account stays open. Come back after " +
      `${unlocksAt.toISOString().slice(0, 10)} to withdraw the backstop and finish closing.`,
  });
  return {
    result: { ok: true, errors: [] },
    tree,
    prepared: { ...plan, unlocksAt },
    notes,
    landedPhases,
  };
}

// a multisig close arrives as one transaction signed in the signatures step. it
// is checked against the account as it is now, trimmed to the signatures core
// will use, and submitted; rebuilding it would void the signatures. only the
// merge step is marked with its receipt.
async function submitBundle(
  input: ExecuteInput,
  bundle: NonNullable<ExecuteInput["bundle"]>,
  submitClassic: (xdr: string) => Promise<ConfirmationReceipt>,
  horizon: ReturnType<typeof getHorizon>,
  stop: AbortSignal,
): Promise<ExecuteOutput> {
  const tree = input.tree;
  const passphrase = input.network.passphrase;
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

  // the bundle carries only the classic close; any other step in the plan, in
  // whatever status, is something the bundle can't do
  const stray = [...tree.allNodes.values()].find((n) => n.kind !== "FinalClassicTx");
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
  const receiptOf = (receipt: ConfirmationReceipt): ExecuteOutput => {
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
  };

  let signed: Transaction;
  try {
    const decoded = TransactionBuilder.fromXdr(bundle.signedXdr, passphrase);
    if ("innerTransaction" in decoded) {
      return fail(
        "Refusing to submit: the signed close is a fee bump, not the close itself.",
        "not_mergeable",
      );
    }
    signed = decoded;
    // an earlier submission of this bundle may have landed with its reply lost
    const earlier = await lookupHorizonTransaction(horizon, txHashHex(signed), txMaxTime(signed));
    if (earlier.status === "success") {
      return receiptOf({ txHash: txHashHex(signed), ledger: earlier.ledger });
    }
  } catch (err) {
    return fail(errorMessage(err), classifyFailure(err));
  }
  if (stop.aborted) {
    return fail("The close was stopped before the signed close was submitted.", "interrupted");
  }

  // a defi position opened since the request was built would be merged around
  let positions: ProtocolPositions;
  try {
    positions = await reprobePositions(input.publicKey, input.network);
  } catch (err) {
    return fail(errorMessage(err), classifyFailure(err));
  }
  if (openPositionCount(positions) > 0 || positions.errors.length > 0) {
    const detail =
      positions.errors.length > 0
        ? positions.errors.map((e) => `${e.protocol}: ${e.message}`).join("; ")
        : `${openPositionCount(positions)} open`;
    return fail(
      `Refusing to submit: the account has DeFi positions the signed close does not unwind (${detail}). Close them, then build a new signing request.`,
      positions.errors.length > 0 ? "network" : "bundle_stale",
    );
  }

  // the bundle was signed against one snapshot of the account; anything that
  // moved since (sequence, balances, offers, signers) makes it fail on chain
  let live: Horizon.AccountResponse;
  let xdrToSubmit: string;
  try {
    const fresh = await loadBundleFreshness(horizon, bundle.signedXdr, passphrase, bundle.snapshot);
    if (!fresh.ok) {
      return fail(
        `The account changed since the signing request was built, so the signed close would fail: ${fresh.reasons.join(" ")} Build a new signing request.`,
        "bundle_stale",
      );
    }
    live = await horizon.loadAccount(input.publicKey);
    // core refuses an envelope carrying a signature it does not need
    // (tx_bad_auth_extra), so only what the current signer set uses is sent
    const signers = live.signers
      .filter((s) => s.type === "ed25519_public_key" && s.weight > 0)
      .map((s) => ({ key: s.key, weight: s.weight }));
    const required = thresholdForClose({
      low: live.thresholds.low_threshold,
      medium: live.thresholds.med_threshold,
      high: live.thresholds.high_threshold,
    });
    const trimmed = trimToThreshold(bundle.signedXdr, passphrase, signers, required);
    if (!trimmed.met) {
      return fail(
        `Not enough signatures for the account's current signers: the close needs weight ${required} and the collected signatures add up to ${trimmed.weight}. Collect the missing signatures in a new signing request.`,
        "bundle_stale",
      );
    }
    xdrToSubmit = trimmed.xdr;
  } catch (err) {
    return fail(errorMessage(err), classifyFailure(err));
  }

  try {
    return receiptOf(await submitClassic(xdrToSubmit));
  } catch (err) {
    if (rejectionCodes(err)?.transaction !== "tx_insufficient_fee") {
      // a refused bundle (stale sequence, expired timebounds, bad auth, a failed
      // operation) will be refused again: the signatures must be collected anew
      const kind = err instanceof SubmitRejectedError ? "bundle_stale" : classifyFailure(err);
      return fail(errorMessage(err), kind);
    }
  }

  // the bid in the signed close is too low for the network right now. the
  // signatures cover the inner transaction only, so the connected wallet can
  // pay a higher fee around it without anyone signing again.
  if (stop.aborted) {
    return fail("The close was stopped before a higher fee was offered.", "interrupted");
  }
  try {
    const feeSource = await input.connector.getPublicKey();
    const innerPerOp = BigInt(signed.fee) / BigInt(signed.operations.length);
    const bid = BigInt(await surgeFeeBase(horizon));
    const perOp = [bid, innerPerOp * 2n].reduce((a, b) => (a > b ? a : b));
    const capped = perOp > BigInt(MAX_PER_OP_FEE) ? BigInt(MAX_PER_OP_FEE) : perOp;
    const bump = feeBumpBundle(xdrToSubmit, passphrase, feeSource, capped.toString());
    input.onProgress({
      kind: "submitting",
      message: `The network asks a higher fee. Sign a fee bump of up to ${formatXlm(BigInt(bump.fee))} XLM, paid by ${feeSource}.`,
    });
    const paid = await input.connector.signTransaction(bump, passphrase);
    return receiptOf(await submitClassic(paid.signedXdr));
  } catch (err) {
    const kind = err instanceof SubmitRejectedError ? "bundle_stale" : classifyFailure(err);
    return fail(`The fee bump did not land: ${errorMessage(err)}`, kind);
  }
}
