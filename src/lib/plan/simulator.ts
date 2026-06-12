// per-node simulator: routes soroban nodes to rpc simulate and classic nodes
// to a well-formedness build pass.

import { BASE_FEE, type Horizon, type Transaction, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { simulate, type SimulationResult } from "@/lib/soroban/simulate";

import type { PlanNode, SimulationOutcome } from "./tree";
import { isSorobanNode } from "./tree";

export interface SimulationDeps {
  readonly server: rpc.Server;
  readonly network: NetworkConfig;
  readonly fetchSourceAccount: (publicKey: string) => Promise<Horizon.AccountResponse>;
  readonly simulateFn?: (server: rpc.Server, tx: Transaction) => Promise<SimulationResult>;
}

// simulate one node. throws on structural issues or simulation failure.
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
  const tx = getSorobanTransaction(node);
  if (!tx) {
    throw new Error(
      `simulateNode: Soroban node "${node.id}" (${node.kind}) has no built transaction; ` +
        "attach metadata.transaction before simulating",
    );
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
    transactionData: result.transactionData,
    latestLedger: result.latestLedger,
    auth: result.auth,
    restorePreambleRequired: result.restorePreamble !== undefined,
  };
}

// returns undefined until hydration attaches the tx.
function getSorobanTransaction(node: PlanNode): Transaction | undefined {
  switch (node.kind) {
    case "RevokeAllowance":
      return node.metadata.transaction;
    case "RepayBlend":
      return node.metadata.transaction;
    case "PayFxDAODebt":
      return node.metadata.transaction;
    case "WithdrawBlend":
      return node.metadata.transaction;
    case "WithdrawAquarius":
      return node.metadata.transaction;
    case "WithdrawSoroswapLp":
      return node.metadata.transaction;
    case "RedeemFxDAO":
      return node.metadata.transaction;
    case "ClaimBlendEmissions":
      return node.metadata.transaction;
    case "ClaimAquariusRewards":
      return node.metadata.transaction;
    case "ConvertSorobanToXLM":
      return node.metadata.transaction;
    case "BackstopQueue":
      return node.metadata.transaction;
    case "TransferAsIs":
      return node.metadata.transaction;
    case "FinalClassicTx":
    case "MediatorForward":
      return undefined;
  }
}

async function simulateClassicNode(
  node: PlanNode,
  deps: SimulationDeps,
): Promise<SimulationOutcome> {
  if (node.kind === "FinalClassicTx") {
    return simulateFinalClassicTx(node, deps);
  }
  if (node.kind === "MediatorForward") {
    return simulateMediatorForward(node, deps);
  }
  // defensive: catches future union expansions.
  throw new Error(
    `simulateNode: classic branch missing handler for kind "${(node as PlanNode).kind}"`,
  );
}

async function simulateFinalClassicTx(
  node: Extract<PlanNode, { kind: "FinalClassicTx" }>,
  _deps: SimulationDeps,
): Promise<SimulationOutcome> {
  const batches = node.metadata.batches;
  if (batches.length === 0) {
    throw new Error(`simulateNode: FinalClassicTx "${node.id}" has zero batches; cannot validate`);
  }
  const firstBatch = batches[0]!;
  const opCount = firstBatch.operations.length;
  // the real envelope is built at submit time using the live account state.
  // we report what we actually know: op count and the per-op fee floor.
  return {
    kind: "classic",
    xdr: "",
    operationCount: opCount,
    estimatedFee: (Number.parseInt(BASE_FEE, 10) * opCount).toString(),
  };
}

async function simulateMediatorForward(
  _node: Extract<PlanNode, { kind: "MediatorForward" }>,
  _deps: SimulationDeps,
): Promise<SimulationOutcome> {
  // the mediator forward is one payment + one accountMerge built at submit time
  // against the mediator's live sequence number.
  return {
    kind: "classic",
    xdr: "",
    operationCount: 2,
    estimatedFee: (Number.parseInt(BASE_FEE, 10) * 2).toString(),
  };
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
