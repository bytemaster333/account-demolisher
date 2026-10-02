// classic demolition batcher: pure function from AccountAudit to ClassicBatch[]

import type { AccountAudit, AssetIdentifier, ClaimableBalanceEntry } from "@/lib/types/account";
import {
  type BatchOptions,
  type BatchedOperation,
  type ClassicBatch,
  type PathResultRef,
  type ReferenceQuote,
  pathKey,
} from "@/lib/types/plan";
import { applySlippageMin, resolveConfiguredSlippageBps } from "@/lib/safety/slippage";
import { MAX_PRICE_IMPACT_BPS, priceImpactBps } from "@/lib/plan/price-impact";

export const MAX_OPS_PER_TX = 100;

// xlm seeded into the ephemeral mediator: base reserve + fee buffer
const MEDIATOR_FUNDING_XLM = "2";
const MEDIATOR_FUNDING_STROOPS = 20_000_000n;
// a bare account's own minimum balance (2 base reserves of 0.5 XLM), which stays
// locked until the merge itself
const BARE_ACCOUNT_RESERVE_STROOPS = 10_000_000n;

export function batchClassicDemolition(
  audit: AccountAudit,
  options: BatchOptions,
  paths?: ReadonlyMap<string, PathResultRef>,
): readonly ClassicBatch[] {
  if (options.useMediator && !options.mediatorPublicKey) {
    throw new Error("batchClassicDemolition: useMediator=true requires options.mediatorPublicKey");
  }
  if (options.useMediator && (options.sendToDestinationAssetKeys?.length ?? 0) > 0) {
    // a mediator close's destination is the exchange's shared deposit address and
    // only the forward hop carries the memo, so a direct payment there can't be
    // attributed to the user
    throw new Error(
      "batchClassicDemolition: send-to-destination is not available on an exchange (mediator) close",
    );
  }
  if (!options.useMediator && options.destination === audit.accountId) {
    // Stellar rejects a self-merge with ACCOUNT_MERGE_MALFORMED. Guard here so
    // non-UI callers can't emit an op that is guaranteed to fail at submit time
    // (the mediator flow merges into a distinct ephemeral account, so it's fine).
    throw new Error(
      "batchClassicDemolition: merge destination must differ from the account being closed (self-merge is invalid)",
    );
  }

  const policy = disposalPolicy(options, paths);
  const decide = memoizedDecision(policy);
  // the memo travels on the final batch only, so on a direct memo close every
  // payment to the destination has to ride in that batch with it
  const destinationPaymentsInTail = !options.useMediator && options.memo !== undefined;

  // 1. liquidity pool withdraws
  const poolWithdraws: BatchedOperation[] = [];
  for (const pool of audit.poolShares) {
    if (!hasPositive(pool.shareBalance)) continue;
    const reserveA = pool.reserves[0];
    const reserveB = pool.reserves[1];
    if (!reserveA || !reserveB) continue;
    // reserves are the whole pool's; the floor applies to this holder's share
    const proportionalMin = proportionalWithdrawMin(pool.shareBalance, pool.totalShares);
    poolWithdraws.push({
      kind: "liquidity_pool_withdraw",
      summary: `Withdraw pool shares from ${pool.poolId.slice(0, 8)}...`,
      metadata: {
        liquidityPoolId: pool.poolId,
        amount: pool.shareBalance,
        minAmountA: proportionalMin(reserveA.amount),
        minAmountB: proportionalMin(reserveB.amount),
        reserveA,
        reserveB,
      },
    });
  }

  // 2. cancel open offers
  const offerCancels: BatchedOperation[] = audit.offers.map((offer) => ({
    kind: "manage_sell_offer_cancel",
    summary: `Cancel offer ${offer.id}`,
    metadata: {
      offerId: offer.id,
      selling: offer.selling,
      buying: offer.buying,
      priceN: offer.priceR.n,
      priceD: offer.priceR.d,
    },
  }));

  // 3. claim claimable balances. A credit claim whose asset is then sold on the
  // market goes in an earlier phase: the conversion and the trustline removal are
  // sized from this audit, so they must be rebuilt after the claim has landed.
  // Claims of assets with an explicit disposal are sized exactly here and stay
  // in the same transaction as that disposal.
  const claimPlan = planClaimableBalances(audit, options.claimableBalanceIds);
  const isolatedClaims: BatchedOperation[] = [];
  const sameTxClaims: BatchedOperation[] = [];
  const claimedInTx = new Map<string, bigint>();
  const claimsInEarlierPhase = new Set<string>();
  for (const cb of claimPlan.claimed) {
    const op = claimOp(cb);
    if (cb.asset.kind !== "credit") {
      sameTxClaims.push(op);
      continue;
    }
    const key = pathKey(cb.asset);
    const disposal = decide(key);
    if (disposal.kind === "send_to_destination" || disposal.kind === "return_to_issuer") {
      sameTxClaims.push(op);
      claimedInTx.set(key, (claimedInTx.get(key) ?? 0n) + toStroops(cb.amount));
    } else {
      isolatedClaims.push(op);
      claimsInEarlierPhase.add(key);
    }
  }

  // 4. dispose of credit balances: explicit user choices first, then a market
  // conversion within the price-impact cap. Anything else is left in place with
  // its trustline, which blocks the merge until the user resolves it.
  const disposals: BatchedOperation[] = [];
  const credits: { readonly asset: AssetIdentifier; readonly removable: boolean }[] = [];
  const tailPayments: BatchedOperation[] = [];
  const tailRemovals: BatchedOperation[] = [];
  for (const balance of audit.balances) {
    if (balance.asset.kind !== "credit") continue;
    const key = pathKey(balance.asset);
    const held = toStroops(balance.amount) + (claimedInTx.get(key) ?? 0n);
    const removeOp: BatchedOperation = {
      kind: "change_trust_remove",
      summary: `Remove trustline ${balance.asset.code}`,
      metadata: { asset: balance.asset, poolShare: false },
    };
    if (held === 0n) {
      // a trustline with a claim landing in an earlier phase is removed once the
      // re-audit sees that balance, not here
      credits.push({ asset: balance.asset, removable: !claimsInEarlierPhase.has(key) });
      continue;
    }
    const amount = stroopsToDecimal(held);
    const disposal = decide(key);
    switch (disposal.kind) {
      case "send_to_destination": {
        const payment: BatchedOperation = {
          kind: "send_residue_to_destination",
          summary: `Send ${amount} ${balance.asset.code} to the destination`,
          metadata: { asset: balance.asset, amount, destination: options.destination },
        };
        if (destinationPaymentsInTail) {
          tailPayments.push(payment);
          tailRemovals.push(removeOp);
        } else {
          disposals.push(payment);
          credits.push({ asset: balance.asset, removable: true });
        }
        break;
      }
      case "return_to_issuer":
        disposals.push({
          kind: "return_residue_to_issuer",
          summary: `Return ${amount} ${balance.asset.code} to issuer`,
          metadata: { asset: balance.asset, amount, destination: balance.asset.issuer },
        });
        credits.push({ asset: balance.asset, removable: true });
        break;
      case "convert":
        disposals.push({
          kind: "path_payment_strict_send",
          summary: `Convert ${amount} ${balance.asset.code} to XLM`,
          metadata: {
            sendAsset: balance.asset,
            sendAmount: amount,
            destination: audit.accountId,
            destAsset: { kind: "native" } satisfies AssetIdentifier,
            destMin: applySlippage(disposal.path.destinationAmount),
            path: disposal.path.path,
          },
        });
        credits.push({ asset: balance.asset, removable: !claimsInEarlierPhase.has(key) });
        break;
      case "blocked":
        credits.push({ asset: balance.asset, removable: false });
        break;
    }
  }

  // 5. remove trustlines: pool-share first, then underlying
  const removals: BatchedOperation[] = [];
  for (const balance of audit.balances) {
    if (balance.asset.kind !== "liquidity_pool_shares") continue;
    // removing a pool-share trustline needs the full LiquidityPoolAsset. The pool
    // record survives in the audit at a zero share balance (it is loaded per
    // trustline), and Horizon returns reserves in canonical order.
    const poolId = balance.asset.poolId;
    const pool = audit.poolShares.find((p) => p.poolId === poolId);
    const reserveA = pool?.reserves[0];
    const reserveB = pool?.reserves[1];
    removals.push({
      kind: "change_trust_remove",
      summary: `Remove pool-share trustline ${poolId.slice(0, 8)}...`,
      metadata: {
        asset: balance.asset,
        poolShare: true,
        ...(pool && reserveA && reserveB
          ? { poolAsset: { assetA: reserveA.asset, assetB: reserveB.asset, fee: pool.fee } }
          : {}),
      },
    });
  }
  for (const credit of credits) {
    if (!credit.removable || credit.asset.kind !== "credit") continue;
    removals.push({
      kind: "change_trust_remove",
      summary: `Remove trustline ${credit.asset.code}`,
      metadata: { asset: credit.asset, poolShare: false },
    });
  }

  // 6. delete data entries
  const dataDeletes: BatchedOperation[] = audit.data.map((data) => ({
    kind: "manage_data_delete",
    summary: `Delete data entry "${data.name}"`,
    metadata: { name: data.name },
  }));

  // 7. self-sponsored entries need no explicit revoke: removing/cancelling/
  // clearing them (trustlines, offers, signers) or claiming their CBs releases
  // the sponsorship automatically, dropping num_sponsoring so the merge passes.
  // Foreign sponsorships (entries this account sponsors for OTHERS) can't be
  // enumerated from this account's Horizon record and are blocked upstream in
  // computeMergeability rather than papered over with a wrong revoke op.

  // 8. the merge group, which always lands whole in the final batch: a threshold
  // reset or signer removal that landed a batch earlier than the merge could
  // leave the remaining batch unsignable. The reset goes first, one setOptions per
  // signer after it, and the mediator is funded right before the merge, once every
  // reserve the close frees has been released.
  const mergeGroup: BatchedOperation[] = [...tailPayments, ...tailRemovals];
  if (mustResetThresholds(audit)) {
    mergeGroup.push({
      kind: "set_options_clear_signers",
      summary: "Reset thresholds to (0,0,0) with masterWeight=1",
      metadata: {
        thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
      },
    });
  }
  for (const signer of audit.signers) {
    if (signer.weight <= 0 || signer.key === audit.accountId) continue;
    mergeGroup.push({
      kind: "set_options_clear_signers",
      summary: `Clear signer ${signer.key.slice(0, 6)}...`,
      metadata: {
        signerKey: signer.key,
        signerType: signer.type,
      },
    });
  }
  const mergeDestination = options.useMediator
    ? (options.mediatorPublicKey as string)
    : options.destination;
  // skipped once a prior phase already funded the mediator: re-creating an
  // existing account reverts with op_already_exists
  if (options.useMediator && options.mediatorPublicKey && !options.mediatorAlreadyFunded) {
    mergeGroup.push({
      kind: "create_account_mediator",
      summary: `Fund mediator ${options.mediatorPublicKey.slice(0, 6)}... with ${MEDIATOR_FUNDING_XLM} XLM`,
      metadata: {
        destination: options.mediatorPublicKey,
        startingBalance: MEDIATOR_FUNDING_XLM,
      },
    });
  }
  mergeGroup.push({
    kind: "account_merge",
    summary: options.useMediator
      ? `Merge account into mediator ${mergeDestination.slice(0, 6)}...`
      : `Merge account into ${mergeDestination.slice(0, 6)}...`,
    metadata: {
      destination: mergeDestination,
      ultimateDestination: options.destination,
      viaMediator: options.useMediator,
      userFallbackAddress: options.userFallbackAddress,
    },
  });

  // SEC-13 two-phase close: a liquidity_pool_withdraw or a credit claim credits
  // balances this audit never saw, so converting/removing those trustlines or
  // merging in the same transaction reverts. They go in a leading phase of their
  // own; the executor re-audits after it confirms and rebuilds the rest.
  const isolate = poolWithdraws.length > 0 || isolatedClaims.length > 0;
  const leading = isolate ? [...poolWithdraws, ...offerCancels, ...isolatedClaims] : [];
  const body = [
    ...(isolate ? [] : offerCancels),
    ...sameTxClaims,
    ...disposals,
    ...removals,
    ...dataDeletes,
  ];
  return [...packLeading(leading, options), ...packFinal(body, mergeGroup, options)];
}

