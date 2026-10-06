// plan-tree data model: a DAG of PlanNodes with explicit dependency edges
// construction is pure; simulation lives in simulator.ts

import type { rpc as RpcNS, Transaction, xdr as XdrNS } from "@stellar/stellar-sdk";

import type { AssetIdentifier } from "@/lib/types/account";
import type { ClassicBatch, ClassicMemo, ReferenceQuote } from "@/lib/types/plan";

// soroban nodes carry the full simulation response; classic nodes
// just confirm well-formedness and emit envelope xdr
export type SimulationOutcome =
  | {
      readonly kind: "soroban";
      readonly retval: XdrNS.ScVal | null;
      readonly minResourceFee: string;
      // the fee the built transaction authorizes: inclusion bid plus resource fee
      readonly maxFee: string;
      readonly transactionData: RpcNS.Api.SimulateTransactionSuccessResponse["transactionData"];
      readonly latestLedger: number;
      readonly auth: readonly XdrNS.SorobanAuthorizationEntry[];
      readonly restorePreambleRequired: boolean;
    }
  | {
      readonly kind: "classic";
      // envelope of the first transaction; the counts and fee cover every batch
      readonly xdr: string;
      readonly operationCount: number;
      readonly estimatedFee: string;
      readonly transactionCount: number;
    };

export type PlanNodeStatus =
  "pending" | "simulated" | "signed" | "submitted" | "confirmed" | "failed" | "skipped";

export type PlanNodeKind =
  | "RevokeAllowance"
  | "RepayBlend"
  | "WithdrawBlend"
  | "WithdrawAquarius"
  | "WithdrawSoroswapLp"
  | "ClaimBlendEmissions"
  | "ClaimAquariusRewards"
  | "ConvertSorobanToXLM"
  | "TransferAsIs"
  | "BackstopQueue"
  | "FinalClassicTx"
  | "MediatorForward";

export interface PlanNodeBase {
  readonly id: string;
  readonly kind: PlanNodeKind;
  // ids that must reach confirmed or skipped before this runs
  readonly dependencies: readonly string[];
  readonly description: string;
  status: PlanNodeStatus;
  simulated?: SimulationOutcome;
  executed?: { readonly txHash: string; readonly ledger: number };
  error?: string;
  // set by preview hydration when a step that runs after other steps could not
  // be built against today's state; it is built at execute time once they land
  deferred?: { readonly after: readonly string[]; readonly reason: string };
}

export interface RevokeAllowanceMetadata {
  readonly kind: "RevokeAllowance";
  readonly contractId: string;
  readonly spender: string;
  // pre-built unsigned approve(..., 0, currentLedger) tx
  readonly transaction?: Transaction;
}

export interface RepayBlendMetadata {
  readonly kind: "RepayBlend";
  readonly poolId: string;
  readonly asset: string;
  readonly amount: bigint;
  readonly transaction?: Transaction;
}

export interface WithdrawBlendMetadata {
  readonly kind: "WithdrawBlend";
  readonly poolId: string;
  readonly asset: string;
  readonly bucket: "collateral" | "supply";
  readonly transaction?: Transaction;
}

export interface WithdrawAquariusMetadata {
  readonly kind: "WithdrawAquarius";
  readonly poolIndex: string;
  readonly shareAmount: bigint;
  // ordered reserve token contract addresses required by the withdraw call
  readonly tokens: readonly string[];
  readonly transaction?: Transaction;
}

export interface WithdrawSoroswapLpMetadata {
  readonly kind: "WithdrawSoroswapLp";
  readonly tokenA: string;
  readonly tokenB: string;
  readonly shareBalance: bigint;
  readonly transaction?: Transaction;
}

export interface ClaimBlendEmissionsMetadata {
  readonly kind: "ClaimBlendEmissions";
  readonly poolId: string;
  readonly reserveTokenIds: readonly number[];
  readonly transaction?: Transaction;
}

export interface ClaimAquariusRewardsMetadata {
  readonly kind: "ClaimAquariusRewards";
  readonly poolIndex: string;
  // pool_index is only unique within a token set, so the pool is (tokens, index)
  readonly tokens: readonly string[];
  readonly transaction?: Transaction;
}

export interface ConvertSorobanToXLMMetadata {
  readonly kind: "ConvertSorobanToXLM";
  readonly asset: AssetIdentifier;
  // smallest-units amount. Hydration replaces it with the live balance, so tokens
  // credited by earlier exits are swapped too.
  readonly amount: bigint;
  // the user confirmed selling although the swap is over the price-impact cap or
  // could not be priced against a reference trade
  readonly priceImpactAccepted?: boolean;
  // what the built swap expects, the floor it signs, and the measured impact
  readonly quote?: {
    readonly expectedOut: bigint;
    readonly minOut: bigint;
    readonly priceImpactBps: number | null;
  };
  readonly transaction?: Transaction;
}

