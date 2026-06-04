// per-failure classifier. takes a thrown/rejected error from any actor and
// returns a RecoveryDecision the machine dispatches on:
//   "retry"            - re-run after applying fixups (fee bump, seq refresh).
//   "surface-consent"  - wait for explicit USER_CONSENT (slippage).
//   "escalate-fatal"   - bail out.
//
// classification is pure; side effects (re-simulation, fee bump, seq refresh)
// happen inside the machine after the decision is returned.

import { Horizon, rpc } from "@stellar/stellar-sdk";

import { SimulationFailedError } from "@/lib/plan/simulator";
import type { OrchestratorFailure } from "./states";

export type RecoveryAction =
  | "retry"
  | "retry-with-fee-bump"
  | "retry-with-seq-refresh"
  | "retry-with-resimulate"
  | "surface-consent"
  | "escalate-fatal";

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  readonly failure: OrchestratorFailure;
  readonly feeMultiplier?: number;
  // for retry-with-seq-refresh: re-load the account before retrying.
  readonly refreshAccount?: boolean;
}

export interface ClassifyFailureInput {
  readonly error: unknown;
  readonly stage: OrchestratorFailure["stage"];
  readonly nodeId?: string;
  readonly attempts: number;
  readonly maxAttempts: number;
}

// classify into a RecoveryDecision. never throws. order: most-specific first.
// once attempts >= maxAttempts the decision rewrites to escalate-fatal.
export function classifyFailure(input: ClassifyFailureInput): RecoveryDecision {
  const { error, stage, nodeId, attempts, maxAttempts } = input;

  // horizon submission errors
  const horizonCode = extractHorizonResultCode(error);
  if (horizonCode !== null) {
    const decision = classifyHorizonCode(horizonCode, error);
    return applyAttemptsCap(
      decision,
      { stage, nodeId, attempts, message: decision.failure.message, cause: error },
      maxAttempts,
    );
  }

  // rpc sendTransaction errors
  const rpcSend = extractRpcSendError(error);
  if (rpcSend !== null) {
    return applyAttemptsCap(
      rpcSend,
      {
        stage,
        nodeId,
        attempts,
        message: rpcSend.failure.message,
        cause: error,
      },
      maxAttempts,
    );
  }

  // rpc getTransaction FAILED status
  const rpcGet = extractRpcGetFailure(error);
  if (rpcGet !== null) {
    return applyAttemptsCap(
      rpcGet,
      {
        stage,
        nodeId,
        attempts,
        message: rpcGet.failure.message,
        cause: error,
      },
      maxAttempts,
    );
  }

  // soroban simulation errors
  const simErr = extractSimulationFailure(error);
  if (simErr !== null) {
    return applyAttemptsCap(
      simErr,
      {
        stage,
        nodeId,
        attempts,
        message: simErr.failure.message,
        cause: error,
      },
      maxAttempts,
    );
  }

  // named errors (allow-list, multisig)
  const named = extractNamedError(error);
  if (named !== null) {
    return applyAttemptsCap(
      named,
      {
        stage,
        nodeId,
        attempts,
        message: named.failure.message,
        cause: error,
      },
      maxAttempts,
    );
  }

  // default: unknown shape -> fatal.
  const message = error instanceof Error ? error.message : String(error);
  return {
    action: "escalate-fatal",
    failure: {
      kind: "fatal",
      stage,
      tag: "unknown",
      message,
      ...(nodeId !== undefined ? { nodeId } : {}),
      attempts,
      cause: error,
    },
  };
}

// applies a fee bump fixup before retry. returns the next fee to use.
export interface ApplyFixupInput {
  readonly decision: RecoveryDecision;
  readonly previousFee: string;
}

export function applyFixup(input: ApplyFixupInput): { readonly nextFee: string } {
  const { decision, previousFee } = input;
  if (
    decision.action === "retry-with-fee-bump" &&
    decision.feeMultiplier !== undefined &&
    decision.feeMultiplier > 1
  ) {
    const previous = BigInt(previousFee || "0");
    const next = (previous * BigInt(Math.floor(decision.feeMultiplier * 1000))) / 1000n;
    return { nextFee: next.toString() };
  }
  return { nextFee: previousFee };
}

