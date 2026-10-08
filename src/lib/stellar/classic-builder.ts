// classic-transaction builder

import type { Horizon } from "@stellar/stellar-sdk";
import {
  Asset,
  LiquidityPoolAsset,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import { closeMarkerOperations } from "@/lib/metrics/close-marker";
import { decimalToStroops } from "@/lib/stellar/amount";
import { toSdkMemo } from "@/lib/stellar/memo";
import type { AssetIdentifier } from "@/lib/types/account";
import type {
  BatchedOperation,
  ClassicBatch,
  ClassicOpKind,
  TransactionBuildResult,
} from "@/lib/types/plan";

export function buildClassicTransaction(
  batch: ClassicBatch,
  account: Horizon.AccountResponse,
  network: NetworkConfig,
  // per-operation base fee; the sdk multiplies it by the operation count
  feeBase: number,
  // signing window. the live execute path signs and submits within minutes
  // (DEFAULT_TX_VALIDITY_SECONDS). a multisig signing plan circulates for hours
  // or days, so its builder passes a much longer window (the tx must still be
  // valid when the last co-signer signs).
  timeoutSeconds: number,
  // close time (unix seconds) of the latest ledger, from fetchLedgerClock or
  // AccountAuditResult.ledger. maxTime is anchored to the network's clock, never
  // the browser's, which may be minutes off and turn every submit into
  // tx_too_late. required so no caller can fall back to the local clock.
  ledgerCloseTime: number,
): TransactionBuildResult {
  if (batch.operations.length === 0) {
    throw new Error("buildClassicTransaction: batch has no operations");
  }
  // validate the total fee (feeBase per op times opCount, which is what the sdk
  // and horizon charge) against the u32 ceiling before building
  const totalFee = computeFee(feeBase, batch.operations.length);

  const builder = new TransactionBuilder(account, {
    // the sdk's `fee` option is the per-operation base fee and it multiplies by
    // the operation count itself. passing the pre-multiplied total would make the
    // on-chain fee feeBase times opCount squared, a silent over-charge that also
    // defeats the surge cap and the u32 guard
    fee: String(feeBase),
    networkPassphrase: network.passphrase,
    ...(batch.memo ? { memo: toSdkMemo(batch.memo) } : {}),
  });

  for (const op of batch.operations) {
    builder.addOperation(addOperation(op));
  }

  if (!Number.isSafeInteger(ledgerCloseTime) || ledgerCloseTime <= 0) {
    throw new Error(`buildClassicTransaction: invalid ledger close time ${ledgerCloseTime}`);
  }
  builder.setTimebounds(0, ledgerCloseTime + timeoutSeconds);

  const tx = builder.build();
  const envelopeXdr = tx.toEnvelope().toXdr("base64");
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

// change_trust_add and the close marker kinds are spelled out here so the
// builder is ready before ClassicOpKind lists them; once it does, this is just
// ClassicOpKind. the marker has two spellings because the planner may emit
// either: close_marker with an action, or close_marker_set followed by a
// manage_data_delete of the marker name. both build the same two operations
type BuildableOpKind = ClassicOpKind | "change_trust_add" | "close_marker" | "close_marker_set";

function addOperation(op: BatchedOperation): xdr.Operation {
  // widened with `as` so control flow does not narrow it back to ClassicOpKind
  const kind = op.kind as BuildableOpKind;
  switch (kind) {
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
      const pathAssets = requirePath(op.metadata).map(toAsset);
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

    // a trustline added so a claimable balance of an untrusted asset can be
    // claimed in the same transaction. no limit means the maximum limit
    case "change_trust_add": {
      const asset = requireAsset(op.metadata, "asset");
      if (asset.kind !== "credit") {
        throw new Error(`change_trust_add needs a credit asset; got ${asset.kind}`);
      }
      const limit = op.metadata["limit"];
      // a malformed string throws in decimalToStroops; zero would remove the line
      if (limit !== undefined && (typeof limit !== "string" || decimalToStroops(limit) <= 0n)) {
        throw new Error(`change_trust_add limit must be a positive amount; got ${String(limit)}`);
      }
      return Operation.changeTrust({
        asset: toAsset(asset),
        ...(limit !== undefined ? { limit } : {}),
        ...(op.source ? { source: op.source } : {}),
      });
    }

    case "manage_data_delete":
      return Operation.manageData({
        name: requireString(op.metadata, "name"),
        value: null,
        ...(op.source ? { source: op.source } : {}),
      });

    // the marker pair goes immediately before the merge; the operations come from
    // the one module close verification matches against
    case "close_marker": {
      const action = op.metadata["action"];
      const [set, del] = closeMarkerOperations(op.source);
      if (action === "set") return set;
      if (action === "delete") return del;
      throw new Error(`close_marker action must be "set" or "delete"; got ${String(action)}`);
    }

    case "close_marker_set":
      return closeMarkerOperations(op.source)[0];

    case "set_options_clear_signers":
      return buildSetOptions(op);

    case "account_merge":
      return Operation.accountMerge({
        destination: requireString(op.metadata, "destination"),
        ...(op.source ? { source: op.source } : {}),
      });

    default: {
      // metadata can come back from storage, so an unknown kind is refused here
      // instead of handing the sdk an undefined operation
      const unknownKind: never = kind;
      throw new Error(`Unsupported classic operation kind: ${String(unknownKind)}`);
    }
  }
}

// set_options for clearing a non-master signer OR resetting thresholds
// the batcher emits one op per case to respect the sdk's single-signer rule
function buildSetOptions(op: BatchedOperation): xdr.Operation {
  const signerKey = op.metadata["signerKey"];
  if (typeof signerKey === "string") {
    return Operation.setOptions({
      signer: { ...signerRemoval(signerKey, op.metadata["signerType"]), weight: 0 },
      ...(op.source ? { source: op.source } : {}),
    });
  }
  // a privileged op: every field must be present and in range rather than
  // defaulted, so a batcher bug fails the build instead of resetting weights
  const t = op.metadata["thresholds"];
  if (typeof t !== "object" || t === null) {
    throw new Error("set_options threshold reset requires metadata.thresholds");
  }
  const thresholds = t as Record<string, unknown>;
  return Operation.setOptions({
    masterWeight: requireWeight(thresholds, "masterWeight"),
    lowThreshold: requireWeight(thresholds, "low"),
    medThreshold: requireWeight(thresholds, "medium"),
    highThreshold: requireWeight(thresholds, "high"),
    ...(op.source ? { source: op.source } : {}),
  });
}

// horizon reports each signer by its strkey (G..., T..., X..., P...) and its
// type; set_options takes each type in its own field
function signerRemoval(
  key: string,
  signerType: unknown,
):
  | { ed25519PublicKey: string }
  | { preAuthTx: Uint8Array }
  | { sha256Hash: Uint8Array }
  | { ed25519SignedPayload: string } {
  switch (signerType) {
    case "ed25519_public_key":
      return { ed25519PublicKey: key };
    case "preauth_tx":
      return { preAuthTx: StrKey.decodePreAuthTx(key) };
    case "sha256_hash":
      return { sha256Hash: StrKey.decodeSha256Hash(key) };
    case "ed25519_signed_payload":
      return { ed25519SignedPayload: key };
    default:
      throw new Error(`Unsupported signer type for removal: ${String(signerType)}`);
  }
}

function requireWeight(t: Record<string, unknown>, key: string): number {
  const v = t[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) {
    throw new Error(`set_options thresholds.${key} must be an integer 0-255; got ${String(v)}`);
  }
  return v;
}

function requirePath(meta: Record<string, unknown>): AssetIdentifier[] {
  const raw = meta["path"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("path_payment metadata.path must be an array of assets");
  }
  return raw.map((entry, i) => {
    const kind = (entry as { kind?: unknown } | null)?.kind;
    if (typeof entry !== "object" || entry === null || (kind !== "native" && kind !== "credit")) {
      throw new Error(`path_payment metadata.path[${i}] is not a native or credit asset`);
    }
    return entry as AssetIdentifier;
  });
}

function toAsset(id: AssetIdentifier): Asset {
  switch (id.kind) {
    case "native":
      return Asset.native();
    case "credit":
      return new Asset(id.code, id.issuer);
    case "liquidity_pool_shares":
      throw new Error(`Cannot convert pool-share identifier to Asset: ${id.poolId}`);
    case "contract":
      throw new Error(
        `Cannot convert a raw SEP-41 contract token to a classic Asset: ${id.contractId}`,
      );
  }
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
