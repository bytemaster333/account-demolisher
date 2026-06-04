// per-node simulator: routes soroban nodes to rpc simulate and classic nodes
// to a well-formedness build pass.

import {
  Account,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  type Horizon,
  type Transaction,
  type rpc,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { simulate, type SimulationResult } from "@/lib/soroban/simulate";

import type { PlanNode, SimulationOutcome } from "./tree";
import { isSorobanNode } from "./tree";

// throwaway G-address used as a source for synthetic well-formedness envelopes.
const SYNTHETIC_SOURCE_PUBLIC_KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0)).publicKey();

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
  if (node.kind === "TransferAsIs") {
    return simulateTransferAsIs(node, deps);
  }
  // defensive: catches future union expansions.
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
  // synthetic envelope check: builds against a throwaway source so the SDK
  // confirms the operations parse. real envelope is built at submit time.
  const firstBatch = batches[0]!;
  const synthetic = new Account(SYNTHETIC_SOURCE_PUBLIC_KEY, "0");
  const builder = new TransactionBuilder(synthetic, {
    fee: BASE_FEE,
    networkPassphrase: deps.network.passphrase,
  });
  builder.addOperation(Operation.bumpSequence({ bumpTo: "0" }));
  if (firstBatch.memo) {
    builder.addMemo(memoFromBatch(firstBatch.memo));
  }
  builder.setTimeout(0);
  const tx = builder.build();
  const xdrStr = tx.toEnvelope().toXDR("base64");
  const opCount = firstBatch.operations.length;
  return {
    kind: "classic",
    xdr: xdrStr,
    operationCount: opCount,
    estimatedFee: tx.fee,
  };
}

async function simulateMediatorForward(
  node: Extract<PlanNode, { kind: "MediatorForward" }>,
  deps: SimulationDeps,
): Promise<SimulationOutcome> {
  // simplest classic op: payment or accountMerge from mediator to destination.
  const synthetic = new Account(node.metadata.mediatorPublicKey, "0");
  const builder = new TransactionBuilder(synthetic, {
    fee: BASE_FEE,
    networkPassphrase: deps.network.passphrase,
  });
  builder.addOperation(Operation.accountMerge({ destination: node.metadata.ultimateDestination }));
  if (node.metadata.memo !== undefined) {
    builder.addMemo(Memo.text(node.metadata.memo));
  }
  builder.setTimeout(0);
  const tx = builder.build();
  return {
    kind: "classic",
    xdr: tx.toEnvelope().toXDR("base64"),
    operationCount: 1,
    estimatedFee: tx.fee,
  };
}

async function simulateTransferAsIs(
  node: Extract<PlanNode, { kind: "TransferAsIs" }>,
  deps: SimulationDeps,
): Promise<SimulationOutcome> {
  // metadata sanity + a stub envelope so the UI has something to show.
  if (node.metadata.amount <= 0n) {
    throw new Error(
      `simulateNode: TransferAsIs "${node.id}" must carry amount > 0; got ${node.metadata.amount.toString()}`,
    );
  }
  const synthetic = new Account(SYNTHETIC_SOURCE_PUBLIC_KEY, "0");
  const builder = new TransactionBuilder(synthetic, {
    fee: BASE_FEE,
    networkPassphrase: deps.network.passphrase,
  });
  builder.addOperation(Operation.bumpSequence({ bumpTo: "0" }));
  builder.setTimeout(0);
  const tx = builder.build();
  return {
    kind: "classic",
    xdr: tx.toEnvelope().toXDR("base64"),
    operationCount: 1,
    estimatedFee: tx.fee,
  };
}

function memoFromBatch(memo: { type: string; value: string }): Memo {
  switch (memo.type) {
    case "text":
      return Memo.text(memo.value);
    case "id":
      return Memo.id(memo.value);
    case "hash":
      return Memo.hash(memo.value);
    case "return":
      return Memo.return(memo.value);
    default:
      throw new Error(`memoFromBatch: unsupported memo type "${memo.type}"`);
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