// what a claimable balance can't be collected for
export type ClaimableBalanceBlock =
  "not_claimable_yet" | "no_trustline" | "not_authorized" | "line_full";

export interface ClaimPlan {
  // balances this close claims, in audit order
  readonly claimed: readonly ClaimableBalanceEntry[];
  // selected (or self-sponsored) balances it leaves on the ledger, and why
  readonly leftBehind: readonly {
    readonly balance: ClaimableBalanceEntry;
    readonly reason: ClaimableBalanceBlock;
  }[];
}

// which claimable balances the close claims. A credit claim needs an authorized
// trustline with room for the amount, or it fails the whole transaction with
// op_no_trust / op_not_authorized / op_line_full, so those are left behind
// rather than emitted.
export function planClaimableBalances(
  audit: AccountAudit,
  claimableBalanceIds: readonly string[] | undefined,
): ClaimPlan {
  const selected = claimableBalanceIds === undefined ? null : new Set(claimableBalanceIds);
  const headroom = new Map<string, bigint>();
  for (const b of audit.balances) {
    if (b.asset.kind !== "credit" || b.limit === undefined) continue;
    headroom.set(pathKey(b.asset), toStroops(b.limit) - toStroops(b.amount));
  }
  const claimed: ClaimableBalanceEntry[] = [];
  const leftBehind: { balance: ClaimableBalanceEntry; reason: ClaimableBalanceBlock }[] = [];
  for (const cb of audit.claimableBalances) {
    const selfSponsored = cb.sponsor === audit.accountId;
    if (!selfSponsored && selected !== null && !selected.has(cb.id)) continue;
    // undefined (fixtures/legacy) is treated as claimable
    if (cb.claimableNow === false) {
      leftBehind.push({ balance: cb, reason: "not_claimable_yet" });
      continue;
    }
    if (cb.asset.kind === "credit") {
      const key = pathKey(cb.asset);
      const asset = cb.asset;
      const line = audit.balances.find(
        (b) => b.asset.kind === "credit" && pathKey(b.asset) === pathKey(asset),
      );
      if (line === undefined) {
        leftBehind.push({ balance: cb, reason: "no_trustline" });
        continue;
      }
      if (line.isAuthorized === false) {
        leftBehind.push({ balance: cb, reason: "not_authorized" });
        continue;
      }
      const room = headroom.get(key);
      if (room !== undefined) {
        const amount = toStroops(cb.amount);
        if (amount > room) {
          leftBehind.push({ balance: cb, reason: "line_full" });
          continue;
        }
        headroom.set(key, room - amount);
      }
    }
    claimed.push(cb);
  }
  return { claimed, leftBehind };
}

