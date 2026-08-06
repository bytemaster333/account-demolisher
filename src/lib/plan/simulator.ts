// per-node simulator: routes soroban nodes to rpc simulate and classic nodes
// to a well-formedness build pass

import { Account, BASE_FEE, type Horizon, type Transaction, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { simulate, type SimulationResult } from "@/lib/soroban/simulate";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";

import type { PlanNode, SimulationOutcome } from "./tree";
import { isSorobanNode } from "./tree";

export interface SimulationDeps {
  readonly server: rpc.Server;
  readonly network: NetworkConfig;
  // the account being closed; source of the final classic merge, used to build
  // the batch envelope in-memory for validation.
  readonly userPublicKey: string;
  readonly fetchSourceAccount: (publicKey: string) => Promise<Horizon.AccountResponse>;
  readonly simulateFn?: (server: rpc.Server, tx: Transaction) => Promise<SimulationResult>;
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

// returns undefined until hydration attaches the tx
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
  // defensive: catches future union expansions
  throw new Error(
    `simulateNode: classic branch missing handler for kind "${(node as PlanNode).kind}"`,
  );
}

async function simulateFinalClassicTx(
  node: Extract<PlanNode, { kind: "FinalClassicTx" }>,
  deps: SimulationDeps,
): Promise<SimulationOutcome> {
  const batches = node.metadata.batches;
  if (batches.length === 0) {
    throw new Error(`simulateNode: FinalClassicTx "${node.id}" has zero batches; cannot validate`);
  }
  // In-memory validation: actually BUILD each batch's classic envelope. A synthetic
  // account (sequence 0) suffices because this is structural well-formedness, not a
  // submit — buildClassicTransaction throws on an empty/malformed op set or a total
  // fee over the u32 ceiling, so a doomed classic close surfaces at preview time
  // instead of xdr:"" hiding it. The executor rebuilds against live account state.
  const source = new Account(deps.userPublicKey, "0") as unknown as Horizon.AccountResponse;
  let firstTx: Transaction | undefined;
  try {
    for (const batch of batches) {
      const built = buildClassicTransaction(batch, source, deps.network).transaction;
      if ("innerTransaction" in built) {
        throw new Error("buildClassicTransaction returned a fee-bump transaction unexpectedly");
      }
      if (firstTx === undefined) firstTx = built;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SimulationFailedError(
      `simulateNode: FinalClassicTx "${node.id}" failed in-memory validation: ${msg}`,
      node.id,
      msg,
    );
  }
  const tx = firstTx!;
  return {
    kind: "classic",
    xdr: tx.toEnvelope().toXDR("base64"), // the real built envelope, not ""
    operationCount: tx.operations.length,
    estimatedFee: tx.fee, // real total fee from the built envelope
  };
}

async function simulateMediatorForward(
  node: Extract<PlanNode, { kind: "MediatorForward" }>,
  _deps: SimulationDeps,
): Promise<SimulationOutcome> {
  // The mediator forward is exactly one payment + one accountMerge, built and
  // signed server-side against the mediator's live sequence at submit time (its
  // envelope can't be reproduced here without the flow token). 2 ops is the fixed,
  // known structure — not a guess — but validate the metadata carries what the
  // forward needs so a malformed node fails at preview, not mid-execution.
  const md = node.metadata;
  if (!md.mediatorPublicKey || !md.ultimateDestination || !md.flowToken) {
    throw new SimulationFailedError(
      `simulateNode: MediatorForward "${node.id}" is missing mediatorPublicKey / ultimateDestination / flowToken`,
      node.id,
      "malformed-mediator-forward",
    );
  }
  const FORWARD_OP_COUNT = 2;
  return {
    kind: "classic",
    xdr: "",
    operationCount: FORWARD_OP_COUNT,
    estimatedFee: (Number.parseInt(BASE_FEE, 10) * FORWARD_OP_COUNT).toString(),
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