export interface TransferAsIsMetadata {
  readonly kind: "TransferAsIs";
  readonly asset: AssetIdentifier;
  // smallest-units amount; hydration replaces it with the live balance
  readonly amount: bigint;
  readonly destination: string;
  readonly transaction?: Transaction;
}

export interface BackstopQueueMetadata {
  readonly kind: "BackstopQueue";
  readonly poolId: string;
  readonly shares: bigint;
  readonly queueEndsAt: Date;
  readonly transaction?: Transaction;
}

export interface FinalClassicTxMetadata {
  readonly kind: "FinalClassicTx";
  readonly batches: readonly ClassicBatch[];
  readonly destination: string;
  readonly useMediator: boolean;
  // forwarded into batchClassicDemolition during execute-time re-batching. The
  // generator always sets the reviewed claim list, so an execute-time audit can
  // only claim balances the user saw.
  readonly claimableBalanceIds?: readonly string[];
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly sendToDestinationAssetKeys?: readonly string[];
  readonly acceptedPriceImpactAssetKeys?: readonly string[];
  // reference quotes shown at review, per pathKey; a re-quote far below them is
  // refused rather than signed
  readonly reviewedReferenceQuotes?: Readonly<Record<string, ReferenceQuote>>;
  readonly userFallbackAddress?: string;
  readonly mediatorPublicKey?: string;
  // deposit memo for a DIRECT (non-mediator) merge to a memo-required destination.
  // MUST be re-applied during execute-time re-batching or the signed merge drops
  // it; the batcher only attaches it to a non-mediator final batch (a mediator
  // close carries its memo on the forward hop instead).
  readonly memo?: ClassicMemo;
}

export interface MediatorForwardMetadata {
  readonly kind: "MediatorForward";
  readonly mediatorPublicKey: string;
  // one-time token authorizing the sign route to co-sign the forward out of
  // this flow's ephemeral mediator account
  readonly flowToken: string;
  readonly ultimateDestination: string;
  // the user's CEX deposit memo (full type + value). This forward is the ONLY
  // hop that reaches the exchange, so it must carry the memo verbatim; a numeric
  // ("id") or hash memo dropped here means the deposit isn't credited.
  readonly memo?: ClassicMemo;
}

export interface RevokeAllowanceNode extends PlanNodeBase {
  readonly kind: "RevokeAllowance";
  readonly metadata: RevokeAllowanceMetadata;
}
export interface RepayBlendNode extends PlanNodeBase {
  readonly kind: "RepayBlend";
  readonly metadata: RepayBlendMetadata;
}
export interface WithdrawBlendNode extends PlanNodeBase {
  readonly kind: "WithdrawBlend";
  readonly metadata: WithdrawBlendMetadata;
}
export interface WithdrawAquariusNode extends PlanNodeBase {
  readonly kind: "WithdrawAquarius";
  readonly metadata: WithdrawAquariusMetadata;
}
export interface WithdrawSoroswapLpNode extends PlanNodeBase {
  readonly kind: "WithdrawSoroswapLp";
  readonly metadata: WithdrawSoroswapLpMetadata;
}
export interface ClaimBlendEmissionsNode extends PlanNodeBase {
  readonly kind: "ClaimBlendEmissions";
  readonly metadata: ClaimBlendEmissionsMetadata;
}
export interface ClaimAquariusRewardsNode extends PlanNodeBase {
  readonly kind: "ClaimAquariusRewards";
  readonly metadata: ClaimAquariusRewardsMetadata;
}
export interface ConvertSorobanToXLMNode extends PlanNodeBase {
  readonly kind: "ConvertSorobanToXLM";
  readonly metadata: ConvertSorobanToXLMMetadata;
}
export interface TransferAsIsNode extends PlanNodeBase {
  readonly kind: "TransferAsIs";
  readonly metadata: TransferAsIsMetadata;
}
export interface BackstopQueueNode extends PlanNodeBase {
  readonly kind: "BackstopQueue";
  readonly metadata: BackstopQueueMetadata;
}
export interface FinalClassicTxNode extends PlanNodeBase {
  readonly kind: "FinalClassicTx";
  readonly metadata: FinalClassicTxMetadata;
}
export interface MediatorForwardNode extends PlanNodeBase {
  readonly kind: "MediatorForward";
  readonly metadata: MediatorForwardMetadata;
}

export type PlanNode =
  | RevokeAllowanceNode
  | RepayBlendNode
  | WithdrawBlendNode
  | WithdrawAquariusNode
  | WithdrawSoroswapLpNode
  | ClaimBlendEmissionsNode
  | ClaimAquariusRewardsNode
  | ConvertSorobanToXLMNode
  | TransferAsIsNode
  | BackstopQueueNode
  | FinalClassicTxNode
  | MediatorForwardNode;

// rootNodes have zero in-edges; allNodes is the flat id -> node index
export interface PlanTree {
  readonly rootNodes: readonly PlanNode[];
  readonly allNodes: ReadonlyMap<string, PlanNode>;
}