// why a credit balance can't be converted on the market as planned
export type ConversionBlock = "no_path" | "price_impact" | "unpriced" | "requote_worse";

type CreditDisposal =
  | { readonly kind: "send_to_destination" }
  | { readonly kind: "return_to_issuer" }
  | { readonly kind: "convert"; readonly path: PathResultRef }
  | {
      readonly kind: "blocked";
      readonly reason: ConversionBlock;
      readonly priceImpactBps?: number;
    };

interface DisposalPolicy {
  readonly paths: ReadonlyMap<string, PathResultRef> | undefined;
  readonly returnToIssuer: ReadonlySet<string>;
  readonly sendToDestination: ReadonlySet<string>;
  readonly acceptedPriceImpact: ReadonlySet<string>;
  readonly reviewedReferences: Readonly<Record<string, ReferenceQuote>> | undefined;
  readonly slippageBps: number;
}

function disposalPolicy(
  options: Pick<
    BatchOptions,
    | "returnToIssuerAssetKeys"
    | "sendToDestinationAssetKeys"
    | "acceptedPriceImpactAssetKeys"
    | "reviewedReferenceQuotes"
  >,
  paths: ReadonlyMap<string, PathResultRef> | undefined,
): DisposalPolicy {
  return {
    paths,
    returnToIssuer: new Set(options.returnToIssuerAssetKeys ?? []),
    sendToDestination: new Set(options.sendToDestinationAssetKeys ?? []),
    acceptedPriceImpact: new Set(options.acceptedPriceImpactAssetKeys ?? []),
    reviewedReferences: options.reviewedReferenceQuotes,
    slippageBps: resolveConfiguredSlippageBps(),
  };
}

