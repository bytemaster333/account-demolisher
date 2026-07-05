// pure plan generator: audit + positions + allowances -> deterministic PlanTree

import type { AccountAudit } from "@/lib/types/account";
import type { BatchOptions, ClassicBatch, ClassicMemo, PathResultRef } from "@/lib/types/plan";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type {
  AquariusPositionSummary,
  BlendPositionSummary,
  FxDAOPositionSummary,
  ProtocolPositions,
  SoroswapPositionSummary,
} from "@/lib/adapters/positions/interface";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";

import { buildPlanTree, type PlanNode, type PlanTree } from "./tree";

export interface GeneratePlanOptions {
  readonly useMediator?: boolean;
  readonly mediatorPublicKey?: string;
  // one-time token that authorizes signing the ephemeral mediator's forward;
  // minted together with mediatorPublicKey
  readonly flowToken?: string;
  // allowance pairs opted in for revocation, keyed `${contractId}|${spender}`
  readonly selectedAllowances?: readonly string[];
  readonly selectedClaimableBalanceIds?: readonly string[];
  // resolved XLM-conversion paths per credit asset (pathKey -> path)
  readonly paths?: ReadonlyMap<string, PathResultRef>;
  // credit assets the user consented to return to their issuer when un-routable
  readonly returnToIssuerAssetKeys?: readonly string[];
  // un-routable credit assets the user chose to send to the merge destination
  readonly sendToDestinationAssetKeys?: readonly string[];
  readonly memo?: ClassicMemo;
  // fallback address if the CEX rejects the deposit
  readonly userFallbackAddress?: string;
}

