// classic demolition batcher: pure function from AccountAudit to ClassicBatch[]

import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";
import {
  type BatchOptions,
  type BatchedOperation,
  type ClassicBatch,
  type PathResultRef,
  pathKey,
} from "@/lib/types/plan";

export const MAX_OPS_PER_TX = 100;

// conservative 1% slippage
const SLIPPAGE_NUMERATOR = 99n;
const SLIPPAGE_DENOMINATOR = 100n;

// xlm seeded into the ephemeral mediator: base reserve + fee buffer
const MEDIATOR_FUNDING_XLM = "2";

export function batchClassicDemolition(
  audit: AccountAudit,
  options: BatchOptions,
  paths?: ReadonlyMap<string, PathResultRef>,
): readonly ClassicBatch[] {
  if (options.useMediator && !options.mediatorPublicKey) {
    throw new Error("batchClassicDemolition: useMediator=true requires options.mediatorPublicKey");
  }

  const ops: BatchedOperation[] = [];

  // 1. liquidity pool withdraws
  for (const pool of audit.poolShares) {
    if (!hasPositive(pool.shareBalance)) continue;
    const reserveA = pool.reserves[0];
    const reserveB = pool.reserves[1];
    if (!reserveA || !reserveB) continue;
    const shareBalance = pool.shareBalance;
    // reserveA/reserveB are the WHOLE pool's reserves, not this account's share.
    // The holder's expected payout for reserve R is R * myShares / totalShares;
    // apply the slippage haircut to THAT, not to the whole reserve (which would
    // revert with LIQUIDITY_POOL_WITHDRAW_UNDER_MINIMUM). Fall back to a 0 floor
    // only if totalShares is missing/zero (can't size the share).
    const proportionalMin = proportionalWithdrawMin(shareBalance, pool.totalShares);
    const minA = proportionalMin(reserveA.amount);
    const minB = proportionalMin(reserveB.amount);
    ops.push({
      kind: "liquidity_pool_withdraw",
      summary: `Withdraw pool shares from ${pool.poolId.slice(0, 8)}...`,
      metadata: {
        liquidityPoolId: pool.poolId,
        amount: shareBalance,
        minAmountA: minA,
        minAmountB: minB,
        reserveA,
        reserveB,
      },
    });
  }

  // 2. cancel open offers
  for (const offer of audit.offers) {
    ops.push({
      kind: "manage_sell_offer_cancel",
      summary: `Cancel offer ${offer.id}`,
      metadata: {
        offerId: offer.id,
        selling: offer.selling,
        buying: offer.buying,
        priceN: offer.priceR.n,
        priceD: offer.priceR.d,
      },
    });
  }

  // 3. claim claimable balances
  const optedIn: ReadonlySet<string> | null =
    options.claimableBalanceIds === undefined ? null : new Set(options.claimableBalanceIds);
  for (const cb of audit.claimableBalances) {
    if (optedIn !== null && !optedIn.has(cb.id)) continue;
    // never attempt a balance the account can't claim yet. The op would fail
    // on-chain. undefined (fixtures/legacy) is treated as claimable.
    if (cb.claimableNow === false) continue;
    ops.push({
      kind: "claim_claimable_balance",
      summary: `Claim claimable balance ${cb.id.slice(0, 12)}...`,
      metadata: {
        balanceId: cb.id,
        asset: cb.asset,
        amount: cb.amount,
      },
    });
  }

  // 4. convert credit balances to XLM via path payment. When no market path
  // exists the balance is EITHER returned to its issuer (only with explicit
  // per-asset consent) OR left untouched. Never silently sent to the issuer.
  const consentedResidue: ReadonlySet<string> = new Set(options.returnToIssuerAssetKeys ?? []);
  const sendToDestination: ReadonlySet<string> = new Set(options.sendToDestinationAssetKeys ?? []);
  for (const balance of audit.balances) {
    if (balance.asset.kind !== "credit") continue;
    if (!hasPositive(balance.amount)) continue;
    const key = pathKey(balance.asset);
    const path = paths?.get(key);
    if (path) {
      const destMin = applySlippage(path.destinationAmount);
      ops.push({
        kind: "path_payment_strict_send",
        summary: `Convert ${balance.amount} ${balance.asset.code} to XLM`,
        metadata: {
          sendAsset: balance.asset,
          sendAmount: balance.amount,
          destination: audit.accountId,
          destAsset: { kind: "native" } satisfies AssetIdentifier,
          destMin,
          path: path.path,
        },
      });
    } else if (sendToDestination.has(key)) {
      // pay the un-routable asset straight to the merge destination. Only offered
      // when the destination already trusts the asset, so this can't fail with
      // op_no_trust (verified at preview time).
      ops.push({
        kind: "send_residue_to_destination",
        summary: `Send ${balance.amount} ${balance.asset.code} to the destination`,
        metadata: {
          asset: balance.asset,
          amount: balance.amount,
          destination: options.destination,
        },
      });
    } else if (consentedResidue.has(key)) {
      ops.push({
        kind: "return_residue_to_issuer",
        summary: `Return ${balance.amount} ${balance.asset.code} to issuer`,
        metadata: {
          asset: balance.asset,
          amount: balance.amount,
          destination: balance.asset.issuer,
        },
      });
    }
    // else: un-routable, unconsented: leave the balance in place. Its trustline
    // is kept (below), which blocks the merge until the user resolves it. The UI
    // surfaces this rather than the plan quietly forfeiting the funds.
  }

  // 5. remove trustlines: pool-share first, then underlying. A credit trustline
  // is only removed once its balance is handled (zero, converted, or consented
  // to issuer); otherwise change_trust would fail on a non-zero balance.
  for (const balance of audit.balances) {
    if (balance.asset.kind !== "liquidity_pool_shares") continue;
    // Removing a pool-share trustline needs the full LiquidityPoolAsset
    // (assetA/assetB/fee), not just the pool id. Hydrate it from the audit's pool
    // details so the builder can reconstruct it — the pool record (and thus its
    // asset pair) survives in the audit even at a zero share balance, because
    // loadPoolShares is driven by the trustline, not the balance. reserves come
    // back from Horizon in canonical order (assetA before assetB).
    const poolId = balance.asset.poolId;
    const pool = audit.poolShares.find((p) => p.poolId === poolId);
    const reserveA = pool?.reserves[0];
    const reserveB = pool?.reserves[1];
    ops.push({
      kind: "change_trust_remove",
      summary: `Remove pool-share trustline ${poolId.slice(0, 8)}...`,
      metadata: {
        asset: balance.asset,
        poolShare: true,
        ...(reserveA && reserveB
          ? { poolAsset: { assetA: reserveA.asset, assetB: reserveB.asset, fee: pool!.fee } }
          : {}),
      },
    });
  }
  for (const balance of audit.balances) {
    if (balance.asset.kind !== "credit") continue;
    if (!isCreditHandled(balance.asset, balance.amount, paths, consentedResidue, sendToDestination))
      continue;
    ops.push({
      kind: "change_trust_remove",
      summary: `Remove trustline ${balance.asset.code}`,
      metadata: { asset: balance.asset, poolShare: false },
    });
  }

  // 6. delete data entries
  for (const data of audit.data) {
    ops.push({
      kind: "manage_data_delete",
      summary: `Delete data entry "${data.name}"`,
      metadata: { name: data.name },
    });
  }

  // 7. self-sponsored entries need no explicit revoke: removing/cancelling/
  // clearing them (trustlines, offers, signers) or claiming their CBs releases
  // the sponsorship automatically, dropping num_sponsoring so the merge passes.
  // Foreign sponsorships (entries this account sponsors for OTHERS) can't be
  // enumerated from this account's Horizon record and are blocked upstream in
  // computeMergeability rather than papered over with a wrong revoke op.

  // 8. one op per non-master signer + a threshold reset when needed
  // setOptions accepts one signer mutation per op
  const nonMasterSigners = audit.signers.filter((s) => s.weight > 0 && s.key !== audit.accountId);
  for (const signer of nonMasterSigners) {
    ops.push({
      kind: "set_options_clear_signers",
      summary: `Clear signer ${signer.key.slice(0, 6)}...`,
      metadata: {
        signerKey: signer.key,
        signerType: signer.type,
      },
    });
  }
  if (mustResetThresholds(audit)) {
    ops.push({
      kind: "set_options_clear_signers",
      summary: "Reset thresholds to (0,0,0) with masterWeight=1",
      metadata: {
        thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
      },
    });
  }

  // 9. final account_merge
  if (!options.useMediator && options.destination === audit.accountId) {
    // Stellar rejects a self-merge with ACCOUNT_MERGE_MALFORMED. Guard here so
    // non-UI callers can't emit an op that is guaranteed to fail at submit time
    // (the mediator flow merges into a distinct ephemeral account, so it's fine).
    throw new Error(
      "batchClassicDemolition: merge destination must differ from the account being closed (self-merge is invalid)",
    );
  }
  const mergeDestination = options.useMediator
    ? (options.mediatorPublicKey as string)
    : options.destination;
  ops.push({
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

  // mediator funding op leads the first batch so it counts toward the op budget.
  // Skipped once a prior phase already funded the mediator (SEC-13 two-phase
  // close): re-creating an existing account reverts with op_already_exists.
  const leading: BatchedOperation[] = [];
  if (options.useMediator && options.mediatorPublicKey && !options.mediatorAlreadyFunded) {
    leading.push({
      kind: "create_account_mediator",
      summary: `Fund mediator ${options.mediatorPublicKey.slice(0, 6)}... with ${MEDIATOR_FUNDING_XLM} XLM`,
      metadata: {
        destination: options.mediatorPublicKey,
        startingBalance: MEDIATOR_FUNDING_XLM,
      },
    });
  }

  return splitIntoBatches([...leading, ...ops], options);
}

function splitIntoBatches(
  ops: readonly BatchedOperation[],
  options: BatchOptions,
): readonly ClassicBatch[] {
  if (ops.length === 0) {
    // unreachable in practice; the merge op is always appended
    return [];
  }
  // SEC-13 two-phase close: a liquidity_pool_withdraw credits the pool's
  // underlying assets to the account. Converting/removing those trustlines — or
  // merging — in the SAME transaction reverts, because the credited balance is
  // now non-zero and the pre-withdraw audit never saw it. Isolate the withdraws
  // (plus the mediator-funding op that must lead the first batch) into their own
  // leading batch. The executor re-audits after it confirms and rebuilds the
  // remainder from the new on-chain state, so the freshly credited balances are
  // routed to XLM and their trustlines removed in a subsequent batch.
  const lastWithdraw = ops.findLastIndex((o) => o.kind === "liquidity_pool_withdraw");
  if (lastWithdraw >= 0 && lastWithdraw < ops.length - 1) {
    return [
      buildBatch(ops.slice(0, lastWithdraw + 1), options, /*isFinal*/ false),
      ...packByLimit(ops.slice(lastWithdraw + 1), options),
    ];
  }
  return packByLimit(ops, options);
}

// pack ops front-to-back into <=MAX_OPS_PER_TX batches; the merge naturally lands
// in the last chunk, which is flagged final (memo + mediator inclusion).
function packByLimit(
  ops: readonly BatchedOperation[],
  options: BatchOptions,
): readonly ClassicBatch[] {
  if (ops.length === 0) {
    return [];
  }
  if (ops.length <= MAX_OPS_PER_TX) {
    return [buildBatch(ops, options, /*isFinal*/ true)];
  }
  const batches: ClassicBatch[] = [];
  let cursor = 0;
  while (cursor < ops.length) {
    const slice = ops.slice(cursor, cursor + MAX_OPS_PER_TX);
    cursor += slice.length;
    const isFinal = cursor >= ops.length;
    batches.push(buildBatch(slice, options, isFinal));
  }
  return batches;
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

// string-level positive check that avoids float pitfalls
function hasPositive(amountStr: string): boolean {
  for (const ch of amountStr) {
    if (ch >= "1" && ch <= "9") return true;
  }
  return false;
}

// 1% slippage haircut, truncated to 7 decimals
export function applySlippage(amountStr: string): string {
  const stroops = decimalToStroops(amountStr);
  const adjusted = (stroops * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR;
  return stroopsToDecimal(adjusted);
}

// slippage-bounded minimum for one reserve of an LP withdraw. The holder's
// expected output for a reserve is reserve * myShares / totalShares; haircut
// THAT by the slippage tolerance. Returns "0" (accept any output) when
// totalShares is missing/zero: better an unprotected withdraw than a min that
// over-shoots the payout and reverts the whole close-out.
export function proportionalWithdrawMin(
  shareBalance: string,
  totalShares: string,
): (reserveAmount: string) => string {
  const share = decimalToStroops(shareBalance);
  const total = decimalToStroops(totalShares);
  return (reserveAmount: string): string => {
    if (total <= 0n || share <= 0n) return "0";
    const reserve = decimalToStroops(reserveAmount);
    const expected = (reserve * share) / total;
    const adjusted = (expected * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR;
    return stroopsToDecimal(adjusted);
  };
}

function decimalToStroops(s: string): bigint {
  const trimmed = s.trim();
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [intPart = "0", fracPart = ""] = abs.split(".");
  const fracPadded = (fracPart + "0000000").slice(0, 7);
  const result = BigInt(intPart) * 10_000_000n + BigInt(fracPadded || "0");
  return negative ? -result : result;
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

export function isResidueOp(op: BatchedOperation): boolean {
  return op.kind === "return_residue_to_issuer" || op.kind === "send_residue_to_destination";
}

// a credit trustline can be removed only once its balance is dealt with: zero,
// converted via a path, consented to return to the issuer, or consented to send
// to the destination.
function isCreditHandled(
  asset: AssetIdentifier,
  amount: string,
  paths: ReadonlyMap<string, PathResultRef> | undefined,
  consentedResidue: ReadonlySet<string>,
  sendToDestination: ReadonlySet<string>,
): boolean {
  if (!hasPositive(amount)) return true;
  const key = pathKey(asset);
  return Boolean(paths?.has(key)) || consentedResidue.has(key) || sendToDestination.has(key);
}

export interface UnroutableCredit {
  readonly key: string;
  readonly code: string;
  readonly issuer: string;
  readonly amount: string;
  // set at preview time: true when the merge destination already holds a
  // trustline for this asset, so "send to destination" can be offered.
  readonly destinationTrusts?: boolean;
}

// positive credit balances with no XLM conversion path and no disposal consent
// (neither return-to-issuer nor send-to-destination). While any of these exist
// the account cannot fully merge, since their trustlines can't be removed with a
// live balance.
export function unroutableCredits(
  audit: AccountAudit,
  paths: ReadonlyMap<string, PathResultRef> | undefined,
  returnToIssuerAssetKeys?: readonly string[],
  sendToDestinationAssetKeys?: readonly string[],
): readonly UnroutableCredit[] {
  const consent = new Set(returnToIssuerAssetKeys ?? []);
  const sendToDest = new Set(sendToDestinationAssetKeys ?? []);
  const out: UnroutableCredit[] = [];
  for (const b of audit.balances) {
    if (b.asset.kind !== "credit") continue;
    if (!hasPositive(b.amount)) continue;
    const key = pathKey(b.asset);
    if (paths?.has(key) || consent.has(key) || sendToDest.has(key)) continue;
    out.push({ key, code: b.asset.code, issuer: b.asset.issuer, amount: b.amount });
  }
  return out;
}
