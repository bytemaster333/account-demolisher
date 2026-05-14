// plan domain types for the classic-demolition batcher and builder.
//
// the batcher consumes AccountAudit and produces a sequence of ClassicBatches
// (one per tx, <= 100 ops each). the builder turns each batch into a
// Transaction. metadata is loosely typed and checked inside the builder
// switch — keeps the batcher/builder boundary clean.

import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import type { AssetIdentifier } from "@/lib/types/account";

export type ClassicOpKind =
  | "liquidity_pool_withdraw"
  | "manage_sell_offer_cancel"
  | "claim_claimable_balance"
  | "path_payment_strict_send"
  | "return_residue_to_issuer"
  | "change_trust_remove"
  | "manage_data_delete"
  | "revoke_sponsorship"
  | "set_options_clear_signers"
  | "account_merge"
  | "create_account_mediator";

export interface BatchedOperation {
  readonly kind: ClassicOpKind;
  // human-readable summary surfaced in the plan tree ui.
  readonly summary: string;
  // op-level source override; omitted when it matches the tx source.
  readonly source?: string;
  // kind-specific payload. see builder switch for accepted shapes.
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
  // final-destination address for the closure (cex or self-custody wallet).
  readonly destination: string;
  readonly memo?: ClassicMemo;
}

// per-asset path map injected by the orchestrator. keys are "native" for
// xlm or "<code>:<issuer>" for credit assets.
export interface PathResultRef {
  readonly destinationAmount: string;
  readonly path: readonly AssetIdentifier[];
  readonly sourceAmount: string;
}

export interface BatchOptions {
  readonly destination: string;
  readonly useMediator: boolean;
  readonly mediatorPublicKey?: string;
  // user-opted-in cb ids. batcher emits a claim op for each id present in the audit.
  readonly claimableBalanceIds?: readonly string[];
  // forwarded into the plan summary; the actual forward tx lives in the orchestrator.
  readonly userFallbackAddress?: string;
  readonly memo?: ClassicMemo;
}

export interface TransactionBuildResult {
  readonly transaction: Transaction | FeeBumpTransaction;
  // base64-encoded envelope xdr.
  readonly xdr: string;
  // stroop-denominated string, stellar canonical fee.
  readonly estimatedFee: string;
  readonly description: readonly BatchedOperation[];
}

// key used in the orchestrator's per-asset path map.
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
