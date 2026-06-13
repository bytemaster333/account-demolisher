// walks the plan tree and attaches an unsigned transaction to every soroban

import { Asset, type Horizon, type Transaction, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import type { BlendUserPositions } from "@/lib/adapters/blend/client";
import { buildExitSequence } from "@/lib/adapters/blend/exit";
import {
  claim as aquariusClaim,
  withdraw as aquariusWithdraw,
} from "@/lib/adapters/aquarius/client";
import { poolIndexHexToBytes } from "@/lib/adapters/aquarius/pools";
import { removeLiquidityByContractIds } from "@/lib/adapters/soroswap/lp";
import { convertToXLM } from "@/lib/adapters/soroswap/aggregator";
import { buildVaultExit } from "@/lib/adapters/fxdao/exit";
import {
  findPrevVaultKey as defaultFindPrevVaultKey,
  type VaultKey,
} from "@/lib/adapters/fxdao/prev-key";
import { getFxDAOVaultsContractId } from "@/lib/adapters/fxdao/contracts";
import { getAllowlistForNetwork } from "@/lib/config/contracts";
import { FXDAO_MAINNET_STABLE_ISSUER } from "@/lib/adapters/fxdao/contracts";
import { buildRevoke } from "@/lib/soroban/allowances";
import { buildTransfer } from "@/lib/soroban/sep41";
import type { AssetIdentifier } from "@/lib/types/account";

import type { PlanNode, PlanTree } from "./tree";
import { topologicalOrder } from "./tree";

export interface HydrationFailure {
  readonly nodeId: string;
  readonly reason: string;
}

export interface HydrationDeps {
  readonly rpc: rpc.Server;
  readonly horizon: Horizon.Server;
  readonly network: NetworkConfig;
  readonly currentLedger: number;
  readonly fetchSourceAccount: (publicKey: string) => Promise<Horizon.AccountResponse>;
  // adapter overrides for tests; prod leaves this undefined
  readonly adapters?: HydrationAdapterOverrides;
}

export interface HydrationAdapterOverrides {
  readonly buildRevoke?: typeof buildRevoke;
  readonly buildExitSequence?: typeof buildExitSequence;
  readonly aquariusWithdraw?: typeof aquariusWithdraw;
  readonly aquariusClaim?: typeof aquariusClaim;
  readonly removeLiquidityByContractIds?: typeof removeLiquidityByContractIds;
  readonly buildVaultExit?: typeof buildVaultExit;
  readonly findPrevVaultKey?: typeof defaultFindPrevVaultKey;
  readonly convertToXLM?: typeof convertToXLM;
  readonly buildTransfer?: typeof buildTransfer;
}

// per-node failures populate `failures[]` and set node.status = "failed";
// only `deps` misuse throws. idempotent: nodes with a transaction are skipped
export async function hydratePlanTransactions(
  tree: PlanTree,
  userPublicKey: string,
  deps: HydrationDeps,
): Promise<{ tree: PlanTree; failures: HydrationFailure[] }> {
  if (typeof userPublicKey !== "string" || userPublicKey.length === 0) {
    throw new TypeError("hydratePlanTransactions: userPublicKey is required");
  }
  if (typeof deps.fetchSourceAccount !== "function") {
    throw new TypeError("hydratePlanTransactions: deps.fetchSourceAccount is required");
  }

  const failures: HydrationFailure[] = [];

  // each builder reads + increments its own sequence copy, so caching is safe
  let sourceAccount: Horizon.AccountResponse | null = null;
  const getSourceAccount = async (): Promise<Horizon.AccountResponse> => {
    if (sourceAccount !== null) return sourceAccount;
    sourceAccount = await deps.fetchSourceAccount(userPublicKey);
    return sourceAccount;
  };

  for (const node of topologicalOrder(tree)) {
    if (nodeHasTransaction(node)) continue;

    // classic-only nodes are constructed by the classic builder at submit time
    if (node.kind === "FinalClassicTx" || node.kind === "MediatorForward") {
      continue;
    }

    try {
      await hydrateNode(node, userPublicKey, deps, getSourceAccount);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ nodeId: node.id, reason });
      node.status = "failed";
      node.error = reason;
    }
  }

  return { tree, failures };
}