function memoizedDecision(policy: DisposalPolicy): (key: string) => CreditDisposal {
  const cache = new Map<string, CreditDisposal>();
  return (key) => {
    let d = cache.get(key);
    if (d === undefined) {
      d = decideCreditDisposal(key, policy);
      cache.set(key, d);
    }
    return d;
  };
}

// an explicit choice wins over a market path, so a path that only appears at
// execute time can't override "send to destination" or "return to issuer"
function decideCreditDisposal(key: string, policy: DisposalPolicy): CreditDisposal {
  if (policy.sendToDestination.has(key)) return { kind: "send_to_destination" };
  if (policy.returnToIssuer.has(key)) return { kind: "return_to_issuer" };
  const path = policy.paths?.get(key);
  if (path === undefined) return { kind: "blocked", reason: "no_path" };
  const impact = conversionPriceImpactBps(path);
  const accepted = policy.acceptedPriceImpact.has(key);
  if (impact === null && !accepted) return { kind: "blocked", reason: "unpriced" };
  if (impact !== null && impact > MAX_PRICE_IMPACT_BPS && !accepted) {
    return { kind: "blocked", reason: "price_impact", priceImpactBps: impact };
  }
  const reviewed = policy.reviewedReferences?.[key];
  if (
    reviewed !== undefined &&
    path.reference !== undefined &&
    referenceRateDropped(reviewed, path.reference, policy.slippageBps)
  ) {
    return { kind: "blocked", reason: "requote_worse" };
  }
  return { kind: "convert", path };
}