// duck-types the NetworkError shape since `instanceof` is unreliable through mocks.
export function extractHorizonResultCode(
  err: unknown,
): Horizon.HorizonApi.TransactionFailedResultCodes | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    response?: {
      data?: { extras?: { result_codes?: { transaction?: unknown } } };
    };
  };
  const code = e.response?.data?.extras?.result_codes?.transaction;
  if (typeof code !== "string") return null;
  const enumValues = Object.values(Horizon.HorizonApi.TransactionFailedResultCodes);
  if (!enumValues.includes(code as Horizon.HorizonApi.TransactionFailedResultCodes)) {
    return null;
  }
  return code as Horizon.HorizonApi.TransactionFailedResultCodes;
}

function classifyHorizonCode(
  code: Horizon.HorizonApi.TransactionFailedResultCodes,
  err: unknown,
): RecoveryDecision {
  switch (code) {
    case Horizon.HorizonApi.TransactionFailedResultCodes.TX_BAD_SEQ:
      // sequence advanced under us: re-load and retry.
      return {
        action: "retry-with-seq-refresh",
        refreshAccount: true,
        failure: {
          kind: "recoverable",
          stage: "executing",
          tag: "seq-stale",
          message:
            "Stellar rejected the transaction (tx_bad_seq); the account's sequence advanced under us. Re-loading and retrying.",
          attempts: 0,
          cause: err,
        },
      };
    case Horizon.HorizonApi.TransactionFailedResultCodes.TX_INSUFFICIENT_FEE:
      // fee too low: bump 2x and retry.
      return {
        action: "retry-with-fee-bump",
        feeMultiplier: 2,
        failure: {
          kind: "recoverable",
          stage: "executing",
          tag: "fee-underestimated",
          message:
            "Stellar rejected the transaction (tx_insufficient_fee). Bumping the fee 2× and retrying.",
          attempts: 0,
          cause: err,
        },
      };
    case Horizon.HorizonApi.TransactionFailedResultCodes.TX_TOO_LATE:
    case Horizon.HorizonApi.TransactionFailedResultCodes.TX_TOO_EARLY:
      // time bounds out of window: retry with a fresh envelope.
      return {
        action: "retry",
        failure: {
          kind: "recoverable",
          stage: "executing",
          tag: "submission-failed",
          message: `Stellar rejected the transaction (${code}); retrying with a fresh time bounds.`,
          attempts: 0,
          cause: err,
        },
      };
    default:
      return {
        action: "escalate-fatal",
        failure: {
          kind: "fatal",
          stage: "executing",
          tag: "submission-failed",
          message: `Stellar rejected the transaction (${code}).`,
          attempts: 0,
          cause: err,
        },
      };
  }
}

export interface RpcSendErrorLike {
  readonly status: rpc.Api.SendTransactionStatus;
  readonly hash?: string;
  readonly errorResult?: { result?: { switch?: () => { name: string } } } | unknown;
  readonly errorResultXdr?: string;
}

