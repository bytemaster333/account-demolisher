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
  AquariusConcentratedPositionSummary,
  AquariusPositionSummary,
  BlendPositionSummary,
  ProtocolPositions,
  SoroswapPositionSummary,
} from "@/lib/adapters/positions/interface";
import { NETWORKS, type NetworkConfig } from "@/lib/config/networks";
import { stroopsToDecimal } from "@/lib/stellar/amount";
import {
  batchClassicDemolition,
  closeMarkerPlanned,
  planClaimableBalances,
  planClassicUnwind,
} from "@/lib/plan/classic-batcher";
import { BACKSTOP_QUEUE_DURATION_SECONDS } from "@/lib/adapters/blend/constants";
import { blndTrustlineRequirement } from "@/lib/adapters/blend/emissions-check";
import {
  BLEND_MAINNET_INFRASTRUCTURE,
  BLEND_TESTNET_INFRASTRUCTURE,
} from "@/lib/adapters/blend/pools";

import {
  buildPlanTree,
  type FinalClassicTxMetadata,
  type ForfeitedBackstopEmissions,
  type PlanNode,
  type PlanTree,
  type PreparePlan,
} from "./tree";

export interface GeneratePlanOptions {
  readonly useMediator?: boolean;
  readonly mediatorPublicKey?: string;
  // flow token bound to the destination, network and memo, minted together with
  // mediatorPublicKey. it authorizes the co-signature of the mediator's forward,
  // stays usable until it expires and is renewed through /api/mediator/reissue
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
  // per-token answers to a refused conversion (no route, or a price the user did
  // not accept): contract ids to send as-is instead of converting, and held
  // tokens to leave on the account. a token an exit pays out is always swept.
  readonly sendHeldTokensAsIs?: readonly string[];
  readonly leaveHeldTokens?: readonly string[];
  // the network. it tells which tokens a DeFi exit pays out are classic assets
  // (their SAC ids derive from its passphrase), which BLND the emissions claims
  // pay, which offers and pools lock a repay asset, and which comet LP token a
  // backstop withdraw pays out. networkPassphrase alone is enough for the payout
  // sweeps; the other steps refuse to plan without a known network.
  readonly network?: NetworkConfig;
  readonly networkPassphrase?: string;
  // per-op fee the classic batches are bid at, for their reserve checks
  readonly classicFeePerOp?: number;
  // pools whose accrued backstop emissions the user agreed to forfeit because
  // the claim can't run; their queue is planned without a claim ahead of it
  readonly forfeitBackstopEmissionsPoolIds?: readonly string[];
  // wall-clock ms used only to ESTIMATE the Blend backstop unlock date shown on a
  // BackstopQueue node (the real timer starts on-chain at submit). Defaults to
  // Date.now(); tests pass a fixed value for determinism.
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
  // a plan that only prepares the close never merges, so it needs no mediator
  const now = opts.now ?? Date.now();
  const merges = preparePlanFor(positions, now) === undefined;
  if (useMediator && merges && !opts.mediatorPublicKey) {
    throw new Error("generatePlan: useMediator=true requires opts.mediatorPublicKey");
  }
  if (useMediator && merges && !opts.flowToken) {
    // the merge funds + drains an ephemeral mediator; without the flow token the
    // forward out of it can never be co-signed, stranding the funds
    throw new Error("generatePlan: useMediator=true requires opts.flowToken");
  }
  const network = resolvePlanNetwork(opts);
  const passphrase = network?.passphrase ?? opts.networkPassphrase;
  const requireNetwork = (why: string): NetworkConfig => {
    if (network === undefined) {
      throw new Error(`generatePlan: opts.network is required to plan ${why}`);
    }
    return network;
  };

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

