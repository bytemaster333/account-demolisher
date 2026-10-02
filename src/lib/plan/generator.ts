// pure plan generator: audit + positions + allowances -> deterministic PlanTree

import { Asset } from "@stellar/stellar-sdk";

import type { AccountAudit } from "@/lib/types/account";
import type {
  BatchOptions,
  ClassicBatch,
  ClassicMemo,
  PathResultRef,
  ReferenceQuote,
} from "@/lib/types/plan";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { HeldToken } from "@/lib/soroban/held-tokens";
import type {
  AquariusPositionSummary,
  BlendPositionSummary,
  FxDAOPositionSummary,
  ProtocolPositions,
  SoroswapPositionSummary,
} from "@/lib/adapters/positions/interface";
import { batchClassicDemolition, planClaimableBalances } from "@/lib/plan/classic-batcher";
import { BACKSTOP_QUEUE_DURATION_SECONDS } from "@/lib/adapters/blend/constants";

import { buildPlanTree, type PlanNode, type PlanTree } from "./tree";

export interface GeneratePlanOptions {
  readonly useMediator?: boolean;
  readonly mediatorPublicKey?: string;
  // one-time token that authorizes signing the ephemeral mediator's forward;
  // minted together with mediatorPublicKey
  readonly flowToken?: string;
  // allowance pairs opted in for revocation, keyed `${contractId}|${spender}`
  readonly selectedAllowances?: readonly string[];
  // the reviewed claimable-balance ids; [] claims none. Left undefined, every
  // balance the close can collect is claimed, and that list is what the plan
  // records for execute time.
  readonly selectedClaimableBalanceIds?: readonly string[];
  // resolved XLM-conversion paths per credit asset (pathKey -> path)
  readonly paths?: ReadonlyMap<string, PathResultRef>;
  // credit assets the user consented to return to their issuer
  readonly returnToIssuerAssetKeys?: readonly string[];
  // credit assets the user chose to send to the merge destination
  readonly sendToDestinationAssetKeys?: readonly string[];
  // pathKey()s (credit "CODE:ISSUER", held token "contract:C...") the user
  // confirmed selling although over the price-impact cap or unpriced
  readonly acceptedPriceImpactAssetKeys?: readonly string[];
  readonly memo?: ClassicMemo;
  // fallback address if the CEX rejects the deposit
  readonly userFallbackAddress?: string;
  // standalone SEP-41 tokens the account holds directly, swept to the destination
  // before the merge (SEP-41 auto-include). Emitted only on a DIRECT close: an
  // exchange (mediator) destination can't be credited with a raw contract token.
  // The drains are best-effort ORDERING-only (they run before the merge but never
  // block it): a hostile airdropped token that reverts on transfer must not be
  // able to wedge the close, so a failed drain is skipped, not fatal (executor).
  readonly heldTokens?: readonly HeldToken[];
  // when true, held SEP-41 tokens are CONVERTED to XLM (a Soroswap-router swap) so
  // the account ends as a single XLM balance, instead of transferred as-is to the
  // destination. Default false: transfer-as-is preserves the exact token and can't
  // be defeated by an illiquid/unroutable token (which has no swap route), so it's
  // the safe default; conversion is opt-in for tokens the user knows are tradable.
  readonly convertHeldTokensToXLM?: boolean;
  // the network passphrase, used to tell which tokens a DeFi exit pays out are
  // classic assets (their SAC ids are derived from it). Contract tokens an exit
  // pays out get a sweep of their own on a direct close; without the passphrase
  // the generator can't tell them apart and plans no such sweep.
  readonly networkPassphrase?: string;
  // wall-clock ms used only to ESTIMATE the Blend backstop unlock date shown on a
  // BackstopQueue node (the real 17-day timer starts on-chain at submit). Defaults
  // to Date.now(); tests pass a fixed value for determinism.
  readonly now?: number;
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
  const acceptedPriceImpact = new Set(opts.acceptedPriceImpactAssetKeys ?? []);
  const nodes: PlanNode[] = [];

