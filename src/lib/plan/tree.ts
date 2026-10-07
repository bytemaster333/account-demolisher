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
  | "ClassicUnwind"
  | "RepayBlend"
  | "WithdrawBlend"
  | "WithdrawAquarius"
  | "WithdrawAquariusConcentrated"
  | "WithdrawSoroswapLp"
  | "AddBlndTrustline"
  | "ClaimBlendEmissions"
  | "ClaimAquariusRewards"
  | "ClaimAquariusConcentratedFees"
  | "ConvertSorobanToXLM"
  | "TransferAsIs"
  | "ClaimBackstopEmissions"
  | "BackstopQueue"
  | "BackstopWithdraw"
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

// a classic phase ahead of the repays: cancels the offers that sell a repay
// asset and withdraws the classic pool shares that hold one, so the asset is
// spendable when the repay pulls it. rebuilt from a fresh audit at execute time
// with buildClassicUnwindBatches(audit, metadata), which only touches the
// reviewed offers and pools.
export interface ClassicUnwindMetadata {
  readonly kind: "ClassicUnwind";
  readonly batches: readonly ClassicBatch[];
  readonly offerIds: readonly string[];
  readonly poolIds: readonly string[];
  // SAC contract ids of the assets the plan repays
  readonly repayAssets: readonly string[];
  // the close's destination, carried on the batches; they pay nothing to it
  readonly destination: string;
}