  // aquarius concentrated positions: the reward and the swap fees are claimed
  // first, then each tick range is withdrawn on the pool itself
  for (const pos of positions.aquariusConcentrated) {
    fundingExitIds.push(...concentratedNodes(pos, nodes));
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

  // a repay pulls its asset with a SAC transfer, which can only spend what open
  // offers and classic pool shares don't hold. those are unwound in a classic
  // phase ahead of every repay.
  const repayAssets = [
    ...new Set(
      positions.blend.flatMap((pool) =>
        [...pool.liabilities].filter(([, amount]) => amount > 0n).map(([asset]) => asset),
      ),
    ),
  ];
  const repayDeps = [...fundingExitIds];
  if (repayAssets.length > 0 && (audit.offers.length > 0 || audit.poolShares.length > 0)) {
    const net = requireNetwork("the classic unwind ahead of a Blend repay");
    const unwind = planClassicUnwind(audit, repayAssets, net.passphrase, destination);
    if (unwind.batches.length > 0) {
      const id = "classic-unwind";
      nodes.push({
        id,
        kind: "ClassicUnwind",
        dependencies: [],
        status: "pending",
        description:
          `Unwind classic offers and pools before repaying ` +
          `(${unwind.offerIds.length} offer(s), ${unwind.poolIds.length} pool(s))`,
        metadata: {
          kind: "ClassicUnwind",
          batches: unwind.batches,
          offerIds: unwind.offerIds,
          poolIds: unwind.poolIds,
          repayAssets,
        },
      });
      repayDeps.push(id);
    }
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
        dependencies: repayDeps,
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

  // blend collateral + supply withdraws from pools with debt; after its repays
  for (const pool of positions.blend) {
    if (!poolHasDebt(pool)) continue;
    addBlendWithdraws(pool, blendRepayIdsByPool.get(pool.poolId) ?? []);
  }

  // blend emissions, one per pool, after its withdraws. Emitted only when the
  // user actually has accrued emissions to claim, and targeting the SPECIFIC
  // reserve_token_ids that carry them. The pool pays BLND with a SAC transfer,
  // so an account without a BLND trustline opens one first.
  const rewardClaimIds: string[] = [];
  const claimingPools = positions.blend.filter((p) => p.emissionReserveTokenIds.length > 0);
  let blndTrustlineId: string | null = null;
  if (claimingPools.length > 0) {
    const requirement = blndTrustlineRequirement(
      audit,
      positions.blend,
      requireNetwork("the Blend emissions claims"),
    );
    if (requirement?.reason === "missing") {
      blndTrustlineId = "blnd-trustline";
      nodes.push({
        id: blndTrustlineId,
        kind: "AddBlndTrustline",
        dependencies: [],
        status: "pending",
        description:
          "Add a BLND trustline so the Blend emissions can be claimed " +
          "(0.5 XLM reserve, released when the close removes the line)",
        metadata: { kind: "AddBlndTrustline", code: requirement.code, issuer: requirement.issuer },
      });
    }
  }
  for (const pool of claimingPools) {
    const reserveTokenIds = pool.emissionReserveTokenIds;
    const id = makeId("blend-claim", pool.poolId);
    nodes.push({
      id,
      kind: "ClaimBlendEmissions",
      dependencies: [
        ...(blendWithdrawIdsByPool.get(pool.poolId) ?? []),
        ...(blndTrustlineId !== null ? [blndTrustlineId] : []),
      ],
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

  // blend backstop: a deposit in the pool's own backstop contract. Shares are
  // queued (locked 17 days on the v2 backstop, 21 on v1) after any accrued
  // emissions are claimed into new shares; an already unlocked queue is
  // withdrawn. While a locked queue remains the account can't merge, so the
  // plan then only prepares the close.
  const forfeit = new Set(opts.forfeitBackstopEmissionsPoolIds ?? []);
  const forfeited: ForfeitedBackstopEmissions[] = [];
  const backstopNow = now;
  const backstopPayoutIds: string[] = [];
  const backstopPayoutTokens: string[] = [];
  for (const bs of positions.backstop) {
    const duration = bs.queueDurationSeconds ?? BACKSTOP_QUEUE_DURATION_SECONDS;
    const queueEndsAt = new Date(backstopNow + duration * 1000);
    const accrued = bs.accruedEmissions ?? 0n;
    const unlocked = bs.unlockedQueuedForWithdrawal ?? 0n;
    let claimId: string | null = null;
    if (bs.shares > 0n && accrued > 0n) {
      if (forfeit.has(bs.poolId)) {
        forfeited.push({ poolId: bs.poolId, accruedEmissions: accrued });
      } else {
        claimId = makeId("backstop-claim", bs.poolId);
        nodes.push({
          id: claimId,
          kind: "ClaimBackstopEmissions",
          dependencies: [],
          status: "pending",
          description:
            `Claim ${formatBlnd(accrued)} BLND of Blend backstop emissions for pool ` +
            `${shortAddr(bs.poolId)} into backstop shares, so they are queued too`,
          metadata: {
            kind: "ClaimBackstopEmissions",
            poolId: bs.poolId,
            accruedEmissions: accrued,
          },
        });
      }
    }
    if (bs.shares > 0n) {
      nodes.push({
        id: makeId("backstop-queue", bs.poolId),
        kind: "BackstopQueue",
        dependencies: claimId !== null ? [claimId] : [],
        status: "pending",
        description:
          `Queue Blend backstop withdrawal for pool ${shortAddr(bs.poolId)} ` +
          `(${bs.shares.toString()} shares; unlocks ~${queueEndsAt.toISOString().slice(0, 10)})`,
        metadata: {
          kind: "BackstopQueue",
          poolId: bs.poolId,
          shares: bs.shares,
          queueEndsAt,
        },
      });
    }
    if (unlocked > 0n) {
      const lpToken = blendCometId(requireNetwork("a Blend backstop withdraw"));
      const id = makeId("backstop-withdraw", bs.poolId);
      nodes.push({
        id,
        kind: "BackstopWithdraw",
        dependencies: [],
        status: "pending",
        description:
          `Withdraw the unlocked Blend backstop queue for pool ${shortAddr(bs.poolId)} ` +
          `(${unlocked.toString()} shares, paid out as BLND-USDC LP tokens)`,
        metadata: { kind: "BackstopWithdraw", poolId: bs.poolId, amount: unlocked, lpToken },
      });
      backstopPayoutIds.push(id);
      backstopPayoutTokens.push(lpToken);
    }
  }
  const prepareOnly = preparePlanFor(positions, backstopNow);

  // standalone SEP-41 tokens: sweep each to the destination before the merge so a
  // custom token held in contract storage isn't stranded on the deleted account.
  // DIRECT closes only: a mediator/CEX destination can't receive a raw token
  // (the preview surfaces a "move these first" warning for that case instead).
  // These become dependencies of the merge purely for ORDERING (drain runs first);
  // the executor treats a failed drain as skip-not-fatal, so a hostile airdropped
  // token that reverts on transfer can't wedge the close. They also run after
  // every exit, since an exit can pay out more of the same token; hydration reads
  // the live balance when it builds the sweep. A plan that only prepares the
  // close sweeps nothing: the account stays open.
  if (!useMediator && prepareOnly === undefined) {
    const sweepDeps = [
      ...new Set([
        ...fundingExitIds,
        ...[...blendWithdrawIdsByPool.values()].flat(),
        ...rewardClaimIds,
        ...backstopPayoutIds,
      ]),
    ];
    const asIs = new Set(opts.sendHeldTokensAsIs ?? []);
    const leave = new Set(opts.leaveHeldTokens ?? []);
    const swept = new Set<string>();
    const sweep = (contractId: string, amount: bigint, fromExit: boolean): void => {
      swept.add(contractId);
      const asset = { kind: "contract", contractId } as const;
      const label = fromExit
        ? `token ${shortAddr(contractId)} paid out by your DeFi exits`
        : `held token ${shortAddr(contractId)}`;
      if (opts.convertHeldTokensToXLM === true && !asIs.has(contractId)) {
        // convert the token to XLM via a Soroswap-router swap so the account ends
        // as a single XLM balance. A conversion that can't be built (no route, a
        // price over the cap) is refused at preview and the user picks what to
        // do with the token.
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
      if (token.balance <= 0n || leave.has(token.contractId)) continue;
      sweep(token.contractId, token.balance, false);
    }
    // contract tokens an exit pays out. Classic assets (the native SAC and the
    // SACs of assets the account trusts) are handled by the classic batches.
    if (passphrase !== undefined) {
      const classic = classicSacIds(audit, passphrase);
      for (const token of [...exitPayoutTokens(positions), ...backstopPayoutTokens]) {
        if (swept.has(token) || classic.has(token)) continue;
        // the payout isn't known until the exit lands; hydration reads it
        sweep(token, 0n, true);
      }
    }
  }

  const extras = {
    ...(prepareOnly !== undefined ? { prepareOnly } : {}),
    forfeitedBackstopEmissions: forfeited,
  };
  if (prepareOnly !== undefined) return buildPlanTree(nodes, extras);

  // final classic transaction. The reviewed claim list is recorded explicitly, so
  // the execute-time re-batch can't claim a balance that appeared after review.
  const finalId = "final-classic-tx";
  const feePerOp = opts.classicFeePerOp;
  const claimableBalanceIds =
    opts.selectedClaimableBalanceIds ??
    planClaimableBalances(audit, undefined, {
      ...(feePerOp !== undefined ? { feePerOpStroops: feePerOp } : {}),
    }).claimed.map((cb) => cb.id);
  const reviewedReferenceQuotes = quotesOf(opts.paths, (p) => p.reference);
  const reviewedConversionQuotes = quotesOf(opts.paths, (p) => ({
    sourceAmount: p.sourceAmount,
    destinationAmount: p.destinationAmount,
  }));
  const finalMetadata: FinalClassicTxMetadata = {
    kind: "FinalClassicTx",
    batches: [],
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
    ...(reviewedConversionQuotes ? { reviewedConversionQuotes } : {}),
    ...(useMediator && opts.mediatorPublicKey ? { mediatorPublicKey: opts.mediatorPublicKey } : {}),
    // carry the memo so execute-time re-batching can re-apply it. The batcher
    // only puts it on a DIRECT final batch (a mediator close routes the memo
    // through the forward), so attaching it here unconditionally is safe.
    ...(opts.memo ? { memo: opts.memo } : {}),
  };
  const batches: readonly ClassicBatch[] = batchClassicDemolition(
    audit,
    finalBatchOptions(finalMetadata, {
      ...(feePerOp !== undefined ? { feePerOpStroops: feePerOp } : {}),
    }),
    opts.paths,
  );
  const closeMarker = closeMarkerPlanned(batches);

  // every soroban node must complete before the merge
  const sorobanDeps: string[] = nodes
    .filter((n) => n.kind !== "FinalClassicTx" && n.kind !== "MediatorForward")
    .map((n) => n.id);

  nodes.push({
    id: finalId,
    kind: "FinalClassicTx",
    dependencies: sorobanDeps,
    status: "pending",
    description:
      `Final classic batch (${batches.length} tx, merge to ` +
      `${shortAddr(useMediator ? (opts.mediatorPublicKey ?? destination) : destination)})` +
      (closeMarker
        ? ""
        : "; not marked as an Account Demolisher close, so the close metrics will not count it"),
    metadata: { ...finalMetadata, batches, closeMarker },
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

  return buildPlanTree(nodes, extras);
}

// whether a plan for these positions can only prepare the close: a backstop
// queue stays locked after it runs (new queues, and the part of an existing one
// that has not unlocked), and the account must exist to receive it. callers can
// ask before minting anything only a full close uses, such as a mediator flow.
export function preparePlanFor(
  positions: ProtocolPositions,
  now: number = Date.now(),
): PreparePlan | undefined {
  let unlocksAt: Date | null = null;
  for (const bs of positions.backstop) {
    const unlocked = bs.unlockedQueuedForWithdrawal ?? 0n;
    if (bs.shares <= 0n && bs.queuedForWithdrawal <= unlocked) continue;
    const duration = bs.queueDurationSeconds ?? BACKSTOP_QUEUE_DURATION_SECONDS;
    const queueEndsAt = new Date(now + duration * 1000);
    if (unlocksAt === null || queueEndsAt > unlocksAt) unlocksAt = queueEndsAt;
  }
  if (unlocksAt === null) return undefined;
  return {
    unlocksAt,
    reason:
      "A Blend backstop withdrawal stays locked after this run, and the account must " +
      "exist to receive it. This run queues it and unwinds everything else; come back " +
      "after the unlock date to withdraw it and finish the close.",
  };
}

// the batch options a FinalClassicTx was reviewed with, for the execute-time
// re-batch from a fresh audit. live holds what only the executor knows then:
// the mediator it holds, whether a phase already funded it, and its fee bid.
export function finalBatchOptions(
  md: FinalClassicTxMetadata,
  live: {
    readonly mediatorPublicKey?: string;
    readonly mediatorAlreadyFunded?: boolean;
    readonly feePerOpStroops?: number;
  } = {},
): BatchOptions {
  const mediatorPublicKey = live.mediatorPublicKey ?? md.mediatorPublicKey;
  return {
    destination: md.destination,
    useMediator: md.useMediator,
    ...(md.claimableBalanceIds !== undefined
      ? { claimableBalanceIds: md.claimableBalanceIds }
      : {}),
    ...(md.returnToIssuerAssetKeys ? { returnToIssuerAssetKeys: md.returnToIssuerAssetKeys } : {}),
    ...(md.sendToDestinationAssetKeys
      ? { sendToDestinationAssetKeys: md.sendToDestinationAssetKeys }
      : {}),
    ...(md.acceptedPriceImpactAssetKeys
      ? { acceptedPriceImpactAssetKeys: md.acceptedPriceImpactAssetKeys }
      : {}),
    ...(md.reviewedReferenceQuotes ? { reviewedReferenceQuotes: md.reviewedReferenceQuotes } : {}),
    ...(md.reviewedConversionQuotes
      ? { reviewedConversionQuotes: md.reviewedConversionQuotes }
      : {}),
    ...(md.useMediator && mediatorPublicKey ? { mediatorPublicKey } : {}),
    ...(live.mediatorAlreadyFunded === true ? { mediatorAlreadyFunded: true } : {}),
    ...(live.feePerOpStroops !== undefined ? { feePerOpStroops: live.feePerOpStroops } : {}),
    ...(md.memo ? { memo: md.memo } : {}),
  };
}

// claim the reward and the fees, then withdraw every range; returns the node
// ids, all of which pay tokens into the account
function concentratedNodes(
  pos: AquariusConcentratedPositionSummary,
  nodes: PlanNode[],
): readonly string[] {
  const claims: string[] = [];
  const label = `${pos.tokens.map(shortAddr).join("/")} (${shortAddr(pos.poolAddress)})`;
  if (pos.pendingReward > 0n) {
    const id = makeId("aquarius-cl-claim", pos.poolAddress);
    nodes.push({
      id,
      kind: "ClaimAquariusRewards",
      dependencies: [],
      status: "pending",
      description: `Claim Aquarius rewards for concentrated pool ${label}`,
      metadata: {
        kind: "ClaimAquariusRewards",
        poolIndex: pos.poolIndex,
        tokens: pos.tokens,
        poolAddress: pos.poolAddress,
      },
    });
    claims.push(id);
  }
  if (pos.pendingFees.some((fee) => fee > 0n)) {
    const id = makeId("aquarius-cl-fees", pos.poolAddress);
    nodes.push({
      id,
      kind: "ClaimAquariusConcentratedFees",
      dependencies: [],
      status: "pending",
      description: `Collect the swap fees of concentrated pool ${label}`,
      metadata: {
        kind: "ClaimAquariusConcentratedFees",
        poolAddress: pos.poolAddress,
        tokens: pos.tokens,
      },
    });
    claims.push(id);
  }
  const ids = [...claims];
  for (const range of pos.ranges) {
    if (range.liquidity <= 0n) continue;
    const id = makeId(
      "aquarius-cl-withdraw",
      pos.poolAddress,
      String(range.tickLower),
      String(range.tickUpper),
    );
    nodes.push({
      id,
      kind: "WithdrawAquariusConcentrated",
      dependencies: claims,
      status: "pending",
      description:
        `Withdraw the ${range.tickLower} to ${range.tickUpper} tick range from concentrated ` +
        `pool ${label}`,
      metadata: {
        kind: "WithdrawAquariusConcentrated",
        poolAddress: pos.poolAddress,
        tokens: pos.tokens,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        liquidity: range.liquidity,
      },
    });
    ids.push(id);
  }
  return ids;
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
  for (const pos of positions.aquariusConcentrated) {
    if (pos.ranges.some((r) => r.liquidity > 0n) || pos.pendingFees.some((f) => f > 0n)) {
      pos.tokens.forEach(add);
    }
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

function resolvePlanNetwork(opts: GeneratePlanOptions): NetworkConfig | undefined {
  if (opts.network !== undefined) {
    if (
      opts.networkPassphrase !== undefined &&
      opts.networkPassphrase !== opts.network.passphrase
    ) {
      throw new Error("generatePlan: opts.network and opts.networkPassphrase disagree");
    }
    return opts.network;
  }
  if (opts.networkPassphrase === undefined) return undefined;
  return Object.values(NETWORKS).find((n) => n.passphrase === opts.networkPassphrase);
}

// the BLND-USDC comet LP token both backstops pay a withdraw out in (each
// backstop's backstop_token, read on chain 2026-10-06: CAS3FL6T... for the
// mainnet v1 and v2 backstops, CA5UTUUP... on testnet)
function blendCometId(network: NetworkConfig): string {
  const infra =
    network.id === "mainnet" ? BLEND_MAINNET_INFRASTRUCTURE : BLEND_TESTNET_INFRASTRUCTURE;
  const comet = infra.find((e) => e.name === "comet (BLND/USDC LP)");
  if (comet === undefined) {
    throw new Error(`generatePlan: no pinned Blend comet LP token on ${network.id}`);
  }
  return comet.id;
}

function quotesOf(
  paths: ReadonlyMap<string, PathResultRef> | undefined,
  pick: (path: PathResultRef) => ReferenceQuote | undefined,
): Readonly<Record<string, ReferenceQuote>> | undefined {
  if (paths === undefined) return undefined;
  const out: Record<string, ReferenceQuote> = {};
  for (const [key, path] of paths) {
    const quote = pick(path);
    if (quote !== undefined) out[key] = quote;
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

// BLND has 7 decimals
function formatBlnd(stroops: bigint): string {
  return stroopsToDecimal(stroops).replace(/\.?0+$/, "");
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
  AquariusConcentratedPositionSummary,
  SoroswapPositionSummary,
};
