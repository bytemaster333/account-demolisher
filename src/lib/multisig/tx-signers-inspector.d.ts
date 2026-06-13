// ambient declarations for @stellar-expert/tx-signers-inspector (pure JS upstream)
// just enough surface for inspector.ts; extend rather than `as unknown as`
declare module "@stellar-expert/tx-signers-inspector" {
  import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

  // weight-0 signers are filtered upstream
  export interface InspectorSignerDescriptor {
    readonly key: string;
    readonly weight: number;
    readonly isMaster?: boolean;
  }

  // single-source txs have exactly one entry of this shape
  export interface AccountSignatureRequirements {
    readonly type: "account_signature";
    readonly id: string;
    readonly minThreshold: number;
    readonly signers: readonly InspectorSignerDescriptor[];
    readonly thresholds?: { low: number; med: number; high: number };
  }

  // CAP-40 extraSigners; not used here
  export interface ExtraSignatureRequirements {
    readonly type: "extra_signature";
    readonly key: string;
  }

  export type SignatureRequirements = AccountSignatureRequirements | ExtraSignatureRequirements;

  export interface InspectorWarning {
    readonly code: string;
    readonly message: string;
    readonly data?: unknown;
  }

  export interface TransactionSignatureSchema {
    readonly requirements: readonly SignatureRequirements[];
    readonly warnings: readonly InspectorWarning[];
    discoverSigners(availableSigners?: readonly string[]): string[];
    checkFeasibility(signers: readonly string[]): boolean;
    checkAuthExtra(signers: readonly string[]): string[];
    getAllPotentialSigners(): string[];
  }

  // pre-fetched horizon account snapshot, saves a network round-trip
  export interface AccountInfo {
    readonly id: string;
    readonly thresholds: {
      readonly low_threshold: number;
      readonly med_threshold: number;
      readonly high_threshold: number;
    };
    readonly signers: ReadonlyArray<{ readonly key: string; readonly weight: number }>;
  }

  export interface InspectionOptions {
    readonly horizon?: string;
    readonly accountsInfo?: readonly AccountInfo[];
  }

  export function inspectTransactionSigners(
    tx: Transaction | FeeBumpTransaction,
    options?: InspectionOptions,
  ): Promise<TransactionSignatureSchema>;

  export function inspectAccountSigners(
    sourceAccount: string,
    options?: InspectionOptions,
  ): Promise<TransactionSignatureSchema>;
}