export interface RepayBlendMetadata {
  readonly kind: "RepayBlend";
  readonly poolId: string;
  readonly asset: string;
  // the debt seen at discovery; every build replaces it with the amount the
  // built transaction repays, which the auth-tree guard checks against
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

// one tick range of an aquarius concentrated position, withdrawn with
// withdraw_position on the pinned pool itself
export interface WithdrawAquariusConcentratedMetadata {
  readonly kind: "WithdrawAquariusConcentrated";
  readonly poolAddress: string;
  // the pool's tokens, in its own order (payouts swept or guarded at the merge)
  readonly tokens: readonly string[];
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly transaction?: Transaction;
}

export interface WithdrawSoroswapLpMetadata {
  readonly kind: "WithdrawSoroswapLp";
  readonly tokenA: string;
  readonly tokenB: string;
  readonly shareBalance: bigint;
  readonly transaction?: Transaction;
}

// change_trust BLND, so the pool emissions claims can pay BLND to the account.
// a classic transaction built and submitted like the soroban steps; the final
// batch converts or removes the line again.
export interface AddBlndTrustlineMetadata {
  readonly kind: "AddBlndTrustline";
  readonly code: "BLND";
  readonly issuer: string;
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
  // set for a concentrated pool, whose rewards are claimed before its ranges
  readonly poolAddress?: string;
  readonly transaction?: Transaction;
}

export interface ClaimAquariusConcentratedFeesMetadata {
  readonly kind: "ClaimAquariusConcentratedFees";
  readonly poolAddress: string;
  readonly tokens: readonly string[];
  readonly transaction?: Transaction;
}

// a swap quote: amountIn along path (token first, XLM last) for expectedOut
export interface SwapQuote {
  readonly amountIn: bigint;
  readonly expectedOut: bigint;
  readonly minOut: bigint;
  readonly priceImpactBps: number | null;
  readonly path: readonly string[];
}

export interface ConvertSorobanToXLMMetadata {
  readonly kind: "ConvertSorobanToXLM";
  readonly asset: AssetIdentifier;
  // smallest-units amount. Hydration replaces it with the live balance, so tokens
  // credited by earlier exits are swapped too.
  readonly amount: bigint;
  // the user confirmed selling although the swap is over the price-impact cap or
  // could not be priced against a reference trade. it only holds for the quote
  // the review showed (reviewedQuote); a rebuild with none falls back to the cap.
  readonly priceImpactAccepted?: boolean;
  // the latest built swap: what it expects, the floor it signs, the impact
  readonly quote?: SwapQuote;
  // the first quote a build produced, the one the review shows. a later rebuild
  // whose rate is worse by more than the slippage tolerance is refused.
  readonly reviewedQuote?: SwapQuote;
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

// claim the accrued backstop BLND ahead of the queue. the backstop deposits it
// into the BLND-USDC comet and credits new shares, which the queue then picks up.
export interface ClaimBackstopEmissionsMetadata {
  readonly kind: "ClaimBackstopEmissions";
  readonly poolId: string;
  // BLND (7 decimals) accrued at discovery, shown when the claim can't run
  readonly accruedEmissions: bigint;
  // the pool's backstop contract. set from discovery or the first build; a build
  // against any other backstop is refused, and the auth-tree guard pins it
  readonly backstopId?: string;
  readonly transaction?: Transaction;
}

export interface BackstopQueueMetadata {
  readonly kind: "BackstopQueue";
  readonly poolId: string;
  // shares seen at discovery; every build replaces them with the shares the
  // built transaction queues
  readonly shares: bigint;
  readonly queueEndsAt: Date;
  // see ClaimBackstopEmissionsMetadata.backstopId
  readonly backstopId?: string;
  readonly transaction?: Transaction;
}

export interface BackstopWithdrawMetadata {
  readonly kind: "BackstopWithdraw";
  readonly poolId: string;
  // unlocked queued shares; every build replaces it with the amount the built
  // transaction withdraws, read on chain
  readonly amount: bigint;
  // the BLND-USDC comet LP token the withdraw pays out
  readonly lpToken: string;
  // see ClaimBackstopEmissionsMetadata.backstopId
  readonly backstopId?: string;
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
  // full-size quotes shown at review, per pathKey; held to the same bound
  readonly reviewedConversionQuotes?: Readonly<Record<string, ReferenceQuote>>;
  readonly mediatorPublicKey?: string;
  // deposit memo for a DIRECT (non-mediator) merge to a memo-required destination.
  // MUST be re-applied during execute-time re-batching or the signed merge drops
  // it; the batcher only attaches it to a non-mediator final batch (a mediator
  // close carries its memo on the forward hop instead).
  readonly memo?: ClassicMemo;
  // whether the reviewed batches carry the on-chain close marker. without it the
  // close still merges but is not counted by close verification.
  readonly closeMarker?: boolean;
}

export interface MediatorForwardMetadata {
  readonly kind: "MediatorForward";
  readonly mediatorPublicKey: string;
  // flow token bound to the destination, network and memo. it authorizes the
  // sign route to co-sign the forward out of this flow's ephemeral mediator,
  // stays usable until it expires and is renewed through /api/mediator/reissue
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
export interface ClassicUnwindNode extends PlanNodeBase {
  readonly kind: "ClassicUnwind";
  readonly metadata: ClassicUnwindMetadata;
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
export interface WithdrawAquariusConcentratedNode extends PlanNodeBase {
  readonly kind: "WithdrawAquariusConcentrated";
  readonly metadata: WithdrawAquariusConcentratedMetadata;
}
export interface WithdrawSoroswapLpNode extends PlanNodeBase {
  readonly kind: "WithdrawSoroswapLp";
  readonly metadata: WithdrawSoroswapLpMetadata;
}
export interface AddBlndTrustlineNode extends PlanNodeBase {
  readonly kind: "AddBlndTrustline";
  readonly metadata: AddBlndTrustlineMetadata;
}
export interface ClaimBlendEmissionsNode extends PlanNodeBase {
  readonly kind: "ClaimBlendEmissions";
  readonly metadata: ClaimBlendEmissionsMetadata;
}
export interface ClaimAquariusRewardsNode extends PlanNodeBase {
  readonly kind: "ClaimAquariusRewards";
  readonly metadata: ClaimAquariusRewardsMetadata;
}
export interface ClaimAquariusConcentratedFeesNode extends PlanNodeBase {
  readonly kind: "ClaimAquariusConcentratedFees";
  readonly metadata: ClaimAquariusConcentratedFeesMetadata;
}
export interface ConvertSorobanToXLMNode extends PlanNodeBase {
  readonly kind: "ConvertSorobanToXLM";
  readonly metadata: ConvertSorobanToXLMMetadata;
}
export interface TransferAsIsNode extends PlanNodeBase {
  readonly kind: "TransferAsIs";
  readonly metadata: TransferAsIsMetadata;
}
export interface ClaimBackstopEmissionsNode extends PlanNodeBase {
  readonly kind: "ClaimBackstopEmissions";
  readonly metadata: ClaimBackstopEmissionsMetadata;
}
export interface BackstopQueueNode extends PlanNodeBase {
  readonly kind: "BackstopQueue";
  readonly metadata: BackstopQueueMetadata;
}
export interface BackstopWithdrawNode extends PlanNodeBase {
  readonly kind: "BackstopWithdraw";
  readonly metadata: BackstopWithdrawMetadata;
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
  | ClassicUnwindNode
  | RepayBlendNode
  | WithdrawBlendNode
  | WithdrawAquariusNode
  | WithdrawAquariusConcentratedNode
  | WithdrawSoroswapLpNode
  | AddBlndTrustlineNode
  | ClaimBlendEmissionsNode
  | ClaimAquariusRewardsNode
  | ClaimAquariusConcentratedFeesNode
  | ConvertSorobanToXLMNode
  | TransferAsIsNode
  | ClaimBackstopEmissionsNode
  | BackstopQueueNode
  | BackstopWithdrawNode
  | FinalClassicTxNode
  | MediatorForwardNode;

// a plan that can't merge yet: a backstop deposit stays locked after it runs,
// so it queues and unwinds now and the close is finished in a later run
export interface PreparePlan {
  // when the last withdrawal the plan leaves locked unlocks. a queue this run
  // creates is dated from the review, but its lock starts when it lands on
  // chain; preparedUnlocksAt re-dates it from the transaction built at execute
  readonly unlocksAt: Date;
  // when the entries queued before this run unlock, if any are still locked:
  // read by discovery, or a full queue period from now when it wasn't
  readonly queuedUnlocksAt?: Date;
  readonly reason: string;
}

// backstop emissions the plan leaves unclaimed, after the user acknowledged it
export interface ForfeitedBackstopEmissions {
  readonly poolId: string;
  readonly accruedEmissions: bigint;
}

// rootNodes have zero in-edges; allNodes is the flat id -> node index
export interface PlanTree {
  readonly rootNodes: readonly PlanNode[];
  readonly allNodes: ReadonlyMap<string, PlanNode>;
  // set when the plan has no merge: see PreparePlan
  readonly prepareOnly?: PreparePlan;
  readonly forfeitedBackstopEmissions?: readonly ForfeitedBackstopEmissions[];
}

export interface PlanTreeExtras {
  readonly prepareOnly?: PreparePlan;
  readonly forfeitedBackstopEmissions?: readonly ForfeitedBackstopEmissions[];
}

// throws on duplicate ids, missing deps, or cycles
export function buildPlanTree(nodes: readonly PlanNode[], extras: PlanTreeExtras = {}): PlanTree {
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
  const hasMerge = nodes.some((n) => n.kind === "FinalClassicTx");
  if (extras.prepareOnly !== undefined && hasMerge) {
    throw new Error("buildPlanTree: a prepare-only plan must not carry the final merge");
  }

  const rootNodes = nodes.filter((n) => n.dependencies.length === 0);
  return {
    rootNodes,
    allNodes,
    ...(extras.prepareOnly !== undefined ? { prepareOnly: extras.prepareOnly } : {}),
    ...(extras.forfeitedBackstopEmissions !== undefined &&
    extras.forfeitedBackstopEmissions.length > 0
      ? { forfeitedBackstopEmissions: extras.forfeitedBackstopEmissions }
      : {}),
  };
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

// when a prepare-only plan's locked withdrawals unlock, from what it built: each
// BackstopQueue carries the unlock of the transaction hydration last built for
// it, which at execute is the one signed, so the date counts from the queue's
// real start rather than the review. undefined for a plan that merges.
export function preparedUnlocksAt(tree: PlanTree): Date | undefined {
  const prepare = tree.prepareOnly;
  if (prepare === undefined) return undefined;
  const queues = [...tree.allNodes.values()].filter(
    (n): n is BackstopQueueNode => n.kind === "BackstopQueue",
  );
  if (queues.length === 0) return prepare.unlocksAt;
  let latest = prepare.queuedUnlocksAt;
  for (const queue of queues) {
    const ends = queue.metadata.queueEndsAt;
    if (latest === undefined || ends > latest) latest = ends;
  }
  return latest;
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
      case "WithdrawAquariusConcentrated":
      case "ClaimAquariusConcentratedFees":
        for (const token of node.metadata.tokens) out.add(token);
        break;
      case "WithdrawSoroswapLp":
        out.add(node.metadata.tokenA);
        out.add(node.metadata.tokenB);
        break;
      case "WithdrawBlend":
        out.add(node.metadata.asset);
        break;
      case "BackstopWithdraw":
        out.add(node.metadata.lpToken);
        break;
      default:
        break;
    }
  }
  return [...out];
}

// true for the kinds that carry their own prebuilt transaction, signed and
// submitted one by one and rebuilt from fresh state before signing: every
// soroban call, plus the BLND change_trust that has to land before the claims.
// false for the classic batches the executor builds itself (ClassicUnwind,
// FinalClassicTx) and the mediator forward.
export function isSorobanNode(node: PlanNode): boolean {
  switch (node.kind) {
    case "RevokeAllowance":
    case "RepayBlend":
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawAquariusConcentrated":
    case "WithdrawSoroswapLp":
    case "AddBlndTrustline":
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
    case "ClaimAquariusConcentratedFees":
    case "ConvertSorobanToXLM":
    case "ClaimBackstopEmissions":
    case "BackstopQueue":
    case "BackstopWithdraw":
    case "TransferAsIs":
      return true;
    case "ClassicUnwind":
    case "FinalClassicTx":
    case "MediatorForward":
      return false;
  }
}

// the node's prebuilt transaction, undefined until hydration attaches one and
// for the classic batches and the forward
export function nodeTransaction(node: PlanNode): Transaction | undefined {
  switch (node.kind) {
    case "ClassicUnwind":
    case "FinalClassicTx":
    case "MediatorForward":
      return undefined;
    default:
      return node.metadata.transaction;
  }
}