  // allowance revocations
  for (const allowance of allowances) {
    const key = `${allowance.contractId}|${allowance.spender}`;
    if (!selectedAllowances.has(key)) continue;
    if (allowance.expired) continue;
    if (allowance.amount === 0n) continue;
    nodes.push({
      id: makeId("revoke", allowance.contractId, allowance.spender),
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
  }

  // exits that need nothing repaid first. They run before any repay, so the
  // tokens they pay out can fund it.
  const fundingExitIds: string[] = [];

  // aquarius LPs. pool_index is shared by pools of the same type across token
  // pairs, so a pool is identified by its tokens plus its index.
  const aquariusWithdraws: { readonly pool: AquariusPositionSummary; readonly id: string }[] = [];
  for (const pool of positions.aquarius) {
    if (pool.shareBalance <= 0n) continue;
    const id = makeId("aquarius-withdraw", ...pool.tokens, pool.poolIndex);
    nodes.push({
      id,
      kind: "WithdrawAquarius",
      dependencies: [],
      status: "pending",
      description: `Withdraw ${pool.shareBalance.toString()} shares from Aquarius pool ${aquariusPoolLabel(pool)}`,
      metadata: {
        kind: "WithdrawAquarius",
        poolIndex: pool.poolIndex,
        shareAmount: pool.shareBalance,
        tokens: pool.tokens,
      },
    });
    aquariusWithdraws.push({ pool, id });
    fundingExitIds.push(id);
  }

  // soroswap LPs
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
    fundingExitIds.push(id);
  }

  // blend withdraws from pools with no debt also fund repays elsewhere. Withdraws
  // from a pool with debt wait for that pool's repays, so they can't be
  // prerequisites of a repay without a cycle.
  const blendWithdrawIdsByPool = new Map<string, string[]>();
  const poolHasDebt = (pool: BlendPositionSummary): boolean =>
    [...pool.liabilities.values()].some((amount) => amount > 0n);
  const addBlendWithdraws = (pool: BlendPositionSummary, deps: readonly string[]): void => {
    const ids: string[] = [];
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
  };
  for (const pool of positions.blend) {
    if (poolHasDebt(pool)) continue;
    addBlendWithdraws(pool, []);
    fundingExitIds.push(...(blendWithdrawIdsByPool.get(pool.poolId) ?? []));
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
        dependencies: [...fundingExitIds],
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
    nodes.push({
      id: makeId("fxdao-pay-debt", vault.denomination),
      kind: "PayFxDAODebt",
      dependencies: [...fundingExitIds],
      status: "pending",
      // a full pay_debt closes the vault AND releases its collateral in one call
      description: `Close FxDAO ${vault.denomination} vault (repay ${vault.debt.toString()}, reclaim ${vault.collateral.toString()} collateral)`,
      metadata: {
        kind: "PayFxDAODebt",
        vaultDenomination: vault.denomination,
        debt: vault.debt,
        collateral: vault.collateral,
      },
    });
  }

  // blend collateral + supply withdraws from pools with debt; after its repays
  for (const pool of positions.blend) {
    if (!poolHasDebt(pool)) continue;
    addBlendWithdraws(pool, blendRepayIdsByPool.get(pool.poolId) ?? []);
  }

  // (No separate FxDAO redeem step: pay_debt above already reclaims the vault's
  // collateral. redeem() is an unrelated protocol op that burns stablecoin
  // against the lowest vault in the list, not a way to close your own vault.)

  // blend emissions, one per pool, after its withdraws. Emitted only when the
  // user actually has accrued emissions to claim, and targeting the SPECIFIC
  // reserve_token_ids that carry them.
  const rewardClaimIds: string[] = [];
  for (const pool of positions.blend) {
    const reserveTokenIds = pool.emissionReserveTokenIds;
    if (reserveTokenIds.length === 0) continue;
    const id = makeId("blend-claim", pool.poolId);
    nodes.push({
      id,
      kind: "ClaimBlendEmissions",
      dependencies: blendWithdrawIdsByPool.get(pool.poolId) ?? [],
      status: "pending",
      description:
        `Claim Blend emissions for pool ${shortAddr(pool.poolId)} ` +
        `(reserves ${reserveTokenIds.join(", ")})`,
      metadata: {
        kind: "ClaimBlendEmissions",
        poolId: pool.poolId,
        reserveTokenIds,
      },
    });
    rewardClaimIds.push(id);
  }

  // aquarius rewards, one per withdrawn pool
  for (const { pool, id: withdrawId } of aquariusWithdraws) {
    const id = makeId("aquarius-claim", ...pool.tokens, pool.poolIndex);
    nodes.push({
      id,
      kind: "ClaimAquariusRewards",
      dependencies: [withdrawId],
      status: "pending",
      description: `Claim Aquarius rewards for pool ${aquariusPoolLabel(pool)}`,
      metadata: {
        kind: "ClaimAquariusRewards",
        poolIndex: pool.poolIndex,
        tokens: pool.tokens,
      },
    });
    rewardClaimIds.push(id);
  }

  // classical credit balances are converted to xlm by path_payment_strict_send

  // standalone SEP-41 tokens: sweep each to the destination before the merge so a
  // custom token held in contract storage isn't stranded on the deleted account.
  // DIRECT closes only — a mediator/CEX destination can't receive a raw token
  // (the preview surfaces a "move these first" warning for that case instead).
  // These become dependencies of the merge purely for ORDERING (drain runs first);
  // the executor treats a failed drain as skip-not-fatal, so a hostile airdropped
  // token that reverts on transfer can't wedge the close. They also run after
  // every exit, since an exit can pay out more of the same token; hydration reads
  // the live balance when it builds the sweep.
  if (!useMediator) {
    const sweepDeps = [
      ...new Set([
        ...fundingExitIds,
        ...[...blendWithdrawIdsByPool.values()].flat(),
        ...rewardClaimIds,
      ]),
    ];
    const swept = new Set<string>();
    const sweep = (contractId: string, amount: bigint, fromExit: boolean): void => {
      swept.add(contractId);
      const asset = { kind: "contract", contractId } as const;
      const label = fromExit
        ? `token ${shortAddr(contractId)} paid out by your DeFi exits`
        : `held token ${shortAddr(contractId)}`;
      if (opts.convertHeldTokensToXLM === true) {
        // convert the token to XLM via a Soroswap-router swap so the account ends
        // as a single XLM balance. Best-effort: a token with no route fails to
        // hydrate/simulate and is skipped (left behind), never wedging the close.
        nodes.push({
          id: makeId("convert-token", contractId),
          kind: "ConvertSorobanToXLM",
          dependencies: sweepDeps,
          status: "pending",
          description: `Convert ${label} to XLM`,
          metadata: {
            kind: "ConvertSorobanToXLM",
            asset,
            amount,
            ...(acceptedPriceImpact.has(`contract:${contractId}`)
              ? { priceImpactAccepted: true }
              : {}),
          },
        });
        return;
      }
      nodes.push({
        id: makeId("drain-token", contractId),
        kind: "TransferAsIs",
        dependencies: sweepDeps,
        status: "pending",
        description: `Send ${label} to ${shortAddr(destination)}`,
        metadata: {
          kind: "TransferAsIs",
          asset,
          amount,
          destination,
        },
      });
    };
    for (const token of opts.heldTokens ?? []) {
      if (token.balance <= 0n) continue;
      sweep(token.contractId, token.balance, false);
    }
    // contract tokens an exit pays out. Classic assets (the native SAC and the
    // SACs of assets the account trusts) are handled by the classic batches.
    if (opts.networkPassphrase !== undefined) {
      const classic = classicSacIds(audit, opts.networkPassphrase);
      for (const token of exitPayoutTokens(positions)) {
        if (swept.has(token) || classic.has(token)) continue;
        // the payout isn't known until the exit lands; hydration reads it
        sweep(token, 0n, true);
      }
    }
  }

  // blend backstop: a deposit in the SEPARATE backstop contract. The close can
  // only START its withdrawal — a queued, 17-day-locked flow — so we emit a
  // BackstopQueue node (queue_withdrawal) that carries the estimated unlock date,
  // and the executor's merge guard refuses the close while the backstop is still
  // active/queued (the account must survive to receive the withdrawal). Only
  // emitted when there are active shares to queue; a deposit already fully queued
  // has nothing new to submit but still blocks the merge via the reprobe.
  const backstopNow = opts.now ?? Date.now();
  const backstopQueueEndsAt = new Date(backstopNow + BACKSTOP_QUEUE_DURATION_SECONDS * 1000);
  for (const bs of positions.backstop) {
    if (bs.shares <= 0n) continue;
    nodes.push({
      id: makeId("backstop-queue", bs.poolId),
      kind: "BackstopQueue",
      dependencies: [],
      status: "pending",
      description:
        `Queue Blend backstop withdrawal for pool ${shortAddr(bs.poolId)} ` +
        `(${bs.shares.toString()} shares; unlocks ~${backstopQueueEndsAt.toISOString().slice(0, 10)})`,
      metadata: {
        kind: "BackstopQueue",
        poolId: bs.poolId,
        shares: bs.shares,
        queueEndsAt: backstopQueueEndsAt,
      },
    });
  }

  // final classic transaction. The reviewed claim list is recorded explicitly, so
  // the execute-time re-batch can't claim a balance that appeared after review.
  const finalId = "final-classic-tx";
  const claimableBalanceIds =
    opts.selectedClaimableBalanceIds ??
    planClaimableBalances(audit, undefined).claimed.map((cb) => cb.id);
  const reviewedReferenceQuotes = referenceQuotesOf(opts.paths);
  const batchOptions: BatchOptions = {
    destination,
    useMediator,
    claimableBalanceIds,
    ...(useMediator && opts.mediatorPublicKey ? { mediatorPublicKey: opts.mediatorPublicKey } : {}),
    ...(opts.returnToIssuerAssetKeys
      ? { returnToIssuerAssetKeys: opts.returnToIssuerAssetKeys }
      : {}),
    ...(opts.sendToDestinationAssetKeys
      ? { sendToDestinationAssetKeys: opts.sendToDestinationAssetKeys }
      : {}),
    ...(opts.acceptedPriceImpactAssetKeys
      ? { acceptedPriceImpactAssetKeys: opts.acceptedPriceImpactAssetKeys }
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
      claimableBalanceIds,
      ...(opts.returnToIssuerAssetKeys
        ? { returnToIssuerAssetKeys: opts.returnToIssuerAssetKeys }
        : {}),
      ...(opts.sendToDestinationAssetKeys
        ? { sendToDestinationAssetKeys: opts.sendToDestinationAssetKeys }
        : {}),
      ...(opts.acceptedPriceImpactAssetKeys
        ? { acceptedPriceImpactAssetKeys: opts.acceptedPriceImpactAssetKeys }
        : {}),
      ...(reviewedReferenceQuotes ? { reviewedReferenceQuotes } : {}),
      ...(opts.userFallbackAddress ? { userFallbackAddress: opts.userFallbackAddress } : {}),
      ...(useMediator && opts.mediatorPublicKey
        ? { mediatorPublicKey: opts.mediatorPublicKey }
        : {}),
      // carry the memo so execute-time re-batching can re-apply it. The batcher
      // only puts it on a DIRECT final batch (a mediator close routes the memo
      // through the forward), so attaching it here unconditionally is safe.
      ...(opts.memo ? { memo: opts.memo } : {}),
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
        // carry the FULL memo (any type) to the forward: this is the hop that
        // reaches the CEX, so a numeric/hash deposit memo must survive here.
        ...(opts.memo ? { memo: opts.memo } : {}),
      },
    });
  }

  return buildPlanTree(nodes);
}

