// classic demolition batcher: pure function from AccountAudit to ClassicBatch[]

import { Asset } from "@stellar/stellar-sdk";

import type {
  AccountAudit,
  AssetIdentifier,
  AuditBalance,
  ClaimableBalanceEntry,
} from "@/lib/types/account";
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
import { lookupRefusedDestination } from "@/lib/safety/cex-registry";
import { shortAddress } from "@/lib/safe-display";
import { isFrozenBalance } from "@/lib/stellar/account-audit";
import { decimalToStroops as toStroops, stroopsToDecimal } from "@/lib/stellar/amount";

export const MAX_OPS_PER_TX = 100;

// xlm seeded into the ephemeral mediator: base reserve + fee buffer
const MEDIATOR_FUNDING_XLM = "2";
const MEDIATOR_FUNDING_STROOPS = 20_000_000n;
// the network base reserve (0.5 XLM on mainnet and testnet)
const BASE_RESERVE_STROOPS = 5_000_000n;
// a bare account's own minimum balance (2 base reserves of 0.5 XLM), which stays
// locked until the merge itself
const BARE_ACCOUNT_RESERVE_STROOPS = 2n * BASE_RESERVE_STROOPS;
// the highest per-op fee the executor bids for a classic batch (its
// MAX_PER_OP_FEE). reserve checks assume it when the caller gives no bid, so
// they err towards leaving the optional op out, never towards a failed batch.
export const CLASSIC_FEE_CEILING_PER_OP = 1_000_000;
// the largest trustline limit stellar allows (int64 max in stroops)
const MAX_TRUSTLINE_LIMIT_STROOPS = 9_223_372_036_854_775_807n;