async function hydrateNode(
  node: PlanNode,
  userPublicKey: string,
  deps: HydrationDeps,
  getSourceAccount: () => Promise<Horizon.AccountResponse>,
): Promise<void> {
  const a = deps.adapters ?? {};

  switch (node.kind) {
    case "RevokeAllowance": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildRevoke ?? buildRevoke;
      const tx = await fn(
        deps.rpc,
        node.metadata.contractId,
        userPublicKey,
        node.metadata.spender,
        deps.currentLedger,
        deps.network,
        sourceAccount,
      );
      setTransaction(node, tx);
      return;
    }

    case "RepayBlend": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildExitSequence ?? buildExitSequence;
      const position = synthesizeBlendPositionForRepay(node.metadata);
      const steps = await fn(deps.network, position, userPublicKey, sourceAccount);
      const step = steps.find((s) => s.kind === "repay" && s.asset === node.metadata.asset);
      if (!step || step.kind !== "repay") {
        throw new Error(
          `RepayBlend: buildExitSequence did not produce a "repay" step for asset ${node.metadata.asset}`,
        );
      }
      setTransaction(node, step.transaction);
      return;
    }

    case "WithdrawBlend": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildExitSequence ?? buildExitSequence;
      const position = synthesizeBlendPositionForWithdraw(node.metadata);
      const steps = await fn(deps.network, position, userPublicKey, sourceAccount);
      const wantKind =
        node.metadata.bucket === "collateral" ? "withdraw_collateral" : "withdraw_supply";
      const step = steps.find(
        (s) => s.kind === wantKind && (s as { asset?: string }).asset === node.metadata.asset,
      );
      if (!step || (step.kind !== "withdraw_collateral" && step.kind !== "withdraw_supply")) {
        throw new Error(
          `WithdrawBlend: buildExitSequence did not produce a "${wantKind}" step for asset ${node.metadata.asset}`,
        );
      }
      setTransaction(node, step.transaction);
      return;
    }

    case "ClaimBlendEmissions": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildExitSequence ?? buildExitSequence;
      const position = synthesizeBlendPositionForClaim(node.metadata);
      const deps2: Parameters<typeof fn>[4] = {
        // force a non-empty reserve-id list; the pool clamps to actual emissions
        claimReserveIds:
          node.metadata.reserveTokenIds.length > 0 ? node.metadata.reserveTokenIds : [0],
      };
      const steps = await fn(deps.network, position, userPublicKey, sourceAccount, deps2);
      const step = steps.find((s) => s.kind === "claim_emissions");
      if (!step || step.kind !== "claim_emissions") {
        throw new Error(
          `ClaimBlendEmissions: buildExitSequence did not produce a "claim_emissions" step`,
        );
      }
      setTransaction(node, step.transaction);
      return;
    }

    case "BackstopQueue": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildExitSequence ?? buildExitSequence;
      const position = synthesizeBlendPositionForBackstop(node.metadata);
      const steps = await fn(deps.network, position, userPublicKey, sourceAccount, {
        backstopShares: node.metadata.shares,
      });
      const step = steps.find((s) => s.kind === "backstop_queue_withdrawal");
      if (!step || step.kind !== "backstop_queue_withdrawal") {
        throw new Error(
          `BackstopQueue: buildExitSequence did not produce a "backstop_queue_withdrawal" step`,
        );
      }
      setTransaction(node, step.transaction);
      return;
    }

    case "WithdrawAquarius": {
      const sourceAccount = await getSourceAccount();
      if (node.metadata.tokens.length === 0) {
        throw new Error(
          `WithdrawAquarius: metadata.tokens is empty; cannot construct withdraw call without reserve token order`,
        );
      }
      const fn = a.aquariusWithdraw ?? aquariusWithdraw;
      const tx = await fn(
        {
          user: userPublicKey,
          tokens: node.metadata.tokens,
          poolIndex: poolIndexHexToBytes(node.metadata.poolIndex),
          shareAmount: node.metadata.shareAmount,
          // accept any output; slippage policy lives in the orchestrator
          minAmounts: node.metadata.tokens.map(() => 0n),
          sourceAccount,
          network: deps.network,
        },
        { server: deps.rpc },
      );
      setTransaction(node, tx);
      return;
    }

    case "ClaimAquariusRewards": {
      const sourceAccount = await getSourceAccount();
      const fn = a.aquariusClaim ?? aquariusClaim;
      const tx = await fn(
        {
          user: userPublicKey,
          poolIndex: poolIndexHexToBytes(node.metadata.poolIndex),
          sourceAccount,
          network: deps.network,
        },
        { server: deps.rpc },
      );
      setTransaction(node, tx);
      return;
    }

    case "WithdrawSoroswapLp": {
      const sourceAccount = await getSourceAccount();
      const fn = a.removeLiquidityByContractIds ?? removeLiquidityByContractIds;
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min
      const tx = await fn(
        {
          tokenAAddress: node.metadata.tokenA,
          tokenBAddress: node.metadata.tokenB,
          liquidity: node.metadata.shareBalance.toString(),
          // accept any output; orchestrator handles slippage
          amountAMin: "0",
          amountBMin: "0",
          userAddress: userPublicKey,
          deadline,
          network: deps.network,
        },
        { server: deps.rpc, sourceAccount },
      );
      setTransaction(node, tx);
      return;
    }

    case "PayFxDAODebt": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildVaultExit ?? buildVaultExit;
      const prevKey = await resolveFxDaoPrevKey(
        deps,
        userPublicKey,
        node.metadata.vaultDenomination,
        a.findPrevVaultKey,
      );
      const exit = await fn(
        {
          denomination: node.metadata.vaultDenomination,
          debt: node.metadata.debt,
          // collateral lives on the sibling RedeemFxDAO node; pay_debt ignores it
          collateral: 0n,
        },
        userPublicKey,
        deps.network,
        sourceAccount,
        FXDAO_MAINNET_STABLE_ISSUER,
        prevKey,
      );
      setTransaction(node, exit.payDebt);
      return;
    }

    case "RedeemFxDAO": {
      if (node.metadata.debt <= 0n) {
        throw new Error(
          `RedeemFxDAO: vault debt is ${node.metadata.debt.toString()} (must be > 0); cannot build redeem`,
        );
      }
      const sourceAccount = await getSourceAccount();
      const fn = a.buildVaultExit ?? buildVaultExit;
      // redeem doesn't take prev_key; pass null and pick the redeem half only
      const exit = await fn(
        {
          denomination: node.metadata.vaultDenomination,
          debt: node.metadata.debt,
          collateral: node.metadata.collateral,
        },
        userPublicKey,
        deps.network,
        sourceAccount,
        FXDAO_MAINNET_STABLE_ISSUER,
        null,
      );
      setTransaction(node, exit.redeem);
      return;
    }

    case "ConvertSorobanToXLM": {
      const fn = a.convertToXLM ?? convertToXLM;
      const result = await fn({
        assetIn: node.metadata.asset,
        amountIn: node.metadata.amount.toString(),
        userAddress: userPublicKey,
        network: deps.network,
      });
      setTransaction(node, result.transaction);
      return;
    }

    case "TransferAsIs": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildTransfer ?? buildTransfer;
      const contractId = resolveContractIdForAsset(node.metadata.asset, deps.network);
      const tx = await fn(
        deps.rpc,
        contractId,
        userPublicKey,
        node.metadata.destination,
        node.metadata.amount,
        deps.network,
        sourceAccount,
      );
      setTransaction(node, tx);
      return;
    }

    case "FinalClassicTx":
    case "MediatorForward":
      return;
  }
}

