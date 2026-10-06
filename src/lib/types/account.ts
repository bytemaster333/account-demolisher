// domain types for the account audit. consumers downstream read AccountAudit
// and don't hit horizon directly

export type AssetIdentifier =
  | { readonly kind: "native" }
  | {
      readonly kind: "credit";
      readonly code: string;
      readonly issuer: string;
    }
  | {
      readonly kind: "liquidity_pool_shares";
      readonly poolId: string;
    }
  // a standalone SEP-41 token identified ONLY by its contract id (a custom token
  // transferred to the account, not a classic asset with a code:issuer form).
  // `symbol` is a best-effort display label read from the contract; it is never
  // trusted for identity (a hostile token can lie); identity is the contract id.
  | {
      readonly kind: "contract";
      readonly contractId: string;
      readonly symbol?: string;
    };

export interface AuditBalance {
  readonly asset: AssetIdentifier;
  // decimal string as returned by horizon. use BigInt for math
  readonly amount: string;
  readonly limit?: string;
  readonly buyingLiabilities: string;
  readonly sellingLiabilities: string;
  readonly isAuthorized?: boolean;
  readonly isAuthorizedToMaintainLiabilities?: boolean;
  readonly sponsor?: string;
}

export interface AuditSigner {
  readonly key: string;
  readonly type: "ed25519_public_key" | "sha256_hash" | "preauth_tx" | "ed25519_signed_payload";
  readonly weight: number;
  readonly sponsor?: string;
}

export interface AuditThresholds {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
  readonly masterWeight: number;
}

export interface AuditFlags {
  readonly authImmutable: boolean;
  readonly authRequired: boolean;
  readonly authRevocable: boolean;
  readonly authClawbackEnabled: boolean;
}

export interface OfferEntry {
  readonly id: string;
  readonly selling: AssetIdentifier;
  readonly buying: AssetIdentifier;
  readonly amount: string;
  readonly priceR: { readonly n: number; readonly d: number };
  readonly sponsor?: string;
}

export interface DataEntry {
  readonly name: string;
  // base64-encoded value, per horizon
  readonly value: string;
  readonly sponsor?: string;
}

export interface ClaimableBalanceEntry {
  readonly id: string;
  readonly asset: AssetIdentifier;
  readonly amount: string;
  readonly sponsor: string;
  // the raw Horizon claimants array; each entry carries its own predicate, which
  // filterClaimableNow evaluates for this account
  readonly predicate: unknown;
  readonly claimants: readonly string[];
  // whether the auditing account can claim this balance: its predicate evaluated
  // against the latest ledger close time and kept claimable for the signing
  // window. undefined in fixtures/legacy.
  readonly claimableNow?: boolean;
  // set only on a claimable-now credit balance whose asset has no trustline on
  // the account: the issuer's auth_required flag. false means the close can add
  // the trustline and then claim. unset when the issuer account does not exist.
  readonly issuerAuthRequired?: boolean;
}

export interface PoolShareEntry {
  readonly poolId: string;
  readonly poolType: "constant_product" | string;
  readonly shareBalance: string;
  // total pool shares outstanding, needed to size this holder's proportional
  // share of the reserves when computing a withdraw slippage floor
  readonly totalShares: string;
  readonly shareLimit: string;
  readonly fee: number;
  readonly reserves: ReadonlyArray<{
    readonly asset: AssetIdentifier;
    readonly amount: string;
  }>;
}

export interface SponsorshipInfo {
  readonly numSponsoring: number;
  readonly numSponsored: number;
  readonly sponsoredBy?: string;
  // claimable balances this account created with itself as a claimant and can
  // claim now, as far as the audit alone can tell (assessMergeability counts the
  // plan's actual claims). an account cannot sponsor its own trustlines, offers,
  // signers or data entries, so numSponsoring beyond this is foreign sponsorship
  // that blocks the merge.
  readonly coverable: number;
}

// whether the merge can proceed. mergeable:false → orchestrator surfaces
// reason and refuses to build the merge
export type Mergeability =
  | { readonly mergeable: true }
  | {
      readonly mergeable: false;
      readonly reason: "AUTH_IMMUTABLE" | "IS_SPONSOR" | "FROZEN_TRUSTLINE" | "SEQNUM_TOO_FAR";
      readonly detail?: string;
    };

export interface AccountAudit {
  readonly accountId: string;
  readonly sequence: string;
  readonly subentryCount: number;
  readonly homeDomain?: string;
  readonly thresholds: AuditThresholds;
  readonly flags: AuditFlags;
  readonly balances: readonly AuditBalance[];
  readonly signers: readonly AuditSigner[];
  readonly offers: readonly OfferEntry[];
  readonly data: readonly DataEntry[];
  readonly claimableBalances: readonly ClaimableBalanceEntry[];
  readonly poolShares: readonly PoolShareEntry[];
  readonly sponsorship: SponsorshipInfo;
  readonly requiresMultisig: boolean;
  readonly mergeability: Mergeability;
}