function extractRpcSendError(err: unknown): RecoveryDecision | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { status?: unknown; response?: { status?: unknown } } & RpcSendErrorLike;
  // allow wrappers that hold the raw response on `.response`.
  const innerCandidate =
    typeof candidate.status === "undefined" && candidate.response !== undefined
      ? (candidate.response as RpcSendErrorLike)
      : candidate;
  const inner = innerCandidate as RpcSendErrorLike & { errorResult?: unknown };
  const status = inner.status as string;
  if (typeof status !== "string") return null;
  if (status === "PENDING" || status === "DUPLICATE") return null;
  // FAILED belongs to getTransaction; yield to extractRpcGetFailure.
  if (status === "FAILED") return null;

  const code = pickErrorResultCode(inner.errorResult, inner.errorResultXdr);
  if (code === "txSorobanInvalid" || code === "txInsufficientFee") {
    // resource fee underrun: re-simulate with a bumped fee.
    return {
      action: "retry-with-fee-bump",
      feeMultiplier: 2,
      failure: {
        kind: "recoverable",
        stage: "executing",
        tag: "fee-underestimated",
        message: `Soroban RPC rejected the transaction (${code}). Re-simulating with bumped fee.`,
        attempts: 0,
        cause: err,
      },
    };
  }
  if (code === "txBadSeq") {
    return {
      action: "retry-with-seq-refresh",
      refreshAccount: true,
      failure: {
        kind: "recoverable",
        stage: "executing",
        tag: "seq-stale",
        message: "Soroban RPC reported tx_bad_seq; re-loading and retrying.",
        attempts: 0,
        cause: err,
      },
    };
  }
  if (inner.status === "TRY_AGAIN_LATER") {
    return {
      action: "retry",
      failure: {
        kind: "recoverable",
        stage: "executing",
        tag: "submission-failed",
        message: "Soroban RPC asked us to TRY_AGAIN_LATER; will retry.",
        attempts: 0,
        cause: err,
      },
    };
  }
  // ERROR with no recognizable code: fatal.
  return {
    action: "escalate-fatal",
    failure: {
      kind: "fatal",
      stage: "executing",
      tag: "submission-failed",
      message: `Soroban RPC rejected the transaction (status=${inner.status}${code ? `, code=${code}` : ""}).`,
      attempts: 0,
      cause: err,
    },
  };
}

