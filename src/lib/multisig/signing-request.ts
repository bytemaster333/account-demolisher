// A shared (multisig) account can't be closed step-by-step the way a single
// owner's is: every required signer must sign the SAME fixed transaction once.
// So the whole close, cleanup + merge, has to be ONE classic transaction.
//
// This module turns a reviewed close into that single bundled transaction and
// packages it as a portable "signing request": the transaction XDR and nothing
// else, no secret material. Signatures live INSIDE the transaction (merged with
// mergeSignatures) and the request travels by link/paste, never uploaded to any
// server. It also provides the local inspection + signature accounting the
// initiator and co-signers need so no one ever blind-signs.

import { Keypair, TransactionBuilder, type Horizon, type Transaction } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { mergeSignatures } from "@/lib/multisig/partial-xdr";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import type { AccountAudit } from "@/lib/types/account";
import type { BatchOptions, ClassicMemo } from "@/lib/types/plan";

export { mergeSignatures };

// co-signers have this long to sign before the transaction's timebounds expire.
// long enough for real-world coordination, short enough that a forgotten request
// expires cleanly rather than lingering and later failing on stale state.
export const SIGNING_WINDOW_SECONDS = 72 * 60 * 60;

export interface CloseDisposal {
  // pathKey()s of credit assets to send to the merge destination (the
  // destination must already trust them, verified at preview time)
  readonly sendToDestinationAssetKeys?: readonly string[];
  // pathKey()s of credit assets to return to their issuer
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly memo?: ClassicMemo;
}

export interface BundleabilityResult {
  readonly ok: boolean;
  readonly reason?: string;
}

// can this close be expressed as ONE signable classic transaction? Soroban
// positions and allowance revocations each need their own transaction, and the
// exchange-mediator flow is multi-step, so none of those can be bundled into a
// single signing request; those accounts must be closed with all signers present.
export function assessBundleability(input: {
  readonly hasSorobanPositions: boolean;
  readonly hasSelectedAllowances: boolean;
  readonly useMediator: boolean;
}): BundleabilityResult {
  if (input.useMediator) {
    return {
      ok: false,
      reason:
        "Closing to an exchange uses a multi-step mediator flow that can't be bundled into a single signing request. Choose a self-custody destination instead.",
    };
  }
  if (input.hasSorobanPositions) {
    return {
      ok: false,
      reason:
        "This account has smart-contract (Soroban) positions, which each need their own transaction and can't be combined into one signing request. Unwind them first, or close with all signers present.",
    };
  }
  if (input.hasSelectedAllowances) {
    return {
      ok: false,
      reason:
        "Revoking token allowances needs a separate transaction per allowance, which can't be part of a single signing request. Revoke them first, or close with all signers present.",
    };
  }
  return { ok: true };
}

export interface RequiredSigner {
  readonly key: string;
  readonly weight: number;
}

// the account's ed25519 signer set that can actually sign a transaction (weight
// > 0). Hash/preauth signers can't produce a signature, so they're excluded.
export function requiredSigners(audit: AccountAudit): readonly RequiredSigner[] {
  return audit.signers
    .filter((s) => s.type === "ed25519_public_key" && s.weight > 0)
    .map((s) => ({ key: s.key, weight: s.weight }));
}

// accountMerge and the setOptions cleanup are high-threshold operations, so the
// weight that must be collected is the account's high threshold (min 1).
export function closeThreshold(audit: AccountAudit): number {
  return Math.max(1, audit.thresholds.high);
}

// build the single bundled closure transaction for a multisig account. Throws if
// the close doesn't fit in exactly one classic transaction (assessBundleability
// gates this up front). Deterministic-only: never a market sell that could fail
// and sink the signed bundle after everyone has already signed.
export function buildCloseTransaction(params: {
  readonly audit: AccountAudit;
  readonly destination: string;
  readonly network: NetworkConfig;
  readonly sourceAccount: Horizon.AccountResponse;
  readonly disposal?: CloseDisposal;
  readonly timeoutSeconds?: number;
}): Transaction {
  const { audit, destination, network, sourceAccount, disposal } = params;

  const batchOptions: BatchOptions = {
    destination,
    useMediator: false,
    ...(disposal?.returnToIssuerAssetKeys
      ? { returnToIssuerAssetKeys: disposal.returnToIssuerAssetKeys }
      : {}),
    ...(disposal?.sendToDestinationAssetKeys
      ? { sendToDestinationAssetKeys: disposal.sendToDestinationAssetKeys }
      : {}),
    ...(disposal?.memo ? { memo: disposal.memo } : {}),
  };

  const batches = batchClassicDemolition(audit, batchOptions, undefined);
  if (batches.length !== 1) {
    throw new Error(
      `buildCloseTransaction: closure needs ${batches.length} transactions, but a shared ` +
        `signing request requires exactly one bundled transaction ` +
        `(${batches.length > 1 ? "too many operations for one transaction" : "no operations produced"}).`,
    );
  }

  const result = buildClassicTransaction(
    batches[0]!,
    sourceAccount,
    network,
    undefined,
    params.timeoutSeconds ?? SIGNING_WINDOW_SECONDS,
  );
  // classic batches always build a classic Transaction (never a fee-bump)
  return result.transaction as Transaction;
}

// ── envelope inspection (never blind-sign) ───────────────────────────────────
// A signer is being asked to authorize permanently closing an account and moving
// its funds. Showing only opaque base64 XDR is blind signing: an accountMerge to
// an attacker's destination looks identical to a benign closure. We decode the
// transaction and surface, in plain language, what it actually does.

export interface OperationSummary {
  readonly type: string;
  readonly detail?: string;
  readonly destination?: string;
  readonly danger?: boolean;
}

