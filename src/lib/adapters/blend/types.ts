// shared blend exit-step types — the contract between the pool/client modules,
// minimal pool reference. UI renders name, falls back to truncated id
export interface BlendPoolRef {
  readonly id: string;
  readonly name: string;
}

// minimal asset reference for repay/withdraw amounts
export interface BlendAssetRef {
  readonly code: string;
  // classical issuer g-address; absent for native XLM
  readonly issuer?: string;
  // underlying token contract id (SAC for classical assets)
  readonly contractId: string;
}

// base each step extends — lets the UI pluck pool ref + summary
interface BlendStepBase {
  readonly pool: BlendPoolRef;
  readonly summary: string;
}

// repay an outstanding borrow. amount is display-decimal scaled
export interface BlendRepayStep extends BlendStepBase {
  readonly kind: "repay";
  readonly asset: BlendAssetRef;
  readonly amount: string;
}

// withdraw a collateral position
export interface BlendWithdrawCollateralStep extends BlendStepBase {
  readonly kind: "withdraw_collateral";
  readonly asset: BlendAssetRef;
  readonly amount: string;
}

// withdraw a non-collateralized supply position
export interface BlendWithdrawSupplyStep extends BlendStepBase {
  readonly kind: "withdraw_supply";
  readonly asset: BlendAssetRef;
  readonly amount: string;
}

// claim BLND emissions accumulated on the pool
export interface BlendClaimEmissionsStep extends BlendStepBase {
  readonly kind: "claim_emissions";
  // always BLND in current v2, modeled explicitly for forward-compat
  readonly rewardAsset: BlendAssetRef;
}

// initiate a backstop withdrawal. v2 queue is 17 days
export interface BlendBackstopQueueWithdrawStep extends BlendStepBase {
  readonly kind: "backstop_queue_withdraw";
  // ISO-8601 date (UTC), e.g. "2026-06-01"
  readonly queueEndDate: string;
  readonly amount: string;
}

export type BlendExitStep =
  | BlendRepayStep
  | BlendWithdrawCollateralStep
  | BlendWithdrawSupplyStep
  | BlendClaimEmissionsStep
  | BlendBackstopQueueWithdrawStep;

// per-step status mirror of BatchStatus
export type BlendStepStatus = "pending" | "active" | "done" | "failed";