// throws on duplicate ids, missing deps, or cycles
export function buildPlanTree(nodes: readonly PlanNode[]): PlanTree {
  const allNodes = new Map<string, PlanNode>();
  for (const node of nodes) {
    if (allNodes.has(node.id)) {
      throw new Error(`buildPlanTree: duplicate node id "${node.id}"`);
    }
    allNodes.set(node.id, node);
  }
  for (const node of nodes) {
    for (const depId of node.dependencies) {
      if (!allNodes.has(depId)) {
        throw new Error(`buildPlanTree: node "${node.id}" depends on missing node id "${depId}"`);
      }
    }
  }
  assertAcyclic(nodes, allNodes);

  const rootNodes = nodes.filter((n) => n.dependencies.length === 0);
  return { rootNodes, allNodes };
}

// iterative DFS that throws on the first cycle with the offending path
function assertAcyclic(nodes: readonly PlanNode[], allNodes: ReadonlyMap<string, PlanNode>): void {
  type Color = "white" | "gray" | "black";
  const color = new Map<string, Color>();
  for (const node of nodes) color.set(node.id, "white");

  for (const start of nodes) {
    if (color.get(start.id) !== "white") continue;

    const stack: { nodeId: string; depIndex: number; path: readonly string[] }[] = [
      { nodeId: start.id, depIndex: 0, path: [start.id] },
    ];
    color.set(start.id, "gray");

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const node = allNodes.get(top.nodeId)!;
      if (top.depIndex >= node.dependencies.length) {
        color.set(node.id, "black");
        stack.pop();
        continue;
      }
      const nextDep = node.dependencies[top.depIndex]!;
      stack[stack.length - 1] = { ...top, depIndex: top.depIndex + 1 };
      const depColor = color.get(nextDep);
      if (depColor === "gray") {
        const cycleStart = top.path.indexOf(nextDep);
        const cyclePath =
          cycleStart >= 0 ? [...top.path.slice(cycleStart), nextDep] : [...top.path, nextDep];
        throw new Error(
          `buildPlanTree: cycle detected in plan dependencies: ${cyclePath.join(" -> ")}`,
        );
      }
      if (depColor === "white") {
        color.set(nextDep, "gray");
        stack.push({
          nodeId: nextDep,
          depIndex: 0,
          path: [...top.path, nextDep],
        });
      }
    }
  }
}

// stable topo order: parents before children, deterministic on input
export function topologicalOrder(tree: PlanTree): readonly PlanNode[] {
  const inDegree = new Map<string, number>();
  const order: PlanNode[] = [];
  for (const node of tree.allNodes.values()) {
    inDegree.set(node.id, node.dependencies.length);
  }

  const queue: PlanNode[] = [];
  for (const node of tree.allNodes.values()) {
    if ((inDegree.get(node.id) ?? 0) === 0) queue.push(node);
  }

  const children = new Map<string, string[]>();
  for (const node of tree.allNodes.values()) {
    for (const depId of node.dependencies) {
      const arr = children.get(depId) ?? [];
      arr.push(node.id);
      children.set(depId, arr);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    const kids = children.get(current.id) ?? [];
    for (const childId of kids) {
      const next = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, next);
      if (next === 0) {
        const childNode = tree.allNodes.get(childId);
        if (childNode) queue.push(childNode);
      }
    }
  }

  if (order.length !== tree.allNodes.size) {
    throw new Error(
      `topologicalOrder: cycle detected at runtime: produced ${order.length} of ${tree.allNodes.size} nodes`,
    );
  }
  return order;
}

// contract ids of the tokens the plan's DeFi exits pay into the account, in plan
// order. A balance of one of these still there at the merge (and not a classic
// asset's SAC) is the user's exit proceeds and would be deleted with the
// account, so the merge guard re-reads them. Airdropped held tokens are not
// listed: their sweep is best-effort and must not be able to block the close.
export function planExitPayoutTokens(tree: PlanTree): readonly string[] {
  const out = new Set<string>();
  for (const node of tree.allNodes.values()) {
    switch (node.kind) {
      case "WithdrawAquarius":
        for (const token of node.metadata.tokens) out.add(token);
        break;
      case "WithdrawSoroswapLp":
        out.add(node.metadata.tokenA);
        out.add(node.metadata.tokenB);
        break;
      case "WithdrawBlend":
        out.add(node.metadata.asset);
        break;
      default:
        break;
    }
  }
  return [...out];
}

// true for soroban-touching kinds; routes simulation in simulator.ts
export function isSorobanNode(node: PlanNode): boolean {
  switch (node.kind) {
    case "RevokeAllowance":
    case "RepayBlend":
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
    case "ConvertSorobanToXLM":
    case "BackstopQueue":
    case "TransferAsIs":
      return true;
    case "FinalClassicTx":
    case "MediatorForward":
      return false;
  }
}
