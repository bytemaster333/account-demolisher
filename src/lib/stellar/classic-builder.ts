// classic-transaction builder

import type { Horizon } from "@stellar/stellar-sdk";
import {
  Asset,
  BASE_FEE,
  LiquidityPoolAsset,
  Memo,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AssetIdentifier } from "@/lib/types/account";
import type {
  BatchedOperation,
  ClassicBatch,
  ClassicMemo,
  TransactionBuildResult,
} from "@/lib/types/plan";

const FIVE_MINUTES_SECONDS = 300;

export function buildClassicTransaction(
  batch: ClassicBatch,
  account: Horizon.AccountResponse,
  network: NetworkConfig,
  feeBase: number = Number.parseInt(BASE_FEE, 10),
): TransactionBuildResult {
  if (batch.operations.length === 0) {
    throw new Error("buildClassicTransaction: batch has no operations");
  }
  const fee = computeFee(feeBase, batch.operations.length);

  const builder = new TransactionBuilder(account, {
    fee,
    networkPassphrase: network.passphrase,
    ...(batch.memo ? { memo: toSdkMemo(batch.memo) } : {}),
  });

  for (const op of batch.operations) {
    builder.addOperation(addOperation(op));
  }

  builder.setTimeout(FIVE_MINUTES_SECONDS);

  const tx = builder.build();
  const envelopeXdr = tx.toEnvelope().toXDR("base64");
  return {
    transaction: tx,
    xdr: envelopeXdr,
    estimatedFee: fee,
    description: batch.operations,
  };
}

function computeFee(base: number, opCount: number): string {
  // fee is u32 stroops; worst case 100 * 100 = 10000, well under the ceiling
  return (base * opCount).toString();
}

function toSdkMemo(memo: ClassicMemo): Memo {
  switch (memo.type) {
    case "text":
      return Memo.text(memo.value);
    case "id":
      return Memo.id(memo.value);
    case "hash":
      return Memo.hash(memo.value);
    case "return":
      return Memo.return(memo.value);
  }
}

function addOperation(op: BatchedOperation): xdr.Operation {
  switch (op.kind) {
    case "create_account_mediator":
      return Operation.createAccount({
        destination: requireString(op.metadata, "destination"),
        startingBalance: requireString(op.metadata, "startingBalance"),
        ...(op.source ? { source: op.source } : {}),
      });

    case "liquidity_pool_withdraw":
      return Operation.liquidityPoolWithdraw({
        liquidityPoolId: requireString(op.metadata, "liquidityPoolId"),
        amount: requireString(op.metadata, "amount"),
        minAmountA: requireString(op.metadata, "minAmountA"),
        minAmountB: requireString(op.metadata, "minAmountB"),
        ...(op.source ? { source: op.source } : {}),
      });

    case "manage_sell_offer_cancel": {
      const selling = toAsset(requireAsset(op.metadata, "selling"));
      const buying = toAsset(requireAsset(op.metadata, "buying"));
      const priceN = requireNumber(op.metadata, "priceN");
      const priceD = requireNumber(op.metadata, "priceD");
      return Operation.manageSellOffer({
        selling,
        buying,
        amount: "0",
        // price must be a positive ratio even when amount=0; reuse the
        // original priceR so the cancel mirrors the live offer
        price: { n: priceN || 1, d: priceD || 1 },
        offerId: requireString(op.metadata, "offerId"),
        ...(op.source ? { source: op.source } : {}),
      });
    }

    case "claim_claimable_balance":
      return Operation.claimClaimableBalance({
        balanceId: requireString(op.metadata, "balanceId"),
        ...(op.source ? { source: op.source } : {}),
      });

    case "path_payment_strict_send": {
      const sendAsset = toAsset(requireAsset(op.metadata, "sendAsset"));
      const destAsset = toAsset(requireAsset(op.metadata, "destAsset"));
      const rawPath = op.metadata["path"];
      const pathAssets = Array.isArray(rawPath)
        ? rawPath.map((a) => toAsset(a as AssetIdentifier))
        : [];
      return Operation.pathPaymentStrictSend({
        sendAsset,
        sendAmount: requireString(op.metadata, "sendAmount"),
        destination: requireString(op.metadata, "destination"),
        destAsset,
        destMin: requireString(op.metadata, "destMin"),
        path: pathAssets,
        ...(op.source ? { source: op.source } : {}),
      });
    }

    case "return_residue_to_issuer": {
      const asset = toAsset(requireAsset(op.metadata, "asset"));
      return Operation.payment({
        destination: requireString(op.metadata, "destination"),
        asset,
        amount: requireString(op.metadata, "amount"),
        ...(op.source ? { source: op.source } : {}),
      });
    }

    case "change_trust_remove": {
      const asset = requireAsset(op.metadata, "asset");
      const line: Asset | LiquidityPoolAsset =
        asset.kind === "liquidity_pool_shares" ? toLiquidityPoolAsset(op.metadata) : toAsset(asset);
      return Operation.changeTrust({
        asset: line,
        limit: "0",
        ...(op.source ? { source: op.source } : {}),
      });
    }

    case "manage_data_delete":
      return Operation.manageData({
        name: requireString(op.metadata, "name"),
        value: null,
        ...(op.source ? { source: op.source } : {}),
      });

    case "revoke_sponsorship":
      return buildRevoke(op);

    case "set_options_clear_signers":
      return buildSetOptions(op);

    case "account_merge":
      return Operation.accountMerge({
        destination: requireString(op.metadata, "destination"),
        ...(op.source ? { source: op.source } : {}),
      });
  }
}