export function batchClassicDemolition(
  audit: AccountAudit,
  options: BatchOptions,
  paths?: ReadonlyMap<string, PathResultRef>,
): readonly ClassicBatch[] {
  // the page refuses these too; this keeps a non-ui caller from merging into an
  // exchange wallet that would never credit the funds
  const refused = lookupRefusedDestination(options.destination);
  if (refused !== null) {
    throw new Error(
      `batchClassicDemolition: ${options.destination} is ${refused.name}, an exchange internal ` +
        `wallet, not a deposit address`,
    );
  }
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
  // a frozen balance can't be paid, path-paid or returned, and its trustline
  // can't be removed, so any batch built around it reverts after the DeFi exits
  // have already run
  const frozen = audit.balances.find(isFrozenBalance);
  if (frozen !== undefined && frozen.asset.kind === "credit") {
    throw new Error(
      `batchClassicDemolition: frozen trustline ${frozen.asset.code}:${frozen.asset.issuer} ` +
        `holds a balance; the close is blocked (FROZEN_TRUSTLINE)`,
    );
  }

  const feePerOp = BigInt(options.feePerOpStroops ?? CLASSIC_FEE_CEILING_PER_OP);
  const policy = disposalPolicy(options, paths);
  const decide = memoizedDecision(policy);
  // the memo travels on the final batch only, so on a direct memo close every
  // payment to the destination has to ride in that batch with it
  const destinationPaymentsInTail = !options.useMediator && options.memo !== undefined;

  // 1. liquidity pool withdraws, after raising any line their payout overflows
  const pools = withdrawablePools(audit);
  const poolWithdraws: BatchedOperation[] = [
    ...poolPayoutRaiseOps(audit, pools),
    ...pools.map(poolWithdrawOp),
  ];

  // 2. cancel open offers
  const offerCancels: BatchedOperation[] = audit.offers.map(offerCancelOp);

  // 3. claim claimable balances. A credit claim whose asset is then sold on the
  // market goes in an earlier phase: the conversion and the trustline removal are
  // sized from this audit, so they must be rebuilt after the claim has landed.
  // claims of assets with an explicit disposal are sized exactly here and stay
  // in the same transaction as that disposal. A claim into a trustline the close
  // opens always goes first: this audit has no balance line to dispose of yet.
  const claimPlan = planClaimableBalances(audit, options.claimableBalanceIds, {
    feePerOpStroops: Number(feePerOp),
  });
  const changeByKey = new Map(claimPlan.trustlineChanges.map((c) => [pathKey(c.asset), c]));
  const isolatedClaims: BatchedOperation[] = [];
  const sameTxClaims: BatchedOperation[] = [];
  const claimedInTx = new Map<string, bigint>();
  const claimsInEarlierPhase = new Set<string>();
  // what the earlier phase claims into a line this audit already has: the
  // conversion after it sells that too, as the review's quote counts it
  const claimedEarlier = new Map<string, bigint>();
  for (const cb of claimPlan.claimed) {
    const op = claimOp(cb);
    if (cb.asset.kind !== "credit" || cb.asset.issuer === audit.accountId) {
      // native, or the account's own asset: an issuer holds no balance of it
      sameTxClaims.push(op);
      continue;
    }
    const key = pathKey(cb.asset);
    const change = changeByKey.get(key);
    const target = (ops: BatchedOperation[]): void => {
      if (change !== undefined) {
        changeByKey.delete(key);
        ops.push(trustlineChangeOp(change.asset, change.change));
      }
      ops.push(op);
    };
    const disposal = decide(key);
    if (
      change?.change !== "add" &&
      !claimsInEarlierPhase.has(key) &&
      (disposal.kind === "send_to_destination" || disposal.kind === "return_to_issuer")
    ) {
      target(sameTxClaims);
      claimedInTx.set(key, (claimedInTx.get(key) ?? 0n) + toStroops(cb.amount));
    } else {
      target(isolatedClaims);
      claimsInEarlierPhase.add(key);
      claimedEarlier.set(key, (claimedEarlier.get(key) ?? 0n) + toStroops(cb.amount));
    }
  }

  // 4. dispose of credit balances: explicit user choices first, then a market
  // conversion within the price-impact cap. Anything else is left in place with
  // its trustline, which blocks the merge until the user resolves it.
  const disposals: BatchedOperation[] = [];
  const conversions: BatchedOperation[] = [];
  const credits: { readonly asset: AssetIdentifier; readonly removable: boolean }[] = [];
  const tailPayments: BatchedOperation[] = [];
  const tailRemovals: BatchedOperation[] = [];
  for (const balance of audit.balances) {
    if (balance.asset.kind !== "credit") continue;
    const key = pathKey(balance.asset);
    const held = toStroops(balance.amount) + (claimedInTx.get(key) ?? 0n);
    const disposal = decide(key);
    const removeOp: BatchedOperation = {
      kind: "change_trust_remove",
      summary: `Remove trustline ${balance.asset.code}`,
      metadata: { asset: balance.asset, poolShare: false },
    };
    // a conversion is rebuilt once the earlier phase landed, so it is sized for
    // what the account holds then: the amount its quote and destMin were made for
    const sold = disposal.kind === "convert" ? held + (claimedEarlier.get(key) ?? 0n) : held;
    if (sold === 0n) {
      // a trustline with a claim landing in an earlier phase is removed once the
      // re-audit sees that balance, not here
      credits.push({ asset: balance.asset, removable: !claimsInEarlierPhase.has(key) });
      continue;
    }
    const amount = stroopsToDecimal(sold);
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
        conversions.push({
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
      summary: `Remove pool-share trustline ${shortAddress(poolId, 8, 0)}`,
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
  // foreign sponsorships (entries this account sponsors for other accounts) can't be
  // enumerated from this account's Horizon record and are blocked upstream in
  // assessMergeability rather than papered over with a wrong revoke op.

  // 8. the merge group, which always lands whole in the final batch: a threshold
  // reset or signer removal that landed a batch earlier than the merge could
  // leave the remaining batch unsignable. The reset goes first, one setOptions per
  // signer after it, then the close marker, and the mediator is funded right
  // before the merge, once every reserve the close frees has been released.
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
      summary: `Clear signer ${shortAddress(signer.key)}`,
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
  const fundMediator =
    options.useMediator &&
    options.mediatorPublicKey !== undefined &&
    !options.mediatorAlreadyFunded;
  const mediatorOp: BatchedOperation | null = fundMediator
    ? {
        kind: "create_account_mediator",
        summary: `Fund mediator ${mediatorLabel(options.mediatorPublicKey as string)} with ${MEDIATOR_FUNDING_XLM} XLM`,
        metadata: {
          destination: options.mediatorPublicKey,
          startingBalance: MEDIATOR_FUNDING_XLM,
        },
      }
    : null;
  const mergeOp: BatchedOperation = {
    kind: "account_merge",
    summary: options.useMediator
      ? `Merge account into mediator ${mediatorLabel(mergeDestination)}`
      : `Merge account into ${shortAddress(mergeDestination)}`,
    metadata: {
      destination: mergeDestination,
      ultimateDestination: options.destination,
      viaMediator: options.useMediator,
    },
  };

  // two-phase close: a liquidity_pool_withdraw or a credit claim credits
  // balances this audit never saw, so converting/removing those trustlines or
  // merging in the same transaction reverts. they go in a leading phase of their
  // own; the executor re-audits after it confirms and rebuilds the rest.
  const isolate = poolWithdraws.length > 0 || isolatedClaims.length > 0;
  const leading = isolate ? [...poolWithdraws, ...offerCancels, ...isolatedClaims] : [];
  // conversions are quoted one by one against the untouched market, so two that
  // trade through the same market can't share a transaction: the second misses
  // its floor once the first has used up depth its quote counted on. all but the
  // last group run in phases of their own, and the executor quotes each phase
  // again once the one before it landed. the offers selling what they convert
  // are cancelled ahead of the first of them.
  const stages = conversionStages(conversions);
  const staged = stages.slice(0, -1);
  const stagedOps = staged.flat();
  const offersInStages = !isolate && staged.length > 0;
  const body = [
    ...(isolate || offersInStages ? [] : offerCancels),
    ...sameTxClaims,
    ...disposals,
    ...(stages.at(-1) ?? []),
    ...removals,
    ...dataDeletes,
  ];

  // the marker sets a data entry and deletes it again, so for one op it needs a
  // base reserve free on top of the bare account's minimum. it comes before the
  // mediator funding, which then sees the same balance it would without it. when
  // the account can't spare it, or the merge transaction has no room for two more
  // ops, the close goes ahead unmarked and is not counted.
  const withoutMarker = [
    ...leading,
    ...(offersInStages ? offerCancels : []),
    ...stagedOps,
    ...body,
    ...mergeGroup,
    ...(mediatorOp ? [mediatorOp] : []),
  ];
  const mergeTxOps = mergeGroup.length + (mediatorOp ? 1 : 0) + 1;
  if (
    mergeTxOps + 2 <= MAX_OPS_PER_TX &&
    markerFits(audit, [...withoutMarker, mergeOp], feePerOp)
  ) {
    mergeGroup.push(closeMarkerOp("set"), closeMarkerOp("delete"));
  }
  if (mediatorOp) mergeGroup.push(mediatorOp);
  mergeGroup.push(mergeOp);
  return [
    ...packLeading(leading, options),
    ...staged.flatMap((ops, i) =>
      packLeading(i === 0 && offersInStages ? [...offerCancels, ...ops] : ops, options),
    ),
    ...packFinal(body, mergeGroup, options),
  ];
}

// groups conversions so that no two in a group trade through the same market
// (a directed asset pair along the path, order book and pools alike). each
// conversion goes in the first group it shares no market with.
function conversionStages(
  conversions: readonly BatchedOperation[],
): readonly (readonly BatchedOperation[])[] {
  const stages: { ops: BatchedOperation[]; markets: Set<string> }[] = [];
  for (const op of conversions) {
    const markets = conversionMarkets(op);
    let stage = stages.find((s) => markets.every((m) => !s.markets.has(m)));
    if (stage === undefined) {
      stage = { ops: [], markets: new Set() };
      stages.push(stage);
    }
    stage.ops.push(op);
    for (const m of markets) stage.markets.add(m);
  }
  return stages.map((s) => s.ops);
}

// the markets a path payment sells through: each hop from the asset sold, along
// its path, to the asset bought
function conversionMarkets(op: BatchedOperation): string[] {
  const md = op.metadata as {
    readonly sendAsset: AssetIdentifier;
    readonly path: readonly AssetIdentifier[];
    readonly destAsset: AssetIdentifier;
  };
  const hops = [md.sendAsset, ...md.path, md.destAsset].map(pathKey);
  return hops.slice(1).map((to, i) => `${hops[i]}>${to}`);
}

// whether the batches carry the close marker. a close without it still merges,
// but close verification will not count it, which the review should say.
export function closeMarkerPlanned(batches: readonly ClassicBatch[]): boolean {
  return batches.some((b) => b.operations.some((o) => o.kind === "close_marker"));
}

// what a claimable balance can't be collected for
export type ClaimableBalanceBlock =
  | "not_claimable_yet"
  | "no_trustline"
  | "not_authorized"
  | "line_full"
  // the trustline it needs costs a base reserve the account can't spare
  | "reserve";

export interface TrustlineChange {
  readonly asset: Extract<AssetIdentifier, { kind: "credit" }>;
  // add: open a trustline the account doesn't have. raise: lift a full one to
  // the maximum limit. both happen right before the first claim of the asset
  readonly change: "add" | "raise";
}

export interface ClaimPlan {
  // balances this close claims, in audit order
  readonly claimed: readonly ClaimableBalanceEntry[];
  // selected (or self-sponsored) balances it leaves on the ledger, and why
  readonly leftBehind: readonly {
    readonly balance: ClaimableBalanceEntry;
    readonly reason: ClaimableBalanceBlock;
  }[];
  // trustlines opened or raised so the claimed balances can land
  readonly trustlineChanges: readonly TrustlineChange[];
}

export interface ClaimPlanOptions {
  // per-op bid for the ops the claims add; defaults to the executor's ceiling
  readonly feePerOpStroops?: number;
}

// which claimable balances the close claims. A credit claim needs an authorized
// trustline with room for the amount, or it fails the whole transaction with
// op_no_trust / op_not_authorized / op_line_full. A missing trustline is opened
// first when the issuer doesn't require authorization and the account can fund
// its reserve; a full one is raised to the maximum limit. The account's own
// asset needs no trustline at all (and change_trust on it is op_malformed).
export function planClaimableBalances(
  audit: AccountAudit,
  claimableBalanceIds: readonly string[] | undefined,
  options: ClaimPlanOptions = {},
): ClaimPlan {
  const selected = claimableBalanceIds === undefined ? null : new Set(claimableBalanceIds);
  const feePerOp = BigInt(options.feePerOpStroops ?? CLASSIC_FEE_CEILING_PER_OP);
  const lines = new Map<string, AuditBalance>();
  for (const b of audit.balances) {
    if (b.asset.kind === "credit") lines.set(pathKey(b.asset), b);
  }
  // room left on each trustline; undefined when the audit carries no limit
  const room = new Map<string, bigint>();
  for (const [key, b] of lines) {
    if (b.limit !== undefined) room.set(key, toStroops(b.limit) - toStroops(b.amount));
  }
  // the pool withdraws of the leading phase run ahead of the claims (in the same
  // transaction), so what they credit to a line is no longer room for a claim.
  // a line their payout overflows is already raised to the maximum limit ahead
  // of them, and a claim can't raise it again.
  const payouts = poolPayouts(audit, withdrawablePools(audit));
  for (const [key, payout] of payouts) {
    const left = room.get(key);
    if (left === undefined) continue;
    if (payout.raise) {
      const line = lines.get(key)!;
      const raisedRoom = MAX_TRUSTLINE_LIMIT_STROOPS - toStroops(line.amount) - payout.paid;
      room.set(key, raisedRoom > 0n ? raisedRoom : 0n);
    } else {
      room.set(key, left > payout.paid ? left - payout.paid : 0n);
    }
  }
  const raisedForPools = new Set([...payouts].filter(([, p]) => p.raise).map(([key]) => key));
  // XLM free for new trustline reserves: the balance above the account's
  // current minimum and selling liabilities, less the fee of the ops that run
  // with the claims in the leading phase
  const leadingOps =
    audit.poolShares.filter((p) => hasPositive(p.shareBalance)).length +
    raisedForPools.size +
    audit.offers.length;
  let spendable = spendableNative(audit) - feePerOp * BigInt(leadingOps);

  const claimed: ClaimableBalanceEntry[] = [];
  const leftBehind: { balance: ClaimableBalanceEntry; reason: ClaimableBalanceBlock }[] = [];
  const changes = new Map<string, TrustlineChange>();
  for (const cb of audit.claimableBalances) {
    const selfSponsored = cb.sponsor === audit.accountId;
    if (!selfSponsored && selected !== null && !selected.has(cb.id)) continue;
    // undefined (fixtures/legacy) is treated as claimable
    if (cb.claimableNow === false) {
      leftBehind.push({ balance: cb, reason: "not_claimable_yet" });
      continue;
    }
    if (cb.asset.kind !== "credit" || cb.asset.issuer === audit.accountId) {
      claimed.push(cb);
      spendable -= feePerOp;
      continue;
    }
    const asset = cb.asset;
    const key = pathKey(asset);
    const amount = toStroops(cb.amount);
    const line = lines.get(key);
    if (line === undefined) {
      if (cb.issuerAuthRequired !== false) {
        leftBehind.push({ balance: cb, reason: "no_trustline" });
        continue;
      }
      if (!changes.has(key)) {
        // the new line's reserve, and the fee of its change_trust and this claim
        const cost = BASE_RESERVE_STROOPS + 2n * feePerOp;
        if (spendable < cost) {
          leftBehind.push({ balance: cb, reason: "reserve" });
          continue;
        }
        spendable -= BASE_RESERVE_STROOPS + feePerOp;
        changes.set(key, { asset, change: "add" });
        room.set(key, MAX_TRUSTLINE_LIMIT_STROOPS);
      }
    } else if (line.isAuthorized === false) {
      leftBehind.push({ balance: cb, reason: "not_authorized" });
      continue;
    }
    const left = room.get(key);
    if (left !== undefined && amount > left) {
      // a full line is raised to the maximum limit once; past that it stays full
      const raised =
        MAX_TRUSTLINE_LIMIT_STROOPS - (line ? toStroops(line.limit ?? "0") - left : 0n);
      if (changes.has(key) || raisedForPools.has(key) || line === undefined || amount > raised) {
        leftBehind.push({ balance: cb, reason: "line_full" });
        continue;
      }
      spendable -= feePerOp;
      changes.set(key, { asset, change: "raise" });
      room.set(key, raised - amount);
    } else if (left !== undefined) {
      room.set(key, left - amount);
    }
    claimed.push(cb);
    spendable -= feePerOp;
  }
  return { claimed, leftBehind, trustlineChanges: [...changes.values()] };
}

// native the account can spend right now: its balance less the minimum balance
// (2 + subentries + sponsoring - sponsored base reserves) and selling liabilities
function spendableNative(audit: AccountAudit): bigint {
  const native = audit.balances.find((b) => b.asset.kind === "native");
  if (native === undefined) return 0n;
  const units =
    2n +
    BigInt(audit.subentryCount) +
    BigInt(audit.sponsorship.numSponsoring) -
    BigInt(audit.sponsorship.numSponsored);
  return (
    toStroops(native.amount) - units * BASE_RESERVE_STROOPS - toStroops(native.sellingLiabilities)
  );
}

// whether the account still has a base reserve free when the marker is set,
// right before the merge. by then every subentry the close removes is gone, so
// the bare account's own minimum is what stays locked; inflows count only at
// their guaranteed floors, and every op's fee is taken off at the bid.
function markerFits(
  audit: AccountAudit,
  opsWithoutMarker: readonly BatchedOperation[],
  feePerOp: bigint,
): boolean {
  const native = audit.balances.find((b) => b.asset.kind === "native");
  if (native === undefined) return false;
  // the mediator funding runs after the marker, so only its fee counts here
  const available =
    toStroops(native.amount) +
    guaranteedNativeInflow(opsWithoutMarker) -
    toStroops(native.sellingLiabilities) -
    BARE_ACCOUNT_RESERVE_STROOPS -
    feePerOp * BigInt(opsWithoutMarker.length + 2);
  return available >= BASE_RESERVE_STROOPS;
}

// XLM the ops pay into the account at their floors: native claims, path payment
// minimums and the native side of LP withdraw minimums
function guaranteedNativeInflow(ops: readonly BatchedOperation[]): bigint {
  let inflow = 0n;
  for (const op of ops) {
    const md = op.metadata as Record<string, unknown>;
    if (op.kind === "claim_claimable_balance" && isNative(md["asset"])) {
      inflow += toStroops(String(md["amount"]));
    } else if (op.kind === "path_payment_strict_send" && isNative(md["destAsset"])) {
      inflow += toStroops(String(md["destMin"]));
    } else if (op.kind === "liquidity_pool_withdraw") {
      const reserveA = md["reserveA"] as { readonly asset: unknown } | undefined;
      const reserveB = md["reserveB"] as { readonly asset: unknown } | undefined;
      if (isNative(reserveA?.asset)) inflow += toStroops(String(md["minAmountA"]));
      if (isNative(reserveB?.asset)) inflow += toStroops(String(md["minAmountB"]));
    }
  }
  return inflow;
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
  readonly reviewedConversions: Readonly<Record<string, ReferenceQuote>> | undefined;
  readonly slippageBps: number;
}

function disposalPolicy(
  options: Pick<
    BatchOptions,
    | "returnToIssuerAssetKeys"
    | "sendToDestinationAssetKeys"
    | "acceptedPriceImpactAssetKeys"
    | "reviewedReferenceQuotes"
    | "reviewedConversionQuotes"
  >,
  paths: ReadonlyMap<string, PathResultRef> | undefined,
): DisposalPolicy {
  return {
    paths,
    returnToIssuer: new Set(options.returnToIssuerAssetKeys ?? []),
    sendToDestination: new Set(options.sendToDestinationAssetKeys ?? []),
    acceptedPriceImpact: new Set(options.acceptedPriceImpactAssetKeys ?? []),
    reviewedReferences: options.reviewedReferenceQuotes,
    reviewedConversions: options.reviewedConversionQuotes,
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
  // a confirmation covers the price the user saw, so both the reference and the
  // full-size quote are held to what was reviewed
  const reviewedReference = policy.reviewedReferences?.[key];
  if (
    reviewedReference !== undefined &&
    path.reference !== undefined &&
    rateDropped(reviewedReference, path.reference, policy.slippageBps)
  ) {
    return { kind: "blocked", reason: "requote_worse" };
  }
  const reviewedFull = policy.reviewedConversions?.[key];
  if (reviewedFull !== undefined && rateDropped(reviewedFull, path, policy.slippageBps)) {
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

// true when the fresh rate is below the reviewed one by more than the slippage
// tolerance: the market moved against the user since they reviewed it
function rateDropped(
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
    summary: `Claim claimable balance ${shortAddress(cb.id, 12, 0)}`,
    metadata: {
      balanceId: cb.id,
      asset: cb.asset,
      amount: cb.amount,
    },
  };
}

function trustlineChangeOp(
  asset: Extract<AssetIdentifier, { kind: "credit" }>,
  change: TrustlineChange["change"],
): BatchedOperation {
  return {
    kind: "change_trust_add",
    summary:
      change === "add"
        ? `Add trustline ${asset.code} to collect a claimable balance`
        : `Raise the ${asset.code} trustline limit to collect a claimable balance`,
    metadata: { asset },
  };
}

function closeMarkerOp(action: "set" | "delete"): BatchedOperation {
  return {
    kind: "close_marker",
    summary:
      action === "set"
        ? "Mark this transaction as an Account Demolisher close"
        : "Remove the close marker",
    metadata: { action },
  };
}

function poolWithdrawOp(pool: AccountAudit["poolShares"][number]): BatchedOperation {
  const reserveA = pool.reserves[0]!;
  const reserveB = pool.reserves[1]!;
  // reserves are the whole pool's; the floor applies to this holder's share
  const proportionalMin = proportionalWithdrawMin(pool.shareBalance, pool.totalShares);
  return {
    kind: "liquidity_pool_withdraw",
    summary: `Withdraw pool shares from ${shortAddress(pool.poolId, 8, 0)}`,
    metadata: {
      liquidityPoolId: pool.poolId,
      amount: pool.shareBalance,
      minAmountA: proportionalMin(reserveA.amount),
      minAmountB: proportionalMin(reserveB.amount),
      reserveA,
      reserveB,
    },
  };
}

interface PoolPayout {
  readonly asset: Extract<AssetIdentifier, { kind: "credit" }>;
  // what the withdraws pay into the line, sized like core: reserve * shares /
  // total per pool, rounded down
  readonly paid: bigint;
  // the payout does not fit under the line's limit, less its balance and buying
  // liabilities (the offers are cancelled after the withdraws)
  readonly raise: boolean;
  // it does not fit even at the maximum limit
  readonly overflow: boolean;
}

// what the pool withdraws pay into each credit trustline, by pathKey. core fails
// a withdraw whose payout does not fit with LIQUIDITY_POOL_WITHDRAW_LINE_FULL,
// so the payouts are checked against each line's room up front.
function poolPayouts(
  audit: AccountAudit,
  pools: readonly AccountAudit["poolShares"][number][],
): ReadonlyMap<string, PoolPayout> {
  const paid = new Map<string, { asset: PoolPayout["asset"]; paid: bigint }>();
  for (const pool of pools) {
    const shares = toStroops(pool.shareBalance);
    const total = toStroops(pool.totalShares);
    if (shares <= 0n || total <= 0n) continue;
    for (const reserve of pool.reserves) {
      if (reserve.asset.kind !== "credit") continue;
      const key = pathKey(reserve.asset);
      const prior = paid.get(key)?.paid ?? 0n;
      paid.set(key, {
        asset: reserve.asset,
        paid: prior + (toStroops(reserve.amount) * shares) / total,
      });
    }
  }
  const out = new Map<string, PoolPayout>();
  for (const [key, p] of paid) {
    const line = audit.balances.find((b) => b.asset.kind === "credit" && pathKey(b.asset) === key);
    if (line?.limit === undefined) continue;
    const used = toStroops(line.amount) + toStroops(line.buyingLiabilities);
    out.set(key, {
      ...p,
      raise: p.paid > toStroops(line.limit) - used,
      overflow: p.paid > MAX_TRUSTLINE_LIMIT_STROOPS - used,
    });
  }
  return out;
}

// change_trusts at the maximum limit for the lines the withdraws would overflow,
// to run ahead of them. a payout too big even for that can't land at all.
function poolPayoutRaiseOps(
  audit: AccountAudit,
  pools: readonly AccountAudit["poolShares"][number][],
): BatchedOperation[] {
  const ops: BatchedOperation[] = [];
  for (const payout of poolPayouts(audit, pools).values()) {
    if (!payout.raise) continue;
    if (payout.overflow) {
      throw new Error(
        `batchClassicDemolition: withdrawing the liquidity pool shares would pay ` +
          `${stroopsToDecimal(payout.paid)} ${payout.asset.code}, more than its trustline can ` +
          `hold even at the maximum limit; move some ${payout.asset.code} out of the account first`,
      );
    }
    ops.push({
      kind: "change_trust_add",
      summary: `Raise the ${payout.asset.code} trustline limit so the pool withdraw can pay it out`,
      metadata: { asset: payout.asset },
    });
  }
  return ops;
}

// how the plan names the mediator in its summaries and descriptions. a re-minted
// flow swaps the key in that text (mediator/refresh.ts), so this one form is
// what both sides match on.
export function mediatorLabel(publicKey: string): string {
  return `${publicKey.slice(0, 6)}...`;
}

function offerCancelOp(offer: AccountAudit["offers"][number]): BatchedOperation {
  return {
    kind: "manage_sell_offer_cancel",
    summary: `Cancel offer ${offer.id}`,
    metadata: {
      offerId: offer.id,
      selling: offer.selling,
      buying: offer.buying,
      priceN: offer.priceR.n,
      priceD: offer.priceR.d,
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
// feePerOpStroops, the account's own reserve (locked until the merge) and
// spentBeforeStroops, the XLM the steps ahead of the classic batches can spend
// (the soroban steps' maximum fees, plus any XLM debt they repay). Null when the
// batches fund no mediator. XLM those steps pay out is not counted, so run
// against a preview audit this errs on the side of refusing; the executor's
// fresh audit before the merge batch sees the real balance.
export function mediatorFundingCheck(
  audit: AccountAudit,
  batches: readonly ClassicBatch[],
  feePerOpStroops: number,
  spentBeforeStroops: bigint = 0n,
): MediatorFundingCheck | null {
  const ops = batches.flatMap((b) => b.operations);
  if (!ops.some((o) => o.kind === "create_account_mediator")) return null;
  const native = audit.balances.find((b) => b.asset.kind === "native");
  let available = native ? toStroops(native.amount) : 0n;
  available += guaranteedNativeInflow(ops);
  available -= BigInt(feePerOpStroops) * BigInt(ops.length);
  available -= BARE_ACCOUNT_RESERVE_STROOPS;
  available -= spentBeforeStroops;
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
// routed through the single slippage policy (safety/slippage.applySlippageMin) so
// the classic path uses the same tolerance as the defi-exit floors.
export function applySlippage(amountStr: string): string {
  const stroops = toStroops(amountStr);
  const adjusted = BigInt(applySlippageMin(stroops.toString(), resolveConfiguredSlippageBps()));
  return stroopsToDecimal(adjusted);
}

// slippage-bounded minimum for one reserve of an lp withdraw. the holder's
// expected output for a reserve is reserve * myShares / totalShares, and the
// slippage tolerance is taken off that. a pool record without positive total shares
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
  readonly reviewedConversionQuotes?: Readonly<Record<string, ReferenceQuote>>;
  readonly feePerOpStroops?: number;
}

// credit balances (including what the close claims into them, and assets it
// collects into a trustline it opens) that the batcher will neither convert nor
// dispose of as the user chose. While any of these exist the account cannot
// fully merge, since their trustlines can't be removed with a live balance. Uses
// the same decision as batchClassicDemolition.
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
        ...(extra.reviewedConversionQuotes
          ? { reviewedConversionQuotes: extra.reviewedConversionQuotes }
          : {}),
      },
      paths,
    ),
  );
  const out: UnroutableCredit[] = [];
  for (const [key, { asset, amount }] of heldCredits(audit, extra)) {
    if (amount <= 0n) continue;
    const disposal = decide(key);
    if (disposal.kind !== "blocked") continue;
    out.push({
      key,
      code: asset.code,
      issuer: asset.issuer,
      amount: stroopsToDecimal(amount),
      reason: disposal.reason,
      ...(disposal.priceImpactBps !== undefined ? { priceImpactBps: disposal.priceImpactBps } : {}),
    });
  }
  return out;
}

// a credit balance the close sells for XLM unless the user picks another
// disposal: it has a market path within the price-impact cap (or one the user
// accepted above it). the user may send it as-is or return it to its issuer
// instead, which the batcher ranks above the path.
export interface RoutableCredit {
  readonly key: string;
  readonly code: string;
  readonly issuer: string;
  // the balance plus what this close claims into it
  readonly amount: string;
  // set at preview time: true when the merge destination can take the whole
  // balance as-is, so "send to destination" can be offered
  readonly destinationTrusts?: boolean;
}

// credit balances the close would convert when no explicit send or return choice
// is made for them, whether or not one is made now, so the choice can be undone
export function routableCredits(
  audit: AccountAudit,
  paths: ReadonlyMap<string, PathResultRef> | undefined,
  extra: CreditPolicyOptions = {},
): readonly RoutableCredit[] {
  const decide = memoizedDecision(
    disposalPolicy(
      {
        ...(extra.acceptedPriceImpactAssetKeys
          ? { acceptedPriceImpactAssetKeys: extra.acceptedPriceImpactAssetKeys }
          : {}),
        ...(extra.reviewedReferenceQuotes
          ? { reviewedReferenceQuotes: extra.reviewedReferenceQuotes }
          : {}),
        ...(extra.reviewedConversionQuotes
          ? { reviewedConversionQuotes: extra.reviewedConversionQuotes }
          : {}),
      },
      paths,
    ),
  );
  const out: RoutableCredit[] = [];
  for (const [key, { asset, amount }] of heldCredits(audit, extra)) {
    if (amount <= 0n || decide(key).kind !== "convert") continue;
    out.push({ key, code: asset.code, issuer: asset.issuer, amount: stroopsToDecimal(amount) });
  }
  return out;
}

// every credit balance by path key, plus what the close claims into it. the
// account's own asset is not held once claimed.
function heldCredits(
  audit: AccountAudit,
  extra: CreditPolicyOptions,
): ReadonlyMap<string, { asset: { code: string; issuer: string }; amount: bigint }> {
  const held = new Map<string, { asset: { code: string; issuer: string }; amount: bigint }>();
  for (const b of audit.balances) {
    if (b.asset.kind !== "credit") continue;
    held.set(pathKey(b.asset), { asset: b.asset, amount: toStroops(b.amount) });
  }
  const claims = planClaimableBalances(audit, extra.claimableBalanceIds, {
    ...(extra.feePerOpStroops !== undefined ? { feePerOpStroops: extra.feePerOpStroops } : {}),
  }).claimed;
  for (const cb of claims) {
    if (cb.asset.kind !== "credit" || cb.asset.issuer === audit.accountId) continue;
    const key = pathKey(cb.asset);
    const entry = held.get(key) ?? { asset: cb.asset, amount: 0n };
    held.set(key, { asset: entry.asset, amount: entry.amount + toStroops(cb.amount) });
  }
  return held;
}

export interface ClassicUnwindPlan {
  readonly batches: readonly ClassicBatch[];
  readonly offerIds: readonly string[];
  readonly poolIds: readonly string[];
}

// what an unwind cancels and withdraws, by id, and the close's destination
export interface ClassicUnwindTargets {
  readonly offerIds: readonly string[];
  readonly poolIds: readonly string[];
  readonly destination: string;
}

// the classic phase that frees repay assets before the repays: cancel every
// offer that sells one (its selling liabilities lock the balance a SAC transfer
// can spend) and withdraw every classic pool share that holds one in its
// reserves. repayAssets are SAC contract ids, compared through the passphrase.
// no batches when nothing locks a repay asset.
export function planClassicUnwind(
  audit: AccountAudit,
  repayAssets: readonly string[],
  networkPassphrase: string,
  destination: string,
): ClassicUnwindPlan {
  const wanted = new Set(repayAssets);
  const locks = (asset: AssetIdentifier): boolean => {
    if (asset.kind === "native") return wanted.has(Asset.native().contractId(networkPassphrase));
    if (asset.kind === "credit") {
      return wanted.has(new Asset(asset.code, asset.issuer).contractId(networkPassphrase));
    }
    return false;
  };
  const offerIds = audit.offers.filter((o) => locks(o.selling)).map((o) => o.id);
  const poolIds = withdrawablePools(audit)
    .filter((p) => p.reserves.some((r) => locks(r.asset)))
    .map((p) => p.poolId);
  return {
    batches: buildClassicUnwindBatches(audit, { offerIds, poolIds, destination }),
    offerIds,
    poolIds,
  };
}

// the unwind batches for the offers and pools a plan reviewed, rebuilt from this
// audit: an offer already gone or a pool already withdrawn is skipped, a pool's
// floors come from today's reserves, and nothing the review did not list is
// touched. no batches when everything is already unwound.
export function buildClassicUnwindBatches(
  audit: AccountAudit,
  targets: ClassicUnwindTargets,
): readonly ClassicBatch[] {
  const { offers, pools } = unwindEntries(audit, targets);
  const ops = [
    ...poolPayoutRaiseOps(audit, pools),
    ...pools.map(poolWithdrawOp),
    ...offers.map(offerCancelOp),
  ];
  return packLeading(ops, { destination: targets.destination, useMediator: false });
}

// the account as the final batches will find it once the unwind has run: the
// cancelled offers gone with the liabilities they held, the withdrawn pool shares
// at zero with their payout at its floor on the reserve balances, and every
// unwind op's fee taken off the XLM. the executor re-audits before the final
// batches, so this only keeps the review from showing the unwind twice.
export function auditAfterUnwind(
  audit: AccountAudit,
  targets: ClassicUnwindTargets,
  feePerOpStroops: number = CLASSIC_FEE_CEILING_PER_OP,
): AccountAudit {
  const { offers, pools } = unwindEntries(audit, targets);
  if (offers.length + pools.length === 0) return audit;
  const delta = new Map<string, { amount: bigint; selling: bigint; buying: bigint }>();
  const shift = (asset: AssetIdentifier, field: "amount" | "selling" | "buying", by: bigint) => {
    const key = pathKey(asset);
    const d = delta.get(key) ?? { amount: 0n, selling: 0n, buying: 0n };
    d[field] += by;
    delta.set(key, d);
  };
  for (const offer of offers) {
    const amount = toStroops(offer.amount);
    shift(offer.selling, "selling", -amount);
    shift(offer.buying, "buying", -(amount * BigInt(offer.priceR.n)) / BigInt(offer.priceR.d));
  }
  for (const pool of pools) {
    const op = poolWithdrawOp(pool);
    shift(pool.reserves[0]!.asset, "amount", toStroops(String(op.metadata["minAmountA"])));
    shift(pool.reserves[1]!.asset, "amount", toStroops(String(op.metadata["minAmountB"])));
  }
  // the lines the withdraws would overflow are raised to the maximum limit first
  const raised = new Set(
    [...poolPayouts(audit, pools)].filter(([, p]) => p.raise).map(([key]) => key),
  );
  shift(
    { kind: "native" },
    "amount",
    -BigInt(feePerOpStroops) * BigInt(offers.length + pools.length + raised.size),
  );
  const atLeastZero = (v: bigint): string => stroopsToDecimal(v > 0n ? v : 0n);
  const cancelled = new Set(offers.map((o) => o.id));
  const withdrawn = new Set(pools.map((p) => p.poolId));
  return {
    ...audit,
    subentryCount: audit.subentryCount - offers.length,
    balances: audit.balances.map((b) => {
      const key = pathKey(b.asset);
      const d = delta.get(key);
      if (d === undefined) return b;
      return {
        ...b,
        ...(raised.has(key) ? { limit: stroopsToDecimal(MAX_TRUSTLINE_LIMIT_STROOPS) } : {}),
        amount: atLeastZero(toStroops(b.amount) + d.amount),
        sellingLiabilities: atLeastZero(toStroops(b.sellingLiabilities) + d.selling),
        buyingLiabilities: atLeastZero(toStroops(b.buyingLiabilities) + d.buying),
      };
    }),
    offers: audit.offers.filter((o) => !cancelled.has(o.id)),
    poolShares: audit.poolShares.map((p) =>
      withdrawn.has(p.poolId) ? { ...p, shareBalance: "0.0000000" } : p,
    ),
  };
}

function unwindEntries(
  audit: AccountAudit,
  targets: Pick<ClassicUnwindTargets, "offerIds" | "poolIds">,
): {
  readonly offers: readonly AccountAudit["offers"][number][];
  readonly pools: readonly AccountAudit["poolShares"][number][];
} {
  const offerIds = new Set(targets.offerIds);
  const poolIds = new Set(targets.poolIds);
  return {
    offers: audit.offers.filter((o) => offerIds.has(o.id)),
    pools: withdrawablePools(audit).filter((p) => poolIds.has(p.poolId)),
  };
}

// pool shares a withdraw can be built for: a positive balance and both reserves
function withdrawablePools(audit: AccountAudit): readonly AccountAudit["poolShares"][number][] {
  return audit.poolShares.filter(
    (p) =>
      hasPositive(p.shareBalance) && p.reserves[0] !== undefined && p.reserves[1] !== undefined,
  );
}