// pull the switch.name out of a TransactionResult-shaped object; null on shape mismatch.
function pickErrorResultCode(
  errorResult: unknown,
  errorResultXdr: string | undefined,
): string | null {
  if (
    errorResult !== null &&
    typeof errorResult === "object" &&
    "result" in (errorResult as Record<string, unknown>)
  ) {
    const inner = (errorResult as { result?: { switch?: () => { name?: string } } }).result;
    if (typeof inner === "object" && inner !== null && typeof inner.switch === "function") {
      try {
        const sw = inner.switch();
        if (sw && typeof sw.name === "string") return sw.name;
      } catch {
        return null;
      }
    }
  }
  // some mocks put the code string directly.
  if (
    typeof errorResult === "object" &&
    errorResult !== null &&
    "code" in (errorResult as Record<string, unknown>)
  ) {
    const code = (errorResult as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (typeof errorResultXdr === "string" && errorResultXdr.length > 0) {
    // raw xdr decode is deferred to the diagnostic panel.
    return null;
  }
  return null;
}

interface RpcGetFailedShapeLike {
  readonly status: rpc.Api.GetTransactionStatus;
  readonly diagnosticTags?: readonly string[];
}

function extractRpcGetFailure(err: unknown): RecoveryDecision | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as RpcGetFailedShapeLike;
  if (candidate.status !== rpc.Api.GetTransactionStatus.FAILED) return null;
  const tags = candidate.diagnosticTags ?? [];
  // footprint/storage mismatch: re-simulate.
  if (tags.some((t) => /footprint|storage/i.test(t))) {
    return {
      action: "retry-with-resimulate",
      failure: {
        kind: "recoverable",
        stage: "executing",
        tag: "footprint-mismatch",
        message:
          "Soroban submission failed with a footprint/storage mismatch. Re-simulating to refresh the footprint.",
        attempts: 0,
        cause: err,
      },
    };
  }
  // slippage: surface for explicit user consent.
  if (tags.some((t) => /InsufficientOutputAmount|slippage/i.test(t))) {
    return {
      action: "surface-consent",
      failure: {
        kind: "recoverable",
        stage: "executing",
        tag: "slippage-exceeded",
        message:
          "Soroban submission failed: realized output below the slippage floor. The user must consent to the new quote before retrying.",
        attempts: 0,
        cause: err,
      },
    };
  }
  // no recoverable signal: fatal.
  return {
    action: "escalate-fatal",
    failure: {
      kind: "fatal",
      stage: "executing",
      tag: "submission-failed",
      message: "Soroban submission failed permanently (no recoverable signal in diagnostic tags).",
      attempts: 0,
      cause: err,
    },
  };
}

function extractSimulationFailure(err: unknown): RecoveryDecision | null {
  if (err instanceof SimulationFailedError) {
    const msg = err.upstreamError.toLowerCase();
    if (msg.includes("insufficient") && msg.includes("fee")) {
      // fee underestimated by simulator: bump and retry.
      return {
        action: "retry-with-fee-bump",
        feeMultiplier: 2,
        failure: {
          kind: "recoverable",
          stage: "previewing",
          tag: "fee-underestimated",
          message: `Simulation reports the resource fee is too low (${err.upstreamError}); bumping and retrying.`,
          attempts: 0,
          nodeId: err.nodeId,
          cause: err,
        },
      };
    }
    if (msg.includes("footprint") || msg.includes("storage")) {
      // stale footprint: re-simulate.
      return {
        action: "retry-with-resimulate",
        failure: {
          kind: "recoverable",
          stage: "previewing",
          tag: "footprint-mismatch",
          message: `Simulation footprint went stale (${err.upstreamError}); re-simulating.`,
          attempts: 0,
          nodeId: err.nodeId,
          cause: err,
        },
      };
    }
    if (msg.includes("slippage") || msg.includes("insufficientoutputamount")) {
      // slippage triggered: needs user consent.
      return {
        action: "surface-consent",
        failure: {
          kind: "recoverable",
          stage: "previewing",
          tag: "slippage-exceeded",
          message: `Simulation indicates slippage threshold violated (${err.upstreamError}); user consent required.`,
          attempts: 0,
          nodeId: err.nodeId,
          cause: err,
        },
      };
    }
    return {
      action: "escalate-fatal",
      failure: {
        kind: "fatal",
        stage: "previewing",
        tag: "simulation-failed",
        message: `Simulation failed: ${err.upstreamError}`,
        attempts: 0,
        nodeId: err.nodeId,
        cause: err,
      },
    };
  }
  return null;
}

function extractNamedError(err: unknown): RecoveryDecision | null {
  if (!(err instanceof Error)) return null;
  if (err.name === "AllowlistViolation") {
    return {
      action: "escalate-fatal",
      failure: {
        kind: "fatal",
        stage: "executing",
        tag: "allowlist-violation",
        message: `Allow-list guard rejected the transaction: ${err.message}`,
        attempts: 0,
        cause: err,
      },
    };
  }
  if (err.name === "MultisigThresholdNotMet") {
    return {
      action: "surface-consent",
      failure: {
        kind: "recoverable",
        stage: "executing",
        tag: "multisig-threshold",
        message: err.message,
        attempts: 0,
        cause: err,
      },
    };
  }
  return null;
}

interface ApplyAttemptsCapPatch {
  readonly stage: OrchestratorFailure["stage"];
  readonly nodeId: string | undefined;
  readonly attempts: number;
  readonly message: string;
  readonly cause: unknown;
}

function applyAttemptsCap(
  decision: RecoveryDecision,
  patch: ApplyAttemptsCapPatch,
  maxAttempts: number,
): RecoveryDecision {
  const merged: OrchestratorFailure = {
    ...decision.failure,
    stage: patch.stage,
    ...(patch.nodeId !== undefined ? { nodeId: patch.nodeId } : {}),
    attempts: patch.attempts,
    cause: patch.cause,
  };
  if (
    decision.action !== "escalate-fatal" &&
    decision.action !== "surface-consent" &&
    patch.attempts >= maxAttempts
  ) {
    return {
      action: "escalate-fatal",
      failure: {
        ...merged,
        kind: "fatal",
        message: `${merged.message} (gave up after ${patch.attempts} attempts)`,
      },
    };
  }
  return { ...decision, failure: merged };
}
