// state ids, event types, and context shapes for the orchestrator machine
// no client-side persistence; on resume the machine starts from idle and re-runs discovery

import type { Horizon } from "@stellar/stellar-sdk";

import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicMemo } from "@/lib/types/plan";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";

export const STATES = {
  idle: "idle",
  discovering: "discovering",
  previewing: "previewing",
  awaitingConfirmation: "awaitingConfirmation",
  multisigCollection: "multisigCollection",
  executing: "executing",
  succeeded: "succeeded",
  failed: "failed",
  failedRecoverable: "failed.recoverable",
  failedFatal: "failed.fatal",
} as const;

export type StateId = (typeof STATES)[keyof typeof STATES];

export interface DiscoverEvent {
  readonly type: "DISCOVER";
}

export interface UserConfirmEvent {
  readonly type: "USER_CONFIRM";
}

export interface UserCancelEvent {
  readonly type: "USER_CANCEL";
}

export interface UserConsentEvent {
  readonly type: "USER_CONSENT";
  readonly nodeId: string;
}

export interface RetryEvent {
  readonly type: "RETRY";
}

export interface ResetEvent {
  readonly type: "RESET";
}

// multisig coordination events emitted by the multisigCollection state's UI
export interface MultisigRequiredEvent {
  readonly type: "MULTISIG_REQUIRED";
  readonly canonicalXdr: string;
  readonly sourceAccountId: string;
  readonly required: MultisigRequirement;
  // signer key that produced canonicalXdr (already counted)
  readonly initialSignerKey: string;
}

// merge a new partial into the canonical and re-evaluate the threshold
export interface AddSignatureEvent {
  readonly type: "ADD_SIGNATURE";
  readonly partialXdr: string;
  readonly signerKey: string;
}

// "here's the final envelope, skip ahead" — used by refractor and the
// partial-xdr path once they know the envelope is complete
export interface MultisigCompleteEvent {
  readonly type: "MULTISIG_COMPLETE";
  readonly signedXdr: string;
  readonly signerKeys: readonly string[];
}

export interface MultisigCancelEvent {
  readonly type: "MULTISIG_CANCEL";
}

export interface MultisigRequirement {
  readonly threshold: number;
  readonly signers: ReadonlyArray<{ readonly key: string; readonly weight: number }>;
}

export type OrchestratorEvent =
  | DiscoverEvent
  | UserConfirmEvent
  | UserCancelEvent
  | UserConsentEvent
  | RetryEvent
  | ResetEvent
  | MultisigRequiredEvent
  | AddSignatureEvent
  | MultisigCompleteEvent
  | MultisigCancelEvent;

export interface DiscoveryResult {
  readonly audit: AccountAudit;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  readonly latestLedger: number;
}

export interface OrchestratorOptions {
  readonly destination: string;
  readonly useMediator?: boolean;
  readonly mediatorPublicKey?: string;
  readonly selectedAllowances?: readonly string[];
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly userFallbackAddress?: string;
  readonly memo?: ClassicMemo;
  readonly maxRecoveryAttempts?: number;
}

// recoverable failures enter failed.recoverable; fatal is terminal
export interface OrchestratorFailure {
  readonly kind: "recoverable" | "fatal";
  readonly stage: "discovering" | "previewing" | "executing";
  readonly tag:
    | "seq-stale"
    | "fee-underestimated"
    | "slippage-exceeded"
    | "footprint-mismatch"
    | "allowlist-violation"
    | "multisig-threshold"
    | "needs-user-consent"
    | "simulation-failed"
    | "submission-failed"
    | "discovery-failed"
    | "unknown";
  readonly message: string;
  readonly nodeId?: string;
  readonly attempts: number;
  readonly cause?: unknown;
}

export interface OrchestratorContext {
  readonly publicKey: string;
  readonly options: OrchestratorOptions;
  discovery: DiscoveryResult | null;
  tree: PlanTree | null;
  currentNodeId: string | null;
  failure: OrchestratorFailure | null;
  attempts: number;
  receipts: Record<string, { txHash: string; ledger: number }>;
  // multisig state while in (or having visited) multisigCollection
  multisig: MultisigState | null;
}

export interface MultisigState {
  readonly sourceAccountId: string;
  readonly required: MultisigRequirement;
  // current envelope (canonical + merged signatures)
  readonly canonicalXdr: string;
  readonly gatheredSignerKeys: readonly string[];
  // cumulative weight under required
  readonly signaturesGathered: number;
  // fully-signed envelope once threshold is met
  readonly signedXdr: string | null;
}

export interface OrchestratorInput {
  readonly publicKey: string;
  readonly options: OrchestratorOptions;
  // separated from auditAccount so between-node re-reads stay cheap
  readonly loadAccount: (publicKey: string) => Promise<Horizon.AccountResponse>;
}

// statuses that mean "this node is done"
export const TERMINAL_NODE_STATUSES = new Set<PlanNode["status"]>([
  "confirmed",
  "skipped",
  "failed",
]);

export function isTerminalState(state: string): boolean {
  return state === STATES.succeeded || state === STATES.failedFatal;
}
