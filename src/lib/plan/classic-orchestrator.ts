// classic demolition control loop: audit -> hydrate paths -> batch ->
// sign-and-submit (with optional mediator co-sign + post-merge forward).

import {
  Asset,
  BASE_FEE,
  Horizon,
  Memo,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

import { getPublicEnv } from "@/lib/config/env";
import type { NetworkConfig } from "@/lib/config/networks";
import { requestMediatorSignature } from "@/lib/mediator/client";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { lookupCex } from "@/lib/safety/cex-registry";
import { auditAccount } from "@/lib/stellar/account-audit";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { findPathToXLM } from "@/lib/stellar/path-finder";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";
import type { BatchedOperation, ClassicBatch, ClassicMemo, PathResultRef } from "@/lib/types/plan";
import { pathKey } from "@/lib/types/plan";
import type { Connector } from "@/lib/wallet/connector";

type HorizonAccountResponse = Horizon.AccountResponse;

export interface DemolishProgressEvent {
  readonly kind:
    | "audit"
    | "batch-built"
    | "submitting"
    | "submitted"
    | "rebatching"
    | "mediator-cosign"
    | "complete"
    | "blocked";
  readonly batchIndex?: number;
  readonly totalBatches?: number;
  readonly txHash?: string;
  readonly message: string;
}

export interface DemolishOptions {
  readonly destination: string;
  readonly useMediator: boolean;
  readonly memo?: ClassicMemo;
  readonly userFallbackAddress?: string;
  readonly selectedClaimableBalanceIds?: readonly string[];
}

export interface DemolishResult {
  readonly ok: boolean;
  readonly mergedTxHash?: string;
  readonly forwardTxHash?: string;
  readonly errors: readonly string[];
}

// runs the full classic flow; expected blockers return { ok: false }, only
// unexpected SDK/network errors propagate.
export async function executeClassicDemolition(
  publicKey: string,
  network: NetworkConfig,
  connector: Connector,
  options: DemolishOptions,
  onProgress: (event: DemolishProgressEvent) => void,
): Promise<DemolishResult> {
  // 1. audit
  onProgress({
    kind: "audit",
    message: `Auditing ${shorten(publicKey)} on ${network.id}...`,
  });
  const audit = await auditAccount(publicKey, network);

  if (!audit.mergeability.mergeable) {
    const reason = audit.mergeability.reason;
    const detail =
      "detail" in audit.mergeability && audit.mergeability.detail !== undefined
        ? `: ${audit.mergeability.detail}`
        : "";
    const message = `Account is not mergeable (${reason})${detail}.`;
    onProgress({ kind: "blocked", message });
    return { ok: false, errors: [message] };
  }

  // self-hosted + mediator isn't implemented yet; refuse explicitly.
  if (options.useMediator && getPublicEnv().NEXT_PUBLIC_DEPLOYMENT_MODE === "self-hosted") {
    const message =
      "Self-hosted deployment with mediator routing is not yet implemented. " +
      "Switch to the reference deployment (NEXT_PUBLIC_DEPLOYMENT_MODE=reference) " +
      "or disable useMediator to demolish directly to a non-CEX destination.";
    onProgress({ kind: "blocked", message });
    return { ok: false, errors: [message] };
  }

  // 2a. hydrate paths for credit balances.
  const paths = await hydratePaths(audit, network);

  // 2b. fetch mediator pubkey when routing through it.
  let mediatorPublicKey: string | undefined;
  if (options.useMediator) {
    try {
      mediatorPublicKey = await fetchMediatorPublicKey();
    } catch (err) {
      const message =
        err instanceof Error
          ? `Mediator route unavailable: ${err.message}`
          : "Mediator route unavailable.";
      onProgress({ kind: "blocked", message });
      return { ok: false, errors: [message] };
    }
  }

  // 3. batch.
  const batches = batchClassicDemolition(
    audit,
    {
      destination: options.destination,
      useMediator: options.useMediator,
      ...(mediatorPublicKey ? { mediatorPublicKey } : {}),
      ...(options.selectedClaimableBalanceIds
        ? { claimableBalanceIds: options.selectedClaimableBalanceIds }
        : {}),
      ...(options.userFallbackAddress ? { userFallbackAddress: options.userFallbackAddress } : {}),
      ...(options.memo ? { memo: options.memo } : {}),
    },
    paths,
  );

  if (batches.length === 0) {
    const message = "Batcher produced zero batches — nothing to demolish.";
    onProgress({ kind: "blocked", message });
    return { ok: false, errors: [message] };
  }

  // 2c. hydrate pool-share LP-asset metadata for the builder.
  await hydratePoolAssetMetadata(batches, network, audit);

  // 4. per-batch sign-and-submit loop; re-audit between batches for fresh state.
  const errors: string[] = [];
  let lastTxHash: string | undefined;
  let mergedTxHash: string | undefined;
  let workingAudit: AccountAudit = audit;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]!;
    const isFinal = i === batches.length - 1;
    onProgress({
      kind: "batch-built",
      batchIndex: i,
      totalBatches: batches.length,
      message: `Batch ${i + 1}/${batches.length} ready (${batch.operations.length} ops).`,
    });

    // (a) build.
    const account = await loadAccountResponse(publicKey, network);
    const built = buildClassicTransaction(batch, account, network);
    const transaction = built.transaction as Transaction;

    // (b) allow-list guard (no-op for pure classic).
    assertTransactionAllowed(transaction, network);

    // (c) wallet sign.
    const signed = await connector.signTransaction(transaction, network.passphrase);

    // (d) mediator co-sign on the final batch when merging into the mediator.
    let envelopeToSubmitXdr = signed.signedXdr;
    if (isFinal && options.useMediator && finalIsMergeToMediator(batch, mediatorPublicKey)) {
      onProgress({
        kind: "mediator-cosign",
        batchIndex: i,
        totalBatches: batches.length,
        message: "Requesting mediator co-signature for the merge envelope...",
      });
      const mediatorResult = await requestMediatorSignature(envelopeToSubmitXdr);
      if (!mediatorResult.ok) {
        const message = `Mediator rejected the envelope (${mediatorResult.code}): ${mediatorResult.reason}`;
        onProgress({ kind: "blocked", message });
        errors.push(message);
        return { ok: false, errors, ...(mergedTxHash ? { mergedTxHash } : {}) };
      }
      envelopeToSubmitXdr = mediatorResult.signedXdr;
    }

    // (e) submit.
    onProgress({
      kind: "submitting",
      batchIndex: i,
      totalBatches: batches.length,
      message: `Submitting batch ${i + 1}/${batches.length}...`,
    });
    const reconstructed = TransactionBuilder.fromXDR(envelopeToSubmitXdr, network.passphrase);
    const server = getHorizon(network);
    const submission = (await server.submitTransaction(reconstructed as Transaction)) as {
      readonly hash?: string;
    };
    const txHash = submission.hash ?? "<unknown-hash>";
    lastTxHash = txHash;
    onProgress({
      kind: "submitted",
      batchIndex: i,
      totalBatches: batches.length,
      txHash,
      message: `Batch ${i + 1}/${batches.length} submitted: ${txHash}.`,
    });

    if (isFinal) {
      mergedTxHash = txHash;
    } else {
      // re-audit so the next iteration sees post-state shifts.
      onProgress({
        kind: "rebatching",
        batchIndex: i,
        totalBatches: batches.length,
        message: "Re-auditing for the next batch...",
      });
      workingAudit = await auditAccount(publicKey, network);
      if (!workingAudit.mergeability.mergeable) {
        const reason = workingAudit.mergeability.reason;
        const message = `Mid-flight mergeability regression: ${reason}.`;
        onProgress({ kind: "blocked", message });
        errors.push(message);
        return { ok: false, errors, ...(lastTxHash ? { mergedTxHash: lastTxHash } : {}) };
      }
    }
  }

  // 5. post-merge mediator forward (reference deployment only).
  let forwardTxHash: string | undefined;
  if (options.useMediator && mediatorPublicKey !== undefined) {
    const forwardResult = await postMergeMediatorForward(
      publicKey,
      mediatorPublicKey,
      options,
      network,
      onProgress,
    );
    if (forwardResult.ok) {
      forwardTxHash = forwardResult.txHash;
    } else {
      errors.push(forwardResult.error);
    }
  }

  onProgress({
    kind: "complete",
    message: errors.length === 0 ? "Demolition complete." : "Demolition completed with errors.",
    ...(mergedTxHash ? { txHash: mergedTxHash } : {}),
  });

  return {
    ok: errors.length === 0,
    ...(mergedTxHash ? { mergedTxHash } : {}),
    ...(forwardTxHash ? { forwardTxHash } : {}),
    errors,
  };
}