function nodeHasTransaction(node: PlanNode): boolean {
  switch (node.kind) {
    case "RevokeAllowance":
    case "RepayBlend":
    case "PayFxDAODebt":
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
    case "RedeemFxDAO":
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
    case "ConvertSorobanToXLM":
    case "TransferAsIs":
    case "BackstopQueue":
      return node.metadata.transaction !== undefined;
    case "FinalClassicTx":
    case "MediatorForward":
      return true; // never hydrated; treat as already done
  }
}

// readonly metadata is the documented hydration point; cast through unknown
function setTransaction(node: PlanNode, tx: Transaction): void {
  switch (node.kind) {
    case "RevokeAllowance":
    case "RepayBlend":
    case "PayFxDAODebt":
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
    case "RedeemFxDAO":
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
    case "ConvertSorobanToXLM":
    case "TransferAsIs":
    case "BackstopQueue": {
      const md = node.metadata as { transaction?: Transaction };
      md.transaction = tx;
      return;
    }
    case "FinalClassicTx":
    case "MediatorForward":
      return;
  }
}

function resolveContractIdForAsset(asset: AssetIdentifier, network: NetworkConfig): string {
  switch (asset.kind) {
    case "native":
      return Asset.native().contractId(network.passphrase);
    case "credit":
      return new Asset(asset.code, asset.issuer).contractId(network.passphrase);
    case "liquidity_pool_shares":
      throw new TypeError(
        "TransferAsIs: liquidity_pool_shares cannot be transferred as a SEP-41 asset; use removeLiquidity",
      );
  }
}

