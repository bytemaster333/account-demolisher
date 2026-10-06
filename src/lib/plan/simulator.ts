// per-node simulator: routes soroban nodes to rpc simulate and classic nodes
// to a well-formedness build pass

import { Account, BASE_FEE, type Horizon, type Transaction, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { FORWARD_OPERATION_COUNT, MAX_FORWARD_FEE } from "@/lib/mediator/forward-terms";
import { simulate, type SimulationResult } from "@/lib/soroban/simulate";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import type { ClassicBatch } from "@/lib/types/plan";

import type { PlanNode, SimulationOutcome } from "./tree";
import { isSorobanNode, nodeTransaction } from "./tree";

export interface SimulationDeps {
  readonly server: rpc.Server;
  readonly network: NetworkConfig;
  // the account being closed; source of the final classic merge, used to build
  // the batch envelope in-memory for validation.
  readonly userPublicKey: string;
  readonly fetchSourceAccount: (publicKey: string) => Promise<Horizon.AccountResponse>;
  readonly simulateFn?: (server: rpc.Server, tx: Transaction) => Promise<SimulationResult>;
  // per-operation fee the classic batches are priced at. The executor bids a
  // surge-aware base, so callers that know it pass it; otherwise the network
  // minimum (BASE_FEE) is used and the figure is a lower bound.
  readonly classicFeePerOp?: number;
}

// simulate one node. throws on structural issues or simulation failure
export async function simulateNode(
  node: PlanNode,
  deps: SimulationDeps,
): Promise<SimulationOutcome> {
  if (isSorobanNode(node)) {
    return simulateSorobanNode(node, deps);
  }
  return simulateClassicNode(node, deps);
}

async function simulateSorobanNode(
  node: PlanNode,
  deps: SimulationDeps,
): Promise<SimulationOutcome> {
  const tx = nodeTransaction(node);
  if (!tx) {
    throw new NodeNotBuiltError(node);
  }
  if (node.kind === "AddBlndTrustline") {
    // a classic change_trust: soroban rpc has nothing to simulate, so the built
    // envelope itself is the check
    return {
      kind: "classic",
      xdr: tx.toEnvelope().toXdr("base64"),
      operationCount: tx.operations.length,
      estimatedFee: tx.fee,
      transactionCount: 1,
    };
  }
  const simulateFn = deps.simulateFn ?? simulate;
  const result = await simulateFn(deps.server, tx);
  if (!result.ok) {
    throw new SimulationFailedError(
      `simulateNode: ${node.kind} node "${node.id}" simulation failed: ${result.error}`,
      node.id,
      result.error,
    );
  }
  return {
    kind: "soroban",
    retval: result.retval,
    minResourceFee: result.minResourceFee,
    maxFee: tx.fee,
    transactionData: result.transactionData,
    latestLedger: result.latestLedger,
    auth: result.auth,
    restorePreambleRequired: result.restorePreamble !== undefined,
  };
}

async function simulateClassicNode(
  node: PlanNode,
  deps: SimulationDeps,
): Promise<SimulationOutcome> {
  if (node.kind === "FinalClassicTx" || node.kind === "ClassicUnwind") {
    return simulateClassicBatches(node, node.metadata.batches, deps);
  }
  if (node.kind === "MediatorForward") {
    return simulateMediatorForward(node, deps);
  }
  // defensive: catches future union expansions
  throw new Error(
    `simulateNode: classic branch missing handler for kind "${(node as PlanNode).kind}"`,
  );
}

async function simulateClassicBatches(
  node: PlanNode,
  batches: readonly ClassicBatch[],
  deps: SimulationDeps,
): Promise<SimulationOutcome> {
  if (batches.length === 0) {
    throw new Error(`simulateNode: ${node.kind} "${node.id}" has zero batches; cannot validate`);
  }
  // In-memory validation: actually BUILD each batch's classic envelope. A synthetic
  // account (sequence 0) suffices because this is structural well-formedness, not a
  // submit: buildClassicTransaction throws on an empty/malformed op set or a total
  // fee over the u32 ceiling, so a doomed classic close surfaces at preview time
  // instead of xdr:"" hiding it. The executor rebuilds against live account state.
  const source = new Account(deps.userPublicKey, "0") as unknown as Horizon.AccountResponse;
  const feePerOp = deps.classicFeePerOp ?? Number.parseInt(BASE_FEE, 10);
  const built: Transaction[] = [];
  try {
    for (const batch of batches) {
      const tx = buildClassicTransaction(batch, source, deps.network, feePerOp).transaction;
      if ("innerTransaction" in tx) {
        throw new Error("buildClassicTransaction returned a fee-bump transaction unexpectedly");
      }
      built.push(tx);
    }
  } catch (err) {
    const msg = errorMessage(err);
    throw new SimulationFailedError(
      `simulateNode: ${node.kind} "${node.id}" failed in-memory validation: ${msg}`,
      node.id,
      msg,
    );
  }
  // a multi-batch close signs and pays for every batch, so the counts and the fee
  // cover all of them
  return {
    kind: "classic",
    xdr: built[0]!.toEnvelope().toXdr("base64"),
    operationCount: built.reduce((n, tx) => n + tx.operations.length, 0),
    estimatedFee: built.reduce((sum, tx) => sum + BigInt(tx.fee), 0n).toString(),
    transactionCount: built.length,
  };
}

async function simulateMediatorForward(
  node: Extract<PlanNode, { kind: "MediatorForward" }>,
  _deps: SimulationDeps,
): Promise<SimulationOutcome> {
  // the forward is one payment plus one accountMerge out of the mediator. the
  // browser builds it against the mediator's live sequence once the merge has
  // landed and the server only co-signs it, so there is no envelope to show yet;
  // the metadata it needs is checked here so a malformed node fails at preview,
  // not mid-execution.
  const md = node.metadata;
  if (!md.mediatorPublicKey || !md.ultimateDestination || !md.flowToken) {
    throw new SimulationFailedError(
      `simulateNode: MediatorForward "${node.id}" is missing mediatorPublicKey / ultimateDestination / flowToken`,
      node.id,
      "malformed-mediator-forward",
    );
  }
  // its bid starts from recent fee_charged stats (the mode while ledgers have
  // room, p90 under surge), triples on an insufficient-fee or expired attempt and
  // stops at MAX_FORWARD_FEE, so that ceiling is the most it can cost
  return {
    kind: "classic",
    xdr: "",
    operationCount: FORWARD_OPERATION_COUNT,
    estimatedFee: MAX_FORWARD_FEE.toString(),
    transactionCount: 1,
  };
}

// a soroban node reached simulation without a built transaction. When hydration
// deferred it (it runs after steps that haven't happened yet), it isn't broken:
// it is built at execute time, and `deferred` carries why the preview build failed.
export class NodeNotBuiltError extends Error {
  readonly nodeId: string;
  readonly deferred: PlanNode["deferred"];
  constructor(node: PlanNode) {
    super(
      node.deferred
        ? `simulateNode: Soroban node "${node.id}" (${node.kind}) has no built transaction yet; ` +
            `it is built after ${node.deferred.after.join(", ")} confirm (${node.deferred.reason})`
        : `simulateNode: Soroban node "${node.id}" (${node.kind}) has no built transaction; ` +
            "attach metadata.transaction before simulating",
    );
    this.name = "NodeNotBuiltError";
    this.nodeId = node.id;
    this.deferred = node.deferred;
  }
}

export class SimulationFailedError extends Error {
  readonly nodeId: string;
  readonly upstreamError: string;
  constructor(message: string, nodeId: string, upstreamError: string) {
    super(message);
    this.name = "SimulationFailedError";
    this.nodeId = nodeId;
    this.upstreamError = upstreamError;
  }
}
