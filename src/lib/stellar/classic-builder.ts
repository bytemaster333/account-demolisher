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
  // signing window. The live execute path signs+submits within minutes, so the
  // default is short. A multisig signing plan circulates for hours/days, so its
  // builder passes a much longer window (the tx must still be valid when the last
  // co-signer signs).
  timeoutSeconds: number = FIVE_MINUTES_SECONDS,
): TransactionBuildResult {
  if (batch.operations.length === 0) {
    throw new Error("buildClassicTransaction: batch has no operations");
  }
  // validate the TOTAL fee (feeBase per op × opCount, which is what the SDK and
  // Horizon actually charge) against the u32 ceiling before building.
  const totalFee = computeFee(feeBase, batch.operations.length);

  const builder = new TransactionBuilder(account, {
    // the SDK's `fee` option is the PER-OPERATION base fee; it multiplies by the
    // operation count internally. Pass feeBase, NOT the pre-multiplied total, or
    // the on-chain fee becomes feeBase × opCount² (a silent over-charge that also
    // defeats the surge cap and the u32 guard).
    fee: String(feeBase),
    networkPassphrase: network.passphrase,
    ...(batch.memo ? { memo: toSdkMemo(batch.memo) } : {}),
  });

  for (const op of batch.operations) {
    builder.addOperation(addOperation(op));
  }

  builder.setTimeout(timeoutSeconds);

  const tx = builder.build();
  const envelopeXdr = tx.toEnvelope().toXDR("base64");
  return {
    transaction: tx,
    xdr: envelopeXdr,
    // matches tx.fee now (feeBase × opCount), so what's shown equals what's spent
    estimatedFee: totalFee,
    description: batch.operations,
  };
}

// the transaction fee field is a u32 (stroops); a total above this cannot be
// encoded and horizon would reject the envelope
const MAX_U32_FEE = 0xffffffff;

function computeFee(base: number, opCount: number): string {
  // fee is u32 stroops. at the per-op minimum (base=100) a full 100-op batch is
  // 100 * 100 = 10000, well under the ceiling, but a surge-derived base can push
  // a large batch toward the u32 limit, so guard the total rather than assume it
  const total = base * opCount;
  if (total > MAX_U32_FEE) {
    throw new Error(
      `computeFee: total fee ${total} exceeds the u32 ceiling (${MAX_U32_FEE}); ` +
        `base=${base} stroops/op over ${opCount} ops`,
    );
  }
  return total.toString();
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

    // both dispose of an un-routable credit balance via a plain payment; only the
    // destination differs (the asset's issuer vs the merge destination), and it
    // is carried in metadata by the batcher.
    case "return_residue_to_issuer":
    case "send_residue_to_destination": {
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

    case "set_options_clear_signers":
      return buildSetOptions(op);

    case "account_merge":
      return Operation.accountMerge({
        destination: requireString(op.metadata, "destination"),
        ...(op.source ? { source: op.source } : {}),
      });
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