export interface CloseInspection {
  readonly source: string;
  readonly operations: readonly OperationSummary[];
  readonly mergeDestination: string | null;
  readonly timeBounds: { readonly minTime: number; readonly maxTime: number } | null;
  // is this a well-formed account close (contains an account-merge)?
  readonly isClose: boolean;
}

// minimal structural view of a decoded operation, to read fields without `any`
interface RawOp {
  readonly type: string;
  readonly source?: string;
  readonly destination?: string;
  readonly amount?: string;
  readonly asset?: { isNative(): boolean; getCode(): string };
  readonly line?: { isNative(): boolean; getCode(): string };
  readonly signer?: { readonly ed25519PublicKey?: string; readonly weight?: number };
  readonly masterWeight?: number;
  readonly lowThreshold?: number;
  readonly medThreshold?: number;
  readonly highThreshold?: number;
}

function assetLabel(asset: { isNative(): boolean; getCode(): string }): string {
  try {
    return asset.isNative() ? "XLM" : asset.getCode();
  } catch {
    return "an asset";
  }
}

function humanizeOpType(type: string): string {
  const spaced = type.replace(/([A-Z])/g, " $1").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function shortId(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;
}

function describeSetOptions(op: RawOp): string {
  const parts: string[] = [];
  const signerKey = op.signer?.ed25519PublicKey;
  if (typeof signerKey === "string") {
    parts.push(
      op.signer?.weight === 0
        ? `removes signer ${shortId(signerKey)}`
        : `sets signer ${shortId(signerKey)} to weight ${op.signer?.weight}`,
    );
  }
  if (op.masterWeight !== undefined) parts.push(`master key weight to ${op.masterWeight}`);
  if (
    op.lowThreshold !== undefined ||
    op.medThreshold !== undefined ||
    op.highThreshold !== undefined
  ) {
    parts.push("adjusts signing thresholds");
  }
  if (parts.length === 0) return "Adjusts this account's options.";
  const joined = parts.join("; ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function summarizeOp(op: RawOp): OperationSummary {
  switch (op.type) {
    case "accountMerge":
      return {
        type: "Close this account",
        detail:
          "Sends any remaining XLM to the destination below and permanently deletes this account.",
        danger: true,
        ...(op.destination ? { destination: op.destination } : {}),
      };
    case "payment":
      return {
        type: "Send a payment",
        detail:
          op.amount && op.asset
            ? `Sends ${op.amount} ${assetLabel(op.asset)} to the destination below.`
            : "Moves funds to the destination below.",
        danger: true,
        ...(op.destination ? { destination: op.destination } : {}),
      };
    case "setOptions":
      return { type: "Change account settings", detail: describeSetOptions(op) };
    case "changeTrust":
      return {
        type: "Change a trustline",
        ...(op.line ? { detail: `For ${assetLabel(op.line)}.` } : {}),
      };
    default:
      return { type: humanizeOpType(op.type) };
  }
}

// decode a signing request's transaction into a plain-language summary. Returns
// null for anything that isn't a classic transaction (fee-bumps have no ops).
export function inspectClose(xdrStr: string, passphrase: string): CloseInspection | null {
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(xdrStr, passphrase) as Transaction;
  } catch {
    return null;
  }
  const candidate = tx as unknown as {
    operations?: readonly RawOp[];
    source?: string;
    timeBounds?: { minTime?: string | number; maxTime?: string | number };
  };
  if (!Array.isArray(candidate.operations)) return null;

  const rawOps = candidate.operations;
  const operations = rawOps.map(summarizeOp);
  const mergeOp = rawOps.find((o) => o.type === "accountMerge");
  const tb = candidate.timeBounds;
  const timeBounds =
    tb && (tb.minTime !== undefined || tb.maxTime !== undefined)
      ? { minTime: Number(tb.minTime ?? 0), maxTime: Number(tb.maxTime ?? 0) }
      : null;

  // the account being closed is the accountMerge op's EFFECTIVE source
  // (op.source ?? tx.source), NOT blindly tx.source. The relay binds the signer
  // set to that account, so /sign must display and audit the same one.
  const closingSource = mergeOp?.source ?? candidate.source;

  return {
    source: typeof closingSource === "string" ? closingSource : "",
    operations,
    mergeDestination: mergeOp?.destination ?? null,
    timeBounds,
    isClose: mergeOp !== undefined,
  };
}

// ── signature accounting (local, no server) ──────────────────────────────────
// Who among the required signers has already signed this envelope, derived from
// the transaction's own decorated signatures. Each candidate key is confirmed by
// verifying its signature over the transaction hash, not just a hint match.

export function signedSigners(
  xdrStr: string,
  passphrase: string,
  signerKeys: readonly string[],
): readonly string[] {
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(xdrStr, passphrase) as Transaction;
  } catch {
    return [];
  }
  if (typeof tx.hash !== "function" || !Array.isArray(tx.signatures)) return [];
  const hash = tx.hash();
  const out: string[] = [];
  for (const key of signerKeys) {
    let kp: Keypair;
    try {
      kp = Keypair.fromPublicKey(key);
    } catch {
      continue;
    }
    // verify by signature, hint-agnostic, to match the relay's signer counting
    // (a wallet with an unusual hint would otherwise be counted here but not
    // there, or vice-versa). The hint is not authoritative; the signature is.
    const signed = tx.signatures.some((ds) => kp.verify(hash, Buffer.from(ds.signature())));
    if (signed) out.push(key);
  }
  return out;
}

export function collectedWeight(
  signedKeys: readonly string[],
  audit: AccountAudit,
): number {
  const byKey = new Map(audit.signers.map((s) => [s.key, s.weight]));
  return signedKeys.reduce((sum, k) => sum + (byKey.get(k) ?? 0), 0);
}
