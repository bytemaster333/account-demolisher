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

// a strict-send quote for a small slice of the same balance through the same
// market (decimal strings, 7 places). Its rate is what a full-size conversion's
// price impact is measured against.
export interface ReferenceQuote {
  readonly sourceAmount: string;
  readonly destinationAmount: string;
}

// per-asset path map injected by the orchestrator. keys are "native" for
// xlm or "<code>:<issuer>" for credit assets
export interface PathResultRef {
  readonly destinationAmount: string;
  readonly path: readonly AssetIdentifier[];
  readonly sourceAmount: string;
  // without a reference the conversion is unpriced and needs per-asset confirmation
  readonly reference?: ReferenceQuote;
}

export interface BatchOptions {
  readonly destination: string;
  readonly useMediator: boolean;
  readonly mediatorPublicKey?: string;
  // Two-phase close (SEC-13): once the ephemeral mediator has been funded by an
  // earlier batch, a later re-audited batch must NOT re-emit the create-account
  // funding op (the mediator already exists; a second create_account reverts with
  // op_already_exists). The executor sets this on re-audit phases after the
  // funding op has landed.
  readonly mediatorAlreadyFunded?: boolean;
  // reviewed claimable-balance selection; [] claims none. Left undefined, every
  // collectable claimable-now balance is claimed (callers that showed the user a
  // list must pass the reviewed ids). Self-sponsored claimable balances are always
  // claimed: leaving one behind keeps num_sponsoring above zero and the merge fails.
  readonly claimableBalanceIds?: readonly string[];
  // pathKey()s of assets the user confirmed selling although the conversion is
  // over the price-impact cap or could not be priced against a reference quote
  readonly acceptedPriceImpactAssetKeys?: readonly string[];
  // reference quotes the user reviewed, per pathKey. A fresh reference that is
  // worse by more than the slippage tolerance blocks the conversion until the
  // user reviews the new price.
  readonly reviewedReferenceQuotes?: Readonly<Record<string, ReferenceQuote>>;
  // pathKey()s of credit assets the user has explicitly consented to send back
  // to their issuer. Without consent, a balance that can't be converted is left
  // in place (and blocks the merge) rather than being silently paid to the
  // issuer. An explicit choice wins over a market path found later.
  readonly returnToIssuerAssetKeys?: readonly string[];
  // pathKey()s of credit assets the user chose to send to the merge destination.
  // Only valid when the destination already holds a trustline for the asset
  // (checked at preview time); otherwise the payment would fail with op_no_trust.
  // Refused on a mediator close: the payment would reach the exchange's shared
  // address without the deposit memo.
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
    case "contract":
      return `contract:${asset.contractId}`;
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