// blend position synthesizers — buildExitSequence wants a full BlendUserPositions

function synthesizeBlendPositionForRepay(metadata: {
  readonly poolId: string;
  readonly asset: string;
  readonly amount: bigint;
}): BlendUserPositions {
  return {
    poolId: metadata.poolId,
    poolName: metadata.poolId,
    poolVersion: "V2",
    liabilities: new Map([[metadata.asset, metadata.amount]]),
    collateral: new Map(),
    supply: new Map(),
    emissions: new Map(),
  };
}

function synthesizeBlendPositionForWithdraw(metadata: {
  readonly poolId: string;
  readonly asset: string;
  readonly bucket: "collateral" | "supply";
}): BlendUserPositions {
  // exit sequencer skips amount <= 0n; seed with 1n and filter on the way out
  const map = new Map([[metadata.asset, 1n]]);
  return {
    poolId: metadata.poolId,
    poolName: metadata.poolId,
    poolVersion: "V2",
    liabilities: new Map(),
    collateral: metadata.bucket === "collateral" ? map : new Map(),
    supply: metadata.bucket === "supply" ? map : new Map(),
    emissions: new Map(),
  };
}

function synthesizeBlendPositionForClaim(metadata: {
  readonly poolId: string;
  readonly reserveTokenIds: readonly number[];
}): BlendUserPositions {
  // claimReserveIds on the deps overrides this anyway
  void metadata;
  return {
    poolId: metadata.poolId,
    poolName: metadata.poolId,
    poolVersion: "V2",
    liabilities: new Map(),
    collateral: new Map(),
    supply: new Map(),
    emissions: new Map(),
  };
}

function synthesizeBlendPositionForBackstop(metadata: {
  readonly poolId: string;
  readonly shares: bigint;
}): BlendUserPositions {
  void metadata;
  return {
    poolId: metadata.poolId,
    poolName: metadata.poolId,
    poolVersion: "V2",
    liabilities: new Map(),
    collateral: new Map(),
    supply: new Map(),
    emissions: new Map(),
  };
}

// resolve the user's predecessor in the fxdao vault linked list
// returns null if the user is the head (or list is empty)
async function resolveFxDaoPrevKey(
  deps: HydrationDeps,
  userPublicKey: string,
  denomination: string,
  override?: typeof defaultFindPrevVaultKey,
): Promise<VaultKey | null> {
  const fn = override ?? defaultFindPrevVaultKey;
  const vaultsContractId = resolveFxDaoVaultsId(deps.network);
  return fn(vaultsContractId, userPublicKey, denomination, deps.network, { server: deps.rpc });
}

function resolveFxDaoVaultsId(network: NetworkConfig): string {
  if (network.id === "mainnet") return getFxDAOVaultsContractId();
  if (network.id === "testnet") {
    const list = getAllowlistForNetwork(network);
    const entry = list.find((c) => c.protocol === "fxdao" && c.name === "FxDAO::VaultsContract");
    if (!entry) {
      throw new Error("FxDAO VaultsContract is not on the testnet allow-list");
    }
    return entry.id;
  }
  throw new Error(`FxDAO has no published ${network.id} deployment`);
}