export function generatePlan(
  audit: AccountAudit,
  positions: ProtocolPositions,
  allowances: readonly AllowanceRecord[],
  destination: string,
  opts: GeneratePlanOptions = {},
): PlanTree {
  const useMediator = opts.useMediator === true;
  if (useMediator && !opts.mediatorPublicKey) {
    throw new Error("generatePlan: useMediator=true requires opts.mediatorPublicKey");
  }
  if (useMediator && !opts.flowToken) {
    // the merge funds + drains an ephemeral mediator; without the flow token the
    // forward out of it can never be co-signed, stranding the funds
    throw new Error("generatePlan: useMediator=true requires opts.flowToken");
  }

  const selectedAllowances = new Set(opts.selectedAllowances ?? []);
  const nodes: PlanNode[] = [];

  // allowance revocations
  const revokeIds: string[] = [];
  for (const allowance of allowances) {
    const key = `${allowance.contractId}|${allowance.spender}`;
    if (!selectedAllowances.has(key)) continue;
    if (allowance.expired) continue;
    if (allowance.amount === 0n) continue;
    const id = makeId("revoke", allowance.contractId, allowance.spender);
    nodes.push({
      id,
      kind: "RevokeAllowance",
      dependencies: [],
      status: "pending",
      description: `Revoke allowance: ${shortAddr(allowance.spender)} on ${shortAddr(allowance.contractId)}`,
      metadata: {
        kind: "RevokeAllowance",
        contractId: allowance.contractId,
        spender: allowance.spender,
      },
    });
    revokeIds.push(id);
  }

  // blend repays, one node per (pool, asset) with amount > 0
  const blendRepayIdsByPool = new Map<string, string[]>();
  for (const pool of positions.blend) {
    const ids: string[] = [];
    for (const [asset, amount] of pool.liabilities) {
      if (amount <= 0n) continue;
      const id = makeId("blend-repay", pool.poolId, asset);
      nodes.push({
        id,
        kind: "RepayBlend",
        dependencies: [],
        status: "pending",
        description: `Repay ${amount.toString()} of ${shortAddr(asset)} on Blend pool ${shortAddr(pool.poolId)}`,
        metadata: {
          kind: "RepayBlend",
          poolId: pool.poolId,
          asset,
          amount,
        },
      });
      ids.push(id);
    }
    if (ids.length > 0) blendRepayIdsByPool.set(pool.poolId, ids);
  }

  // fxdao debt payments, one per vault with debt > 0. A full pay_debt closes the
  // vault and reclaims its collateral in one call. No follow-up node needed.
  for (const vault of positions.fxdao) {
    if (vault.debt <= 0n) continue;
    const id = makeId("fxdao-pay-debt", vault.denomination);
    nodes.push({
      id,
      kind: "PayFxDAODebt",
      dependencies: [],
      status: "pending",
      // a full pay_debt closes the vault AND releases its collateral in one call
      description: `Close FxDAO ${vault.denomination} vault (repay ${vault.debt.toString()}, reclaim ${vault.collateral.toString()} collateral)`,
      metadata: {
        kind: "PayFxDAODebt",
        vaultDenomination: vault.denomination,
        debt: vault.debt,
      },
    });
  }

  // blend collateral + supply withdraws; depend on the pool's repays
  const blendWithdrawIdsByPool = new Map<string, string[]>();
  for (const pool of positions.blend) {
    const ids: string[] = [];
    const deps = blendRepayIdsByPool.get(pool.poolId) ?? [];
    for (const [asset, amount] of pool.collateral) {
      if (amount <= 0n) continue;
      const id = makeId("blend-withdraw-collateral", pool.poolId, asset);
      nodes.push(withdrawBlendNode(id, pool.poolId, asset, "collateral", deps));
      ids.push(id);
    }
    for (const [asset, amount] of pool.supply) {
      if (amount <= 0n) continue;
      const id = makeId("blend-withdraw-supply", pool.poolId, asset);
      nodes.push(withdrawBlendNode(id, pool.poolId, asset, "supply", deps));
      ids.push(id);
    }
    if (ids.length > 0) blendWithdrawIdsByPool.set(pool.poolId, ids);
  }

  // aquarius LPs, independent
  const aquariusWithdrawIdsByPool = new Map<string, string>();
  for (const pool of positions.aquarius) {
    if (pool.shareBalance <= 0n) continue;
    const id = makeId("aquarius-withdraw", pool.poolIndex);
    nodes.push({
      id,
      kind: "WithdrawAquarius",
      dependencies: [],
      status: "pending",
      description: `Withdraw ${pool.shareBalance.toString()} shares from Aquarius pool ${pool.poolIndex.slice(0, 8)}...`,
      metadata: {
        kind: "WithdrawAquarius",
        poolIndex: pool.poolIndex,
        shareAmount: pool.shareBalance,
        tokens: pool.tokens,
      },
    });
    aquariusWithdrawIdsByPool.set(pool.poolIndex, id);
  }

  // soroswap LPs, independent
  const soroswapWithdrawIds: string[] = [];
  for (const pos of positions.soroswap) {
    if (pos.shareBalance <= 0n) continue;
    const id = makeId("soroswap-withdraw", pos.pair.tokenA, pos.pair.tokenB);
    nodes.push({
      id,
      kind: "WithdrawSoroswapLp",
      dependencies: [],
      status: "pending",
      description: `Withdraw Soroswap LP ${shortAddr(pos.pair.tokenA)}/${shortAddr(pos.pair.tokenB)}`,
      metadata: {
        kind: "WithdrawSoroswapLp",
        tokenA: pos.pair.tokenA,
        tokenB: pos.pair.tokenB,
        shareBalance: pos.shareBalance,
      },
    });
    soroswapWithdrawIds.push(id);
  }

  // (No separate FxDAO redeem step: pay_debt above already reclaims the vault's
  // collateral. redeem() is an unrelated protocol op that burns stablecoin
  // against the lowest vault in the list, not a way to close your own vault.)

  // blend emissions, one per pool, after its withdraws
  for (const pool of positions.blend) {
    const withdraws = blendWithdrawIdsByPool.get(pool.poolId) ?? [];
    // skip pools with no activity; the simulator drops zero-emission claims
    if (
      (pool.liabilities.size === 0 || allValuesZero(pool.liabilities)) &&
      (pool.collateral.size === 0 || allValuesZero(pool.collateral)) &&
      (pool.supply.size === 0 || allValuesZero(pool.supply))
    ) {
      continue;
    }
    const id = makeId("blend-claim", pool.poolId);
    nodes.push({
      id,
      kind: "ClaimBlendEmissions",
      dependencies: withdraws,
      status: "pending",
      description: `Claim Blend emissions for pool ${shortAddr(pool.poolId)}`,
      metadata: {
        kind: "ClaimBlendEmissions",
        poolId: pool.poolId,
        reserveTokenIds: [],
      },
    });
  }

  // aquarius rewards, one per withdrawn pool
  for (const [poolIndex, withdrawId] of aquariusWithdrawIdsByPool) {
    const id = makeId("aquarius-claim", poolIndex);
    nodes.push({
      id,
      kind: "ClaimAquariusRewards",
      dependencies: [withdrawId],
      status: "pending",
      description: `Claim Aquarius rewards for pool ${poolIndex.slice(0, 8)}...`,
      metadata: {
        kind: "ClaimAquariusRewards",
        poolIndex,
      },
    });
  }

  // classical credit balances are converted to xlm by path_payment_strict_send

  // backstop queue: only emitted when an extended position type is passed in

  // final classic transaction
  const finalId = "final-classic-tx";
  const batchOptions: BatchOptions = {
    destination,
    useMediator,
    ...(useMediator && opts.mediatorPublicKey ? { mediatorPublicKey: opts.mediatorPublicKey } : {}),
    ...(opts.selectedClaimableBalanceIds
      ? { claimableBalanceIds: opts.selectedClaimableBalanceIds }
      : {}),
    ...(opts.returnToIssuerAssetKeys
      ? { returnToIssuerAssetKeys: opts.returnToIssuerAssetKeys }
      : {}),
    ...(opts.sendToDestinationAssetKeys
      ? { sendToDestinationAssetKeys: opts.sendToDestinationAssetKeys }
      : {}),
    ...(opts.userFallbackAddress ? { userFallbackAddress: opts.userFallbackAddress } : {}),
    ...(opts.memo ? { memo: opts.memo } : {}),
  };
  const batches: readonly ClassicBatch[] = batchClassicDemolition(audit, batchOptions, opts.paths);

  // every soroban node must complete before the merge
  const sorobanDeps: string[] = nodes
    .filter((n) => n.kind !== "FinalClassicTx" && n.kind !== "MediatorForward")
    .map((n) => n.id);

  nodes.push({
    id: finalId,
    kind: "FinalClassicTx",
    dependencies: sorobanDeps,
    status: "pending",
    description: `Final classic batch (${batches.length} tx, merge to ${shortAddr(useMediator ? (opts.mediatorPublicKey ?? destination) : destination)})`,
    metadata: {
      kind: "FinalClassicTx",
      batches,
      destination,
      useMediator,
      ...(opts.selectedClaimableBalanceIds
        ? { claimableBalanceIds: opts.selectedClaimableBalanceIds }
        : {}),
      ...(opts.returnToIssuerAssetKeys
        ? { returnToIssuerAssetKeys: opts.returnToIssuerAssetKeys }
        : {}),
      ...(opts.userFallbackAddress ? { userFallbackAddress: opts.userFallbackAddress } : {}),
      ...(useMediator && opts.mediatorPublicKey
        ? { mediatorPublicKey: opts.mediatorPublicKey }
        : {}),
    },
  });

  // optional mediator forward
  if (useMediator && opts.mediatorPublicKey) {
    nodes.push({
      id: "mediator-forward",
      kind: "MediatorForward",
      dependencies: [finalId],
      status: "pending",
      description: `Forward closed-out funds from mediator to ${shortAddr(destination)}`,
      metadata: {
        kind: "MediatorForward",
        mediatorPublicKey: opts.mediatorPublicKey,
        flowToken: opts.flowToken ?? "",
        ultimateDestination: destination,
        ...(opts.memo?.type === "text" ? { memo: opts.memo.value } : {}),
      },
    });
  }

  // keep maps alive for future edge additions and topology inspection
  void revokeIds;
  void soroswapWithdrawIds;

  return buildPlanTree(nodes);
}

function withdrawBlendNode(
  id: string,
  poolId: string,
  asset: string,
  bucket: "collateral" | "supply",
  deps: readonly string[],
): PlanNode {
  return {
    id,
    kind: "WithdrawBlend",
    dependencies: deps,
    status: "pending",
    description:
      bucket === "collateral"
        ? `Withdraw Blend collateral ${shortAddr(asset)} from pool ${shortAddr(poolId)}`
        : `Withdraw Blend supply ${shortAddr(asset)} from pool ${shortAddr(poolId)}`,
    metadata: {
      kind: "WithdrawBlend",
      poolId,
      asset,
      bucket,
    },
  };
}

function allValuesZero(m: ReadonlyMap<string, bigint>): boolean {
  for (const v of m.values()) if (v !== 0n) return false;
  return true;
}

// stable id format: lower-cased parts joined with ":"
function makeId(...parts: readonly string[]): string {
  return parts.map((p) => p.toLowerCase()).join(":");
}

function shortAddr(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

export type {
  BlendPositionSummary,
  AquariusPositionSummary,
  SoroswapPositionSummary,
  FxDAOPositionSummary,
};
