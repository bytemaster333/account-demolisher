// plan domain types for the classic-demolition batcher and builder

import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import type { AssetIdentifier } from "@/lib/types/account";

export type ClassicOpKind =
  | "liquidity_pool_withdraw"
  | "manage_sell_offer_cancel"
  | "claim_claimable_balance"
  | "path_payment_strict_send"
  | "return_residue_to_issuer"
  | "send_residue_to_destination"
  | "change_trust_remove"
  | "manage_data_delete"
  | "set_options_clear_signers"
  | "account_merge"
  | "create_account_mediator";

export interface BatchedOperation {
  readonly kind: ClassicOpKind;
  // human-readable summary surfaced in the plan tree ui
  readonly summary: string;
  // op-level source override; omitted when it matches the tx source
  readonly source?: string;
  // kind-specific payload. see builder switch for accepted shapes
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type ClassicMemo =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "id"; readonly value: string }
  | { readonly type: "hash"; readonly value: string }
  | { readonly type: "return"; readonly value: string };

export interface ClassicBatch {
  readonly operations: readonly BatchedOperation[];
  readonly mediator?: { readonly publicKey: string; readonly fundingXlm: string };
  // final-destination address for the closure (cex or self-custody wallet)
  readonly destination: string;
  readonly memo?: ClassicMemo;
}

// per-asset path map injected by the orchestrator. keys are "native" for
// xlm or "<code>:<issuer>" for credit assets
export interface PathResultRef {
  readonly destinationAmount: string;
  readonly path: readonly AssetIdentifier[];
  readonly sourceAmount: string;
}

export interface BatchOptions {
  readonly destination: string;
  readonly useMediator: boolean;
  readonly mediatorPublicKey?: string;
  // user-opted-in cb ids. batcher emits a claim op for each id present in the audit
  readonly claimableBalanceIds?: readonly string[];
  // pathKey()s of credit assets the user has explicitly consented to send back
  // to their issuer when no XLM conversion path exists. Without consent, an
  // un-routable balance is left in place (and blocks the merge) rather than
  // being silently paid to the issuer.
  readonly returnToIssuerAssetKeys?: readonly string[];
  // pathKey()s of un-routable credit assets the user chose to send to the merge
  // destination instead of the issuer. Only valid when the destination already
  // holds a trustline for the asset (checked at preview time); otherwise the
  // payment would fail with op_no_trust.
  readonly sendToDestinationAssetKeys?: readonly string[];
  // forwarded into the plan summary; the actual forward tx lives in the orchestrator
  readonly userFallbackAddress?: string;
  readonly memo?: ClassicMemo;
}

export interface TransactionBuildResult {
  readonly transaction: Transaction | FeeBumpTransaction;
  // base64-encoded envelope xdr
  readonly xdr: string;
  // stroop-denominated string, stellar canonical fee
  readonly estimatedFee: string;
  readonly description: readonly BatchedOperation[];
}

// key used in the orchestrator's per-asset path map
export function pathKey(asset: AssetIdentifier): string {
  switch (asset.kind) {
    case "native":
      return "native";
    case "credit":
      return `${asset.code}:${asset.issuer}`;
    case "liquidity_pool_shares":
      return `pool:${asset.poolId}`;
  }
}

// progress + result shapes for the on-chain demolition run, emitted by the
// orchestrator's execute path and consumed by the page-flow machine / ui
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

export interface DemolishResult {
  readonly ok: boolean;
  readonly mergedTxHash?: string;
  readonly forwardTxHash?: string;
  readonly errors: readonly string[];
}