// re-export of the cex registry helper for the UI side.
export function destinationIsCex(destination: string): boolean {
  return lookupCex(destination) !== null;
}

async function loadAccountResponse(
  publicKey: string,
  network: NetworkConfig,
): Promise<HorizonAccountResponse> {
  const server = getHorizon(network);
  return (await server.loadAccount(publicKey)) as HorizonAccountResponse;
}

// for each non-XLM credit balance, fetch a strictSendPaths route to native.
// pool-shares and native skipped.
async function hydratePaths(
  audit: AccountAudit,
  network: NetworkConfig,
): Promise<ReadonlyMap<string, PathResultRef>> {
  const out = new Map<string, PathResultRef>();
  for (const balance of audit.balances) {
    if (balance.asset.kind !== "credit") continue;
    if (!hasPositive(balance.amount)) continue;
    let path;
    try {
      path = await findPathToXLM(balance.asset, balance.amount, network);
    } catch {
      // path-finder outage: skip; batcher will use the return-to-issuer fallback.
      continue;
    }
    if (path !== null) {
      out.set(pathKey(balance.asset), path);
    }
  }
  return out;
}

// loads pool reserve metadata for each change_trust_remove the batcher emitted.
async function hydratePoolAssetMetadata(
  batches: readonly ClassicBatch[],
  network: NetworkConfig,
  audit: AccountAudit,
): Promise<void> {
  const poolIds = new Set<string>();
  for (const batch of batches) {
    for (const op of batch.operations) {
      if (op.kind !== "change_trust_remove") continue;
      const asset = op.metadata["asset"] as AssetIdentifier | undefined;
      if (!asset || asset.kind !== "liquidity_pool_shares") continue;
      poolIds.add(asset.poolId);
    }
  }
  if (poolIds.size === 0) return;

  const server = getHorizon(network);
  // prefer the audit's reserves snapshot before hitting horizon again.
  const auditPools = new Map(audit.poolShares.map((p) => [p.poolId, p]));

  const metadataByPoolId = new Map<
    string,
    { assetA: AssetIdentifier; assetB: AssetIdentifier; fee: number }
  >();
  for (const poolId of poolIds) {
    const fromAudit = auditPools.get(poolId);
    if (
      fromAudit !== undefined &&
      fromAudit.reserves[0] !== undefined &&
      fromAudit.reserves[1] !== undefined
    ) {
      metadataByPoolId.set(poolId, {
        assetA: fromAudit.reserves[0].asset,
        assetB: fromAudit.reserves[1].asset,
        fee: fromAudit.fee,
      });
      continue;
    }
    const pool = await server.liquidityPools().liquidityPoolId(poolId).call();
    const reserveA = pool.reserves[0];
    const reserveB = pool.reserves[1];
    if (!reserveA || !reserveB) {
      throw new Error(`Liquidity pool ${poolId} returned no reserve metadata.`);
    }
    metadataByPoolId.set(poolId, {
      assetA: serverAssetStringToIdentifier(reserveA.asset),
      assetB: serverAssetStringToIdentifier(reserveB.asset),
      fee: pool.fee_bp,
    });
  }

  // metadata objects are plain records; splice in a new one to keep the
  // frozen-shape promise.
  for (const batch of batches) {
    for (let i = 0; i < batch.operations.length; i += 1) {
      const op = batch.operations[i]!;
      if (op.kind !== "change_trust_remove") continue;
      const asset = op.metadata["asset"] as AssetIdentifier | undefined;
      if (!asset || asset.kind !== "liquidity_pool_shares") continue;
      const poolMeta = metadataByPoolId.get(asset.poolId);
      if (!poolMeta) continue;
      const hydrated: BatchedOperation = {
        ...op,
        metadata: {
          ...op.metadata,
          poolAsset: poolMeta,
        },
      };
      (batch.operations as BatchedOperation[])[i] = hydrated;
    }
  }
}