// price impact of selling the whole balance, against the path's reference quote
export function conversionPriceImpactBps(path: PathResultRef): number | null {
  if (path.reference === undefined) return null;
  return priceImpactBps(
    toStroops(path.sourceAmount),
    toStroops(path.destinationAmount),
    toStroops(path.reference.sourceAmount),
    toStroops(path.reference.destinationAmount),
  );
}

// true when the fresh reference rate is below the reviewed one by more than the
// slippage tolerance: the market moved against the user since they reviewed it
function referenceRateDropped(
  reviewed: ReferenceQuote,
  fresh: ReferenceQuote,
  toleranceBps: number,
): boolean {
  const reviewedIn = toStroops(reviewed.sourceAmount);
  const reviewedOut = toStroops(reviewed.destinationAmount);
  const freshIn = toStroops(fresh.sourceAmount);
  const freshOut = toStroops(fresh.destinationAmount);
  if (reviewedIn <= 0n || freshIn <= 0n) return true;
  // freshOut/freshIn < reviewedOut/reviewedIn * (1 - tolerance)
  return freshOut * reviewedIn * 10_000n < reviewedOut * freshIn * BigInt(10_000 - toleranceBps);
}

function claimOp(cb: ClaimableBalanceEntry): BatchedOperation {
  return {
    kind: "claim_claimable_balance",
    summary: `Claim claimable balance ${cb.id.slice(0, 12)}...`,
    metadata: {
      balanceId: cb.id,
      asset: cb.asset,
      amount: cb.amount,
    },
  };
}

// leading-phase ops, packed front to back. None of these batches is final, so
// none carries the memo or the merge.
function packLeading(
  ops: readonly BatchedOperation[],
  options: BatchOptions,
): readonly ClassicBatch[] {
  const batches: ClassicBatch[] = [];
  for (let cursor = 0; cursor < ops.length; cursor += MAX_OPS_PER_TX) {
    batches.push(buildBatch(ops.slice(cursor, cursor + MAX_OPS_PER_TX), options, false));
  }
  return batches;
}

// pack from the end: the merge group takes the final batch whole, the body ops
// that fit go in front of it, and the rest fill earlier batches front to back
function packFinal(
  body: readonly BatchedOperation[],
  mergeGroup: readonly BatchedOperation[],
  options: BatchOptions,
): readonly ClassicBatch[] {
  if (mergeGroup.length > MAX_OPS_PER_TX) {
    throw new Error(
      `batchClassicDemolition: the merge transaction needs ${mergeGroup.length} operations, ` +
        `over the ${MAX_OPS_PER_TX}-operation limit for one transaction`,
    );
  }
  const room = MAX_OPS_PER_TX - mergeGroup.length;
  const split = Math.max(0, body.length - room);
  const earlier = packLeading(body.slice(0, split), options);
  return [...earlier, buildBatch([...body.slice(split), ...mergeGroup], options, true)];
}

