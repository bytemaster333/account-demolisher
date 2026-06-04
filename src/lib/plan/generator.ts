// pure plan generator: audit + positions + allowances -> deterministic PlanTree.

import type { AccountAudit, AssetIdentifier, AuditBalance } from "@/lib/types/account";
import type { BatchOptions, ClassicBatch, ClassicMemo } from "@/lib/types/plan";
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
  // allowance pairs opted in for revocation, keyed `${contractId}|${spender}`.
  readonly selectedAllowances?: readonly string[];
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly memo?: ClassicMemo;
  // fallback address if the CEX rejects the deposit.
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

  // blend repays, one node per (pool, asset) with amount > 0.
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

  // fxdao debt payments, one per vault with debt > 0.
  const fxDebtIdsByDenom = new Map<string, string>();
  for (const vault of positions.fxdao) {
    if (vault.debt <= 0n) continue;
    const id = makeId("fxdao-pay-debt", vault.denomination);
    nodes.push({
      id,
      kind: "PayFxDAODebt",
      dependencies: [],
      status: "pending",
      description: `Pay FxDAO ${vault.denomination} debt of ${vault.debt.toString()}`,
      metadata: {
        kind: "PayFxDAODebt",
        vaultDenomination: vault.denomination,
        debt: vault.debt,
      },
    });
    fxDebtIdsByDenom.set(vault.denomination, id);
  }

  // blend collateral + supply withdraws; depend on the pool's repays.
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

  // aquarius LPs, independent.
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

  // soroswap LPs, independent.
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

  // fxdao redeem depends on the same vault's debt payment.
  for (const vault of positions.fxdao) {
    if (vault.collateral <= 0n) continue;
    const id = makeId("fxdao-redeem", vault.denomination);
    const debtId = fxDebtIdsByDenom.get(vault.denomination);
    nodes.push({
      id,
      kind: "RedeemFxDAO",
      dependencies: debtId ? [debtId] : [],
      status: "pending",
      description: `Redeem FxDAO ${vault.denomination} collateral (${vault.collateral.toString()} stroops)`,
      metadata: {
        kind: "RedeemFxDAO",
        vaultDenomination: vault.denomination,
        collateral: vault.collateral,
        debt: vault.debt,
      },
    });
  }

  // blend emissions, one per pool, after its withdraws.
  for (const pool of positions.blend) {
    const withdraws = blendWithdrawIdsByPool.get(pool.poolId) ?? [];
    // skip pools with no activity; the simulator drops zero-emission claims.
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

  // aquarius rewards, one per withdrawn pool.
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

  // sep-41 conversions; reserved for a future positions stream.
  for (const balance of audit.balances) {
    if (!isConvertibleSEP41(balance)) continue;
    const id = makeId("convert", balanceKey(balance.asset));
    nodes.push({
      id,
      kind: "ConvertSorobanToXLM",
      dependencies: [],
      status: "pending",
      description: `Convert ${balance.amount} ${describeAsset(balance.asset)} to XLM`,
      metadata: {
        kind: "ConvertSorobanToXLM",
        asset: balance.asset,
        amount: parseAmountToStroops(balance.amount),
      },
    });
  }

  // backstop queue: only emitted when an extended position type is passed in.

  // final classic transaction
  const finalId = "final-classic-tx";
  const batchOptions: BatchOptions = {
    destination,
    useMediator,
    ...(useMediator && opts.mediatorPublicKey ? { mediatorPublicKey: opts.mediatorPublicKey } : {}),
    ...(opts.selectedClaimableBalanceIds
      ? { claimableBalanceIds: opts.selectedClaimableBalanceIds }
      : {}),
    ...(opts.userFallbackAddress ? { userFallbackAddress: opts.userFallbackAddress } : {}),
    ...(opts.memo ? { memo: opts.memo } : {}),
  };
  const batches: readonly ClassicBatch[] = batchClassicDemolition(audit, batchOptions);

  // every soroban node must complete before the merge.
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
        ultimateDestination: destination,
        ...(opts.memo?.type === "text" ? { memo: opts.memo.value } : {}),
      },
    });
  }

  // keep maps alive for future edge additions and topology inspection.
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

// stable id format: lower-cased parts joined with ":".
function makeId(...parts: readonly string[]): string {
  return parts.map((p) => p.toLowerCase()).join(":");
}

function shortAddr(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function balanceKey(asset: AssetIdentifier): string {
  switch (asset.kind) {
    case "native":
      return "native";
    case "credit":
      return `${asset.code}:${asset.issuer}`;
    case "liquidity_pool_shares":
      return `pool:${asset.poolId}`;
  }
}

function describeAsset(asset: AssetIdentifier): string {
  switch (asset.kind) {
    case "native":
      return "XLM";
    case "credit":
      return asset.code;
    case "liquidity_pool_shares":
      return `LP:${asset.poolId.slice(0, 6)}`;
  }
}

// no-op placeholder until a richer source surfaces sep-41 contract balances.
function isConvertibleSEP41(_balance: AuditBalance): boolean {
  return false;
}

// decimal string -> stroops bigint (7 decimals).
function parseAmountToStroops(s: string): bigint {
  const trimmed = s.trim();
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [intPart = "0", fracPart = ""] = abs.split(".");
  const fracPadded = (fracPart + "0000000").slice(0, 7);
  const result = BigInt(intPart) * 10_000_000n + BigInt(fracPadded || "0");
  return negative ? -result : result;
}

export type {
  BlendPositionSummary,
  AquariusPositionSummary,
  SoroswapPositionSummary,
  FxDAOPositionSummary,
};