function serverAssetStringToIdentifier(asset: string): AssetIdentifier {
  if (asset === "native") return { kind: "native" };
  const parts = asset.split(":");
  return { kind: "credit", code: parts[0] ?? "", issuer: parts[1] ?? "" };
}

// reads the mediator pubkey from GET /api/mediator/sign. seed never leaves the server.
async function fetchMediatorPublicKey(): Promise<string> {
  const response = await fetch("/api/mediator/sign", { method: "GET" });
  if (!response.ok) {
    throw new Error(`Mediator discovery returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { mediatorPublicKey?: unknown };
  if (typeof body.mediatorPublicKey !== "string" || body.mediatorPublicKey.length === 0) {
    throw new Error("Mediator discovery response is missing `mediatorPublicKey`.");
  }
  return body.mediatorPublicKey;
}

// true iff the batch's last op merges into the configured mediator.
function finalIsMergeToMediator(batch: ClassicBatch, mediatorPublicKey?: string): boolean {
  if (mediatorPublicKey === undefined) return false;
  const last = batch.operations[batch.operations.length - 1];
  if (!last || last.kind !== "account_merge") return false;
  const dest = last.metadata["destination"];
  return typeof dest === "string" && dest === mediatorPublicKey;
}

// builds, co-signs and submits the post-merge forward envelope:
//   op[0] payment       mediator -> destination          (native)
//   op[1] accountMerge  mediator -> userFallbackAddress
async function postMergeMediatorForward(
  _userPublicKey: string,
  mediatorPublicKey: string,
  options: DemolishOptions,
  network: NetworkConfig,
  onProgress: (event: DemolishProgressEvent) => void,
): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
  // 1. load mediator account.
  const server = getHorizon(network);
  let mediatorAccount: Awaited<ReturnType<typeof server.loadAccount>>;
  try {
    mediatorAccount = await server.loadAccount(mediatorPublicKey);
  } catch (err) {
    const reason =
      err instanceof Error
        ? `Could not load mediator account: ${err.message}`
        : "Could not load mediator account.";
    onProgress({ kind: "blocked", message: reason });
    return { ok: false, error: reason };
  }

  const nativeBalance = mediatorAccount.balances.find((b) => b.asset_type === "native");
  if (!nativeBalance) {
    const reason = "Mediator account has no native balance to forward.";
    onProgress({ kind: "blocked", message: reason });
    return { ok: false, error: reason };
  }

  // keep 0.5 XLM for fee buffer; accountMerge reclaims the base reserve.
  const forwardAmount = subtractDecimal(nativeBalance.balance, "0.5000000");
  if (compareAmounts(forwardAmount, "0") <= 0) {
    const reason = `Mediator balance ${nativeBalance.balance} XLM is too low to forward after fee buffer.`;
    onProgress({ kind: "blocked", message: reason });
    return { ok: false, error: reason };
  }

  // 2. build unsigned forward.
  const fallback = options.userFallbackAddress ?? options.destination;
  const builder = new TransactionBuilder(mediatorAccount, {
    fee: (Number.parseInt(BASE_FEE, 10) * 2).toString(),
    networkPassphrase: network.passphrase,
    ...(options.memo ? { memo: classicMemoToSdk(options.memo) } : {}),
  });
  builder.addOperation(
    Operation.payment({
      destination: options.destination,
      asset: Asset.native(),
      amount: forwardAmount,
    }),
  );
  builder.addOperation(Operation.accountMerge({ destination: fallback }));
  builder.setTimeout(300);
  const unsignedTx = builder.build();
  const unsignedXdr = unsignedTx.toEnvelope().toXDR("base64");

  // 3. mediator co-sign via the forward validator.
  onProgress({
    kind: "mediator-cosign",
    message: "Requesting mediator signature for the forward envelope...",
  });
  const result = await requestMediatorSignature(unsignedXdr, { kind: "forward" });
  if (!result.ok) {
    const message = `Mediator rejected the forward envelope (${result.code}): ${result.reason}`;
    onProgress({ kind: "blocked", message });
    return { ok: false, error: message };
  }

  // 4. submit.
  onProgress({ kind: "submitting", message: "Submitting the forward envelope..." });
  const signedTx = TransactionBuilder.fromXDR(result.signedXdr, network.passphrase);
  const submission = (await server.submitTransaction(signedTx as Transaction)) as {
    readonly hash?: string;
  };
  const txHash = submission.hash ?? "<unknown-hash>";
  onProgress({
    kind: "submitted",
    txHash,
    message: `Forward envelope submitted: ${txHash}.`,
  });
  return { ok: true, txHash };
}

function classicMemoToSdk(memo: ClassicMemo): Memo {
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

// horizon balances come back as 7-decimal strings; treat as fixed-point stroops.

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

function subtractDecimal(a: string, b: string): string {
  return stroopsToDecimal(decimalToStroops(a) - decimalToStroops(b));
}

function compareAmounts(a: string, b: string): number {
  const sa = decimalToStroops(a);
  const sb = decimalToStroops(b);
  if (sa > sb) return 1;
  if (sa < sb) return -1;
  return 0;
}

function shorten(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function hasPositive(amountStr: string): boolean {
  for (const ch of amountStr) {
    if (ch >= "1" && ch <= "9") return true;
  }
  return false;
}

export type AccountResponse = Horizon.AccountResponse;
