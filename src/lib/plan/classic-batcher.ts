// classic demolition batcher: pure function from AccountAudit to ClassicBatch[].
// canonical op order:
//   1. liquidity pool withdraw per pool-share trustline
//   2. cancel each open offer (manage_sell_offer amount=0)
//   3. claim opted-in claimable balances
//   4. path payment per non-XLM credit balance (or return-to-issuer fallback)
//   5. change_trust(limit=0) — pool-share first, then underlying
//   6. delete each data entry
//   7. revoke each held sponsorship
//   8. clear non-master signers, reset thresholds
//   9. account_merge (to mediator or destination)
// splits across 100-op transactions; merge always lands in the final batch.

import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";
import {
  type BatchOptions,
  type BatchedOperation,
  type ClassicBatch,
  type PathResultRef,
  pathKey,
} from "@/lib/types/plan";

export const MAX_OPS_PER_TX = 100;

// conservative 1% slippage.
const SLIPPAGE_NUMERATOR = 99n;
const SLIPPAGE_DENOMINATOR = 100n;

// xlm seeded into the ephemeral mediator: base reserve + fee buffer.
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

  // 1. liquidity pool withdraws.
  for (const pool of audit.poolShares) {
    if (!hasPositive(pool.shareBalance)) continue;
    const reserveA = pool.reserves[0];
    const reserveB = pool.reserves[1];
    if (!reserveA || !reserveB) continue;
    const shareBalance = pool.shareBalance;
    const minA = applySlippage(reserveA.amount);
    const minB = applySlippage(reserveB.amount);
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

  // 2. cancel open offers.
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

  // 3. claim opted-in claimable balances.
  const optedIn = new Set(options.claimableBalanceIds ?? []);
  for (const cb of audit.claimableBalances) {
    if (!optedIn.has(cb.id)) continue;
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

  // 4. convert credit balances via path payment, or fall back to return-to-issuer.
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
    } else {
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
  }

  // 5. remove trustlines — pool-share first, then underlying.
  for (const balance of audit.balances) {
    if (balance.asset.kind !== "liquidity_pool_shares") continue;
    ops.push({
      kind: "change_trust_remove",
      summary: `Remove pool-share trustline ${balance.asset.poolId.slice(0, 8)}...`,
      metadata: { asset: balance.asset, poolShare: true },
    });
  }
  for (const balance of audit.balances) {
    if (balance.asset.kind !== "credit") continue;
    ops.push({
      kind: "change_trust_remove",
      summary: `Remove trustline ${balance.asset.code}`,
      metadata: { asset: balance.asset, poolShare: false },
    });
  }

  // 6. delete data entries.
  for (const data of audit.data) {
    ops.push({
      kind: "manage_data_delete",
      summary: `Delete data entry "${data.name}"`,
      metadata: { name: data.name },
    });
  }

  // 7. revoke sponsorships; orchestrator hydrates subject keys before submit.
  for (let i = 0; i < audit.sponsorship.numSponsoring; i += 1) {
    ops.push({
      kind: "revoke_sponsorship",
      summary: `Revoke sponsorship slot #${i + 1}`,
      metadata: {
        subjectKind: "account",
        account: audit.accountId,
        slotIndex: i,
      },
    });
  }

  // 8. one op per non-master signer + a threshold reset when needed.
  // setOptions accepts one signer mutation per op.
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

  // 9. final account_merge.
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
  const leading: BatchedOperation[] = [];
  if (options.useMediator && options.mediatorPublicKey) {
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
    // unreachable in practice; the merge op is always appended.
    return [];
  }
  if (ops.length <= MAX_OPS_PER_TX) {
    return [buildBatch(ops, options, /*isFinal*/ true)];
  }
  const batches: ClassicBatch[] = [];
  // pack from the front; the merge naturally lands in the last chunk.
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
  const includeMediator =
    options.useMediator && !!options.mediatorPublicKey && (usesMediator || isFinal);
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
    ...(options.memo ? { memo: options.memo } : {}),
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

// string-level positive check that avoids float pitfalls.
function hasPositive(amountStr: string): boolean {
  for (const ch of amountStr) {
    if (ch >= "1" && ch <= "9") return true;
  }
  return false;
}

// 1% slippage haircut, truncated to 7 decimals.
export function applySlippage(amountStr: string): string {
  const stroops = decimalToStroops(amountStr);
  const adjusted = (stroops * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR;
  return stroopsToDecimal(adjusted);
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
  return op.kind === "return_residue_to_issuer";
}