function buildBatch(
  ops: readonly BatchedOperation[],
  options: BatchOptions,
  isFinal: boolean,
): ClassicBatch {
  const usesMediator = ops.some((o) => o.kind === "create_account_mediator");
  const mediatorPath = options.useMediator && !!options.mediatorPublicKey;
  const includeMediator = mediatorPath && (usesMediator || isFinal);
  // the deposit memo only belongs on the hop that actually reaches the intended
  // recipient. On the mediator path that's the separate forward (which carries
  // the full memo), never a classic batch that merges into the ephemeral account;
  // otherwise it's the final merge batch that sends straight to the destination.
  const memoOnThisBatch = isFinal && !mediatorPath;
  return {
    operations: ops,
    destination: options.destination,
    ...(includeMediator && options.mediatorPublicKey
      ? {
          mediator: {
            publicKey: options.mediatorPublicKey,
            fundingXlm: MEDIATOR_FUNDING_XLM,
          },
        }
      : {}),
    ...(options.memo && memoOnThisBatch ? { memo: options.memo } : {}),
  };
}

function mustResetThresholds(audit: AccountAudit): boolean {
  const { thresholds } = audit;
  return (
    thresholds.low !== 0 ||
    thresholds.medium !== 0 ||
    thresholds.high !== 0 ||
    thresholds.masterWeight !== 1
  );
}

export interface MediatorFundingCheck {
  readonly sufficient: boolean;
  // lower bound of the XLM the account can spend at the create_account op
  readonly availableStroops: bigint;
  readonly requiredStroops: bigint;
}

// whether the account can fund the mediator once these batches have run. Counts
// the native balance plus only guaranteed inflows (native claims, path payment
// floors, the native side of LP withdraw floors), minus every batch's fee at
// feePerOpStroops and the account's own reserve, which stays locked until the
// merge. Null when the batches fund no mediator. Proceeds of Soroban exits that
// run before the classic batches are not in the audit, so before those run this
// is a lower bound.
export function mediatorFundingCheck(
  audit: AccountAudit,
  batches: readonly ClassicBatch[],
  feePerOpStroops: number,
): MediatorFundingCheck | null {
  const ops = batches.flatMap((b) => b.operations);
  if (!ops.some((o) => o.kind === "create_account_mediator")) return null;
  const native = audit.balances.find((b) => b.asset.kind === "native");
  let available = native ? toStroops(native.amount) : 0n;
  for (const op of ops) {
    const md = op.metadata as Record<string, unknown>;
    if (op.kind === "claim_claimable_balance" && isNative(md["asset"])) {
      available += toStroops(String(md["amount"]));
    } else if (op.kind === "path_payment_strict_send" && isNative(md["destAsset"])) {
      available += toStroops(String(md["destMin"]));
    } else if (op.kind === "liquidity_pool_withdraw") {
      const reserveA = md["reserveA"] as { readonly asset: unknown } | undefined;
      const reserveB = md["reserveB"] as { readonly asset: unknown } | undefined;
      if (isNative(reserveA?.asset)) available += toStroops(String(md["minAmountA"]));
      if (isNative(reserveB?.asset)) available += toStroops(String(md["minAmountB"]));
    }
  }
  available -= BigInt(feePerOpStroops) * BigInt(ops.length);
  available -= BARE_ACCOUNT_RESERVE_STROOPS;
  return {
    sufficient: available >= MEDIATOR_FUNDING_STROOPS,
    availableStroops: available,
    requiredStroops: MEDIATOR_FUNDING_STROOPS,
  };
}

function isNative(asset: unknown): boolean {
  return (
    typeof asset === "object" && asset !== null && (asset as { kind?: unknown }).kind === "native"
  );
}

// string-level positive check that avoids float pitfalls
function hasPositive(amountStr: string): boolean {
  for (const ch of amountStr) {
    if (ch >= "1" && ch <= "9") return true;
  }
  return false;
}

// slippage haircut (configured tolerance, default 1%), truncated to 7 decimals.
// Routed through the single slippage policy (safety/slippage.applySlippageMin) so
// the classic path uses the SAME tolerance as the DeFi-exit floors.
export function applySlippage(amountStr: string): string {
  const stroops = toStroops(amountStr);
  const adjusted = BigInt(applySlippageMin(stroops.toString(), resolveConfiguredSlippageBps()));
  return stroopsToDecimal(adjusted);
}

// slippage-bounded minimum for one reserve of an LP withdraw. The holder's
// expected output for a reserve is reserve * myShares / totalShares; haircut
// THAT by the slippage tolerance. A pool record without positive total shares
// can't size the payout, and a withdraw without a floor would accept any
// output, so that throws instead.
export function proportionalWithdrawMin(
  shareBalance: string,
  totalShares: string,
): (reserveAmount: string) => string {
  const share = toStroops(shareBalance);
  const total = toStroops(totalShares);
  if (total <= 0n || share <= 0n || share > total) {
    throw new Error(
      `proportionalWithdrawMin: cannot size a withdraw floor for ${shareBalance} of ${totalShares} pool shares`,
    );
  }
  const bps = resolveConfiguredSlippageBps();
  return (reserveAmount: string): string => {
    const reserve = toStroops(reserveAmount);
    const expected = (reserve * share) / total;
    const adjusted = BigInt(applySlippageMin(expected.toString(), bps));
    return stroopsToDecimal(adjusted);
  };
}