function buildRevoke(op: BatchedOperation): xdr.Operation {
  const subjectKind = requireString(op.metadata, "subjectKind");
  switch (subjectKind) {
    case "account":
      return Operation.revokeAccountSponsorship({
        account: requireString(op.metadata, "account"),
        ...(op.source ? { source: op.source } : {}),
      });
    case "trustline": {
      const asset = requireAsset(op.metadata, "asset");
      return Operation.revokeTrustlineSponsorship({
        account: requireString(op.metadata, "account"),
        asset: toAsset(asset),
        ...(op.source ? { source: op.source } : {}),
      });
    }
    case "offer":
      return Operation.revokeOfferSponsorship({
        seller: requireString(op.metadata, "seller"),
        offerId: requireString(op.metadata, "offerId"),
        ...(op.source ? { source: op.source } : {}),
      });
    case "data":
      return Operation.revokeDataSponsorship({
        account: requireString(op.metadata, "account"),
        name: requireString(op.metadata, "name"),
        ...(op.source ? { source: op.source } : {}),
      });
    case "claimable_balance":
      return Operation.revokeClaimableBalanceSponsorship({
        balanceId: requireString(op.metadata, "balanceId"),
        ...(op.source ? { source: op.source } : {}),
      });
    case "liquidity_pool":
      return Operation.revokeLiquidityPoolSponsorship({
        liquidityPoolId: requireString(op.metadata, "liquidityPoolId"),
        ...(op.source ? { source: op.source } : {}),
      });
    case "signer":
      return Operation.revokeSignerSponsorship({
        account: requireString(op.metadata, "account"),
        signer: { ed25519PublicKey: requireString(op.metadata, "signerKey") },
        ...(op.source ? { source: op.source } : {}),
      });
    default:
      throw new Error(`Unknown revoke subject: ${subjectKind}`);
  }
}

// set_options for clearing a non-master signer OR resetting thresholds
// the batcher emits one op per case to respect the sdk's single-signer rule
function buildSetOptions(op: BatchedOperation): xdr.Operation {
  const signerKey = op.metadata["signerKey"];
  if (typeof signerKey === "string") {
    return Operation.setOptions({
      signer: { ed25519PublicKey: signerKey, weight: 0 },
      ...(op.source ? { source: op.source } : {}),
    });
  }
  const t = op.metadata["thresholds"] as
    | { low?: number; medium?: number; high?: number; masterWeight?: number }
    | undefined;
  const low = t?.low ?? 0;
  const medium = t?.medium ?? 0;
  const high = t?.high ?? 0;
  const masterWeight = t?.masterWeight ?? 1;
  return Operation.setOptions({
    masterWeight,
    lowThreshold: low,
    medThreshold: medium,
    highThreshold: high,
    ...(op.source ? { source: op.source } : {}),
  });
}

function toAsset(id: AssetIdentifier): Asset {
  if (id.kind === "native") return Asset.native();
  if (id.kind === "credit") return new Asset(id.code, id.issuer);
  throw new Error(`Cannot convert pool-share identifier to Asset: ${id.poolId}`);
}

// pool-share trustline removal needs the LiquidityPoolAsset, not just the
// pool id. orchestrator hydrates metadata.poolAsset before this is called
function toLiquidityPoolAsset(meta: Record<string, unknown>): LiquidityPoolAsset {
  const poolAsset = meta["poolAsset"];
  if (poolAsset && typeof poolAsset === "object") {
    const pa = poolAsset as { assetA?: AssetIdentifier; assetB?: AssetIdentifier; fee?: number };
    if (pa.assetA && pa.assetB && typeof pa.fee === "number") {
      return new LiquidityPoolAsset(toAsset(pa.assetA), toAsset(pa.assetB), pa.fee);
    }
  }
  throw new Error(
    "change_trust pool-share removal requires metadata.poolAsset = { assetA, assetB, fee }; " +
      "orchestrator must hydrate the LP asset before calling buildClassicTransaction",
  );
}

function requireString(meta: Record<string, unknown>, key: string): string {
  const v = meta[key];
  if (typeof v !== "string") {
    throw new Error(`Missing required string metadata field: ${key}`);
  }
  return v;
}

function requireNumber(meta: Record<string, unknown>, key: string): number {
  const v = meta[key];
  if (typeof v !== "number") {
    throw new Error(`Missing required number metadata field: ${key}`);
  }
  return v;
}

function requireAsset(meta: Record<string, unknown>, key: string): AssetIdentifier {
  const v = meta[key];
  if (typeof v !== "object" || v === null) {
    throw new Error(`Missing required asset metadata field: ${key}`);
  }
  const kind = (v as { kind?: unknown }).kind;
  if (kind !== "native" && kind !== "credit" && kind !== "liquidity_pool_shares") {
    throw new Error(`Invalid asset identifier kind: ${String(kind)}`);
  }
  return v as AssetIdentifier;
}