// contract ids of every token a planned exit pays out, in plan order
function exitPayoutTokens(positions: ProtocolPositions): readonly string[] {
  const out: string[] = [];
  const add = (id: string): void => {
    if (!out.includes(id)) out.push(id);
  };
  for (const pool of positions.aquarius) {
    if (pool.shareBalance > 0n) pool.tokens.forEach(add);
  }
  for (const pos of positions.soroswap) {
    if (pos.shareBalance <= 0n) continue;
    add(pos.pair.tokenA);
    add(pos.pair.tokenB);
  }
  for (const pool of positions.blend) {
    for (const [asset, amount] of [...pool.collateral, ...pool.supply]) {
      if (amount > 0n) add(asset);
    }
  }
  return out;
}

// SAC ids of XLM and every classic asset the account trusts; balances an exit
// pays out in these land on classic balances the batcher already handles
function classicSacIds(audit: AccountAudit, passphrase: string): ReadonlySet<string> {
  const ids = new Set<string>([Asset.native().contractId(passphrase)]);
  for (const b of audit.balances) {
    if (b.asset.kind !== "credit") continue;
    ids.add(new Asset(b.asset.code, b.asset.issuer).contractId(passphrase));
  }
  return ids;
}

function referenceQuotesOf(
  paths: ReadonlyMap<string, PathResultRef> | undefined,
): Readonly<Record<string, ReferenceQuote>> | undefined {
  if (paths === undefined) return undefined;
  const out: Record<string, ReferenceQuote> = {};
  for (const [key, path] of paths) {
    if (path.reference !== undefined) out[key] = path.reference;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

function aquariusPoolLabel(pool: AquariusPositionSummary): string {
  return `${pool.tokens.map(shortAddr).join("/")} (${pool.poolIndex.slice(0, 8)}...)`;
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