// horizon decimal amounts carry at most 7 places; anything else is malformed and
// throws rather than being truncated or read as zero
const DECIMAL_AMOUNT = /^(-?)(\d+)(?:\.(\d{1,7}))?$/;

function toStroops(s: string): bigint {
  const m = DECIMAL_AMOUNT.exec(s);
  if (m === null) {
    throw new Error(`classic-batcher: malformed amount "${s}"`);
  }
  const [, sign = "", intPart = "0", fracPart = ""] = m;
  const result = BigInt(intPart) * 10_000_000n + BigInt(fracPart.padEnd(7, "0"));
  return sign === "-" ? -result : result;
}

function stroopsToDecimal(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const intPart = abs / 10_000_000n;
  const fracPart = abs % 10_000_000n;
  const frac = fracPart.toString().padStart(7, "0");
  const result = `${intPart.toString()}.${frac}`;
  return negative ? `-${result}` : result;
}

export interface UnroutableCredit {
  readonly key: string;
  readonly code: string;
  readonly issuer: string;
  // the balance plus what this close claims into it
  readonly amount: string;
  readonly reason: ConversionBlock;
  // set for price_impact: how far the full-size rate sits below the reference
  readonly priceImpactBps?: number;
  // set at preview time: true when the merge destination already holds a
  // trustline for this asset, so "send to destination" can be offered.
  readonly destinationTrusts?: boolean;
}

export interface CreditPolicyOptions {
  readonly claimableBalanceIds?: readonly string[];
  readonly acceptedPriceImpactAssetKeys?: readonly string[];
  readonly reviewedReferenceQuotes?: Readonly<Record<string, ReferenceQuote>>;
}

// credit balances (including what the close claims into them) that the batcher
// will neither convert nor dispose of as the user chose. While any of these
// exist the account cannot fully merge, since their trustlines can't be removed
// with a live balance. Uses the same decision as batchClassicDemolition.
export function unroutableCredits(
  audit: AccountAudit,
  paths: ReadonlyMap<string, PathResultRef> | undefined,
  returnToIssuerAssetKeys?: readonly string[],
  sendToDestinationAssetKeys?: readonly string[],
  extra: CreditPolicyOptions = {},
): readonly UnroutableCredit[] {
  const decide = memoizedDecision(
    disposalPolicy(
      {
        ...(returnToIssuerAssetKeys ? { returnToIssuerAssetKeys } : {}),
        ...(sendToDestinationAssetKeys ? { sendToDestinationAssetKeys } : {}),
        ...(extra.acceptedPriceImpactAssetKeys
          ? { acceptedPriceImpactAssetKeys: extra.acceptedPriceImpactAssetKeys }
          : {}),
        ...(extra.reviewedReferenceQuotes
          ? { reviewedReferenceQuotes: extra.reviewedReferenceQuotes }
          : {}),
      },
      paths,
    ),
  );
  const inflow = new Map<string, bigint>();
  for (const cb of planClaimableBalances(audit, extra.claimableBalanceIds).claimed) {
    if (cb.asset.kind !== "credit") continue;
    const key = pathKey(cb.asset);
    inflow.set(key, (inflow.get(key) ?? 0n) + toStroops(cb.amount));
  }
  const out: UnroutableCredit[] = [];
  for (const b of audit.balances) {
    if (b.asset.kind !== "credit") continue;
    const key = pathKey(b.asset);
    const held = toStroops(b.amount) + (inflow.get(key) ?? 0n);
    if (held <= 0n) continue;
    const disposal = decide(key);
    if (disposal.kind !== "blocked") continue;
    out.push({
      key,
      code: b.asset.code,
      issuer: b.asset.issuer,
      amount: stroopsToDecimal(held),
      reason: disposal.reason,
      ...(disposal.priceImpactBps !== undefined ? { priceImpactBps: disposal.priceImpactBps } : {}),
    });
  }
  return out;
}
