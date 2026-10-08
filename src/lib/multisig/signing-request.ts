// a shared (multisig) account can't be closed step by step the way a single
// owner's is: every required signer must sign the same fixed transaction once,
// so the whole close (cleanup plus merge) has to be one classic transaction.
//
// this module turns a reviewed close into that bundled transaction, and gives the
// initiator and co-signers a plain-language inspection of it plus local signature
// accounting so nobody signs blind. the envelope (no secret material) is shared
// through the /api/plan relay, which stores it in memory and hands it to
// co-signers by link; signatures live inside the envelope and are merged with
// mergeSignatures.

import {
  BASE_FEE,
  SignerKey,
  StrKey,
  TransactionBuilder,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { CLOSE_MARKER_NAME } from "@/lib/metrics/close-marker";
import { mergeSignatures, signedSigners, trimToThreshold } from "@/lib/multisig/partial-xdr";
import { MAX_OPS_PER_TX, batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { shortAddress } from "@/lib/safe-display";
import { stroopsToDecimal } from "@/lib/stellar/amount";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";
import { pathKey, type BatchOptions, type ClassicBatch, type ClassicMemo } from "@/lib/types/plan";

export { mergeSignatures, signedSigners, trimToThreshold };

// co-signers have this long to sign before the transaction's timebounds expire.
// long enough for real-world coordination, short enough that a forgotten request
// expires cleanly rather than lingering and later failing on stale state.
export const SIGNING_WINDOW_SECONDS = 72 * 60 * 60;

// per-operation fee the bundle bids. it can't change once the first signer signs.
const BUNDLE_FEE_PER_OP = Number.parseInt(BASE_FEE, 10);

export interface CloseDisposal {
  // pathKey()s of credit assets to send to the merge destination (the
  // destination must already trust them, verified at preview time)
  readonly sendToDestinationAssetKeys?: readonly string[];
  // pathKey()s of credit assets to return to their issuer
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly memo?: ClassicMemo;
  // the claimable balances the reviewed plan claims; an empty list claims none.
  // required, because the batcher reads a missing list as "claim every balance
  // claimable now", which would claim balances nobody reviewed
  readonly claimableBalanceIds: readonly string[];
}

export interface BundleabilityResult {
  readonly ok: boolean;
  readonly reason?: string;
}

const POOL_SHARE_REASON =
  "This account holds a liquidity pool share, which must be withdrawn in its own transaction first. Withdraw it, or close with all signers present.";

// can this close be expressed as ONE signable classic transaction? Soroban
// positions, allowance revocations and standalone token moves each need their
// own transaction, the exchange-mediator flow is multi-step, and a classic pool
// share is withdrawn in its own leading batch, so none of those can be bundled
// into a single signing request; those accounts must be closed with all signers
// present.
export function assessBundleability(input: {
  readonly hasSorobanPositions: boolean;
  readonly hasSelectedAllowances: boolean;
  readonly useMediator: boolean;
  readonly hasClassicPoolShares: boolean;
  readonly hasSelectedHeldTokens: boolean;
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
  if (input.hasSelectedHeldTokens) {
    return {
      ok: false,
      reason:
        "Moving standalone tokens needs its own transaction per token, which can't be part of a single signing request. Remove them from the close, or close with all signers present.",
    };
  }
  if (input.hasClassicPoolShares) {
    return { ok: false, reason: POOL_SHARE_REASON };
  }
  return { ok: true };
}

// the weight a bundled close needs. stellar thresholds are independent bytes, so
// med or low can exceed high. the bundle always holds high ops (merge, signer
// cleanup) and medium ops (the close marker, trustline and offer cleanup), and
// core checks the low threshold at the transaction level, so the bundle needs
// the largest of the three (at least 1).
export function thresholdForClose(t: {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
}): number {
  return Math.max(1, t.low, t.medium, t.high);
}

// build the single bundled closure transaction for a multisig account. throws if
// the close doesn't fit in exactly one classic transaction (assessBundleability
// gates this up front). deterministic only: never a market sell that could fail
// and sink the signed bundle after everyone has already signed.
export function buildCloseTransaction(params: {
  readonly audit: AccountAudit;
  readonly destination: string;
  readonly network: NetworkConfig;
  readonly sourceAccount: Horizon.AccountResponse;
  readonly disposal: CloseDisposal;
  readonly timeoutSeconds?: number;
  // close time (unix seconds) of the latest ledger; anchors maxTime to the
  // network clock instead of this device's
  readonly ledgerCloseTime?: number;
}): Transaction {
  const { audit, destination, network, sourceAccount, disposal } = params;
  // the type requires it, but an untyped caller must not fall into claim-all
  if (!Array.isArray(disposal?.claimableBalanceIds)) {
    throw new Error(
      "buildCloseTransaction: the reviewed claimable balance selection is missing; pass [] to claim none.",
    );
  }

  const batchOptions: BatchOptions = {
    destination,
    useMediator: false,
    // the batcher's reserve checks (the close marker, a trustline a claim opens)
    // take fees off the spendable XLM, so they must use the fee this bundle bids
    feePerOpStroops: BUNDLE_FEE_PER_OP,
    claimableBalanceIds: disposal.claimableBalanceIds,
    ...(disposal.returnToIssuerAssetKeys
      ? { returnToIssuerAssetKeys: disposal.returnToIssuerAssetKeys }
      : {}),
    ...(disposal.sendToDestinationAssetKeys
      ? { sendToDestinationAssetKeys: disposal.sendToDestinationAssetKeys }
      : {}),
    ...(disposal.memo ? { memo: disposal.memo } : {}),
  };

  const batches = batchClassicDemolition(audit, batchOptions, undefined);
  if (batches.length === 0) {
    throw new Error(
      "buildCloseTransaction: the close produced no operations, so there is nothing to sign.",
    );
  }
  if (batches.length > 1) {
    throw new Error(`buildCloseTransaction: ${splitReason(audit, batches)}`);
  }

  const result = buildClassicTransaction(
    batches[0]!,
    sourceAccount,
    network,
    BUNDLE_FEE_PER_OP,
    params.timeoutSeconds ?? SIGNING_WINDOW_SECONDS,
    params.ledgerCloseTime,
  );
  // classic batches always build a classic Transaction (never a fee-bump)
  return result.transaction as Transaction;
}

// why the batcher split the close into more than one transaction. a pool share
// is always withdrawn in a leading transaction. otherwise a close that fits in
// one transaction by operation count was split only because a claim has to land
// first: into a trustline the close opens, or for an asset with no disposal
// chosen, whose balance can only be sized after the claim.
function splitReason(audit: AccountAudit, batches: readonly ClassicBatch[]): string {
  const leading = batches.slice(0, -1).flatMap((b) => b.operations);
  if (leading.some((op) => op.kind === "liquidity_pool_withdraw")) return POOL_SHARE_REASON;
  const opCount = batches.reduce((n, b) => n + b.operations.length, 0);
  if (opCount > MAX_OPS_PER_TX) {
    return (
      `this close needs ${opCount} operations, more than fit in one transaction, so it ` +
      "can't be a single signing request. Close with all signers present."
    );
  }
  const trusted = new Set(
    audit.balances.filter((b) => b.asset.kind === "credit").map((b) => pathKey(b.asset)),
  );
  const untrusted = new Map<string, string>();
  for (const op of leading) {
    if (op.kind !== "claim_claimable_balance") continue;
    const asset = op.metadata["asset"] as AssetIdentifier;
    if (asset.kind === "credit" && !trusted.has(pathKey(asset))) {
      untrusted.set(pathKey(asset), `${asset.code} issued by ${asset.issuer}`);
    }
  }
  if (untrusted.size > 0) {
    return (
      `this account doesn't trust ${[...untrusted.values()].join(", ")}, so claiming that ` +
      "claimable balance means opening the trustline and claiming in a transaction of its " +
      "own first. Leave the balance unclaimed, or close with all signers present."
    );
  }
  return (
    "a claimable balance in a credit asset has no disposal chosen (send it to the " +
    "destination or return it to its issuer), so it would have to be claimed in a " +
    "transaction of its own first. Choose a disposal for it, leave it unclaimed, or close " +
    "with all signers present."
  );
}

// ── envelope inspection (never blind-sign) ───────────────────────────────────
// a signer is being asked to permanently close an account and move its funds.
// opaque base64 is blind signing: a merge to an attacker looks the same as a
// benign close. so the transaction is decoded and every operation and
// transaction-level fact (fee, memo, time bounds, preconditions) is surfaced.
//
// "expected" steps are exactly the shapes the close builder emits: offer cancels
// (amount 0 on an existing offer id), claimable-balance claims, credit payments
// back to the issuer or to the merge destination, trustline removals, data entry
// deletes, the close marker pair, signer removals, the threshold reset and the
// merge itself. anything else is flagged danger and marked unexpected, because in
// a real request it can only come from a tampered or malicious initiator.

export interface OperationSummary {
  readonly type: string;
  readonly detail?: string;
  readonly destination?: string;
  readonly danger?: boolean;
  // the close builder never emits this operation shape
  readonly unexpected?: boolean;
}

export interface CloseMemo {
  readonly type: "none" | "id" | "text" | "hash" | "return";
  // text memos are decoded as utf-8 (hex when not valid utf-8); hash and return
  // memos are hex; id memos are the decimal id
  readonly value: string;
}

export interface ClosePreconditions {
  readonly ledgerBounds?: { readonly minLedger: number; readonly maxLedger: number };
  readonly minAccountSequence?: string;
  readonly minAccountSequenceAge?: string;
  readonly minAccountSequenceLedgerGap?: number;
  readonly extraSigners?: readonly string[];
}

export interface CloseInspection {
  readonly source: string;
  readonly operations: readonly OperationSummary[];
  readonly mergeDestination: string | null;
  readonly timeBounds: { readonly minTime: number; readonly maxTime: number } | null;
  // the maximum fee the transaction may charge, in stroops and in XLM
  readonly feeStroops: string;
  readonly feeXlm: string;
  readonly memo: CloseMemo;
  readonly sequence: string;
  // V2 preconditions beyond time bounds; null when there are none
  readonly preconditions: ClosePreconditions | null;
  // is this a well-formed account close (contains an account-merge)?
  readonly isClose: boolean;
}

interface AssetLike {
  isNative(): boolean;
  getCode(): string;
  getIssuer(): string;
}

interface PoolAssetLike {
  readonly assetA: AssetLike;
  readonly assetB: AssetLike;
  readonly fee: number;
}

// minimal structural view of a decoded operation, to read fields without `any`
interface RawOp {
  readonly type: string;
  readonly source?: string;
  readonly destination?: string;
  readonly amount?: string;
  readonly buyAmount?: string;
  readonly startingBalance?: string;
  readonly sendAmount?: string;
  readonly sendMax?: string;
  readonly destAmount?: string;
  readonly destMin?: string;
  readonly limit?: string;
  readonly price?: string;
  readonly offerId?: string;
  readonly name?: string;
  readonly value?: Uint8Array;
  readonly balanceId?: string;
  readonly liquidityPoolId?: string;
  readonly minAmountA?: string;
  readonly minAmountB?: string;
  readonly asset?: AssetLike;
  readonly sendAsset?: AssetLike;
  readonly destAsset?: AssetLike;
  readonly selling?: AssetLike;
  readonly buying?: AssetLike;
  readonly line?: AssetLike | PoolAssetLike;
  readonly claimants?: readonly { readonly destination: string }[];
  readonly signer?: {
    readonly ed25519PublicKey?: string;
    readonly preAuthTx?: Uint8Array;
    readonly sha256Hash?: Uint8Array;
    readonly ed25519SignedPayload?: string;
    readonly weight?: number;
  };
  readonly masterWeight?: number;
  readonly lowThreshold?: number;
  readonly medThreshold?: number;
  readonly highThreshold?: number;
  readonly setFlags?: number;
  readonly clearFlags?: number;
  readonly homeDomain?: string;
  readonly inflationDest?: string;
}

interface InspectContext {
  readonly mergeDestination: string | null;
  // the account being closed; every step of a close acts on it
  readonly closing: string;
  readonly txSource: string;
}

const UNEXPECTED =
  "A close never includes this operation. Do not sign unless you know exactly why it is here.";

function isPoolAsset(a: AssetLike | PoolAssetLike): a is PoolAssetLike {
  return (a as PoolAssetLike).assetA !== undefined;
}

// short label for an asset in an expected step: "XLM" or "CODE (GABCDE…WXYZ)"
function assetLabel(asset: AssetLike | PoolAssetLike): string {
  if (isPoolAsset(asset)) {
    return `the ${assetLabel(asset.assetA)} / ${assetLabel(asset.assetB)} pool share`;
  }
  return asset.isNative() ? "XLM" : `${asset.getCode()} (${shortAddress(asset.getIssuer())})`;
}

// full label for an asset in a danger step: the whole issuer, since a short
// prefix and suffix can be matched by a vanity key
function fullAssetLabel(asset: AssetLike): string {
  return asset.isNative() ? "XLM" : `${asset.getCode()} issued by ${asset.getIssuer()}`;
}

function humanizeOpType(type: string): string {
  const spaced = type.replace(/([A-Z])/g, " $1").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isZeroAmount(amount: string | undefined): boolean {
  return amount !== undefined && /^0+(\.0+)?$/.test(amount);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sentence(parts: readonly string[]): string {
  const joined = parts.join("; ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function unexpectedOp(type: string, detail: string, destination?: string): OperationSummary {
  return {
    type,
    detail: `${detail} ${UNEXPECTED}`,
    danger: true,
    unexpected: true,
    ...(destination ? { destination } : {}),
  };
}

function describeSetOptions(op: RawOp): OperationSummary {
  const expected: string[] = [];
  const unexpected: string[] = [];

  const s = op.signer;
  if (s !== undefined) {
    const weight = s.weight ?? 0;
    let label: string;
    // strkey form, the way horizon lists the account's signers
    if (typeof s.ed25519PublicKey === "string") label = `signer ${s.ed25519PublicKey}`;
    else if (s.preAuthTx !== undefined)
      label = `pre-authorized transaction signer ${StrKey.encodePreAuthTx(s.preAuthTx)}`;
    else if (s.sha256Hash !== undefined)
      label = `hash signer ${StrKey.encodeSha256Hash(s.sha256Hash)}`;
    else if (typeof s.ed25519SignedPayload === "string")
      label = `signed-payload signer ${s.ed25519SignedPayload}`;
    else label = "an unknown signer";
    if (weight === 0) expected.push(`removes ${label}`);
    else unexpected.push(`adds or changes ${label} to weight ${weight}`);
  }

  const thresholdsTouched =
    op.lowThreshold !== undefined ||
    op.medThreshold !== undefined ||
    op.highThreshold !== undefined;
  if (thresholdsTouched) {
    const allZero = [op.lowThreshold, op.medThreshold, op.highThreshold].every(
      (t) => t === undefined || t === 0,
    );
    const text = `sets signing thresholds to low ${op.lowThreshold ?? "unchanged"}, medium ${op.medThreshold ?? "unchanged"}, high ${op.highThreshold ?? "unchanged"}`;
    if (allZero) expected.push(text);
    else unexpected.push(text);
  }
  if (op.masterWeight !== undefined) {
    // the close's threshold reset sets the master weight to 1 so the merge can
    // still be signed; 0 would lock the account
    if (op.masterWeight === 1) expected.push("sets the master key weight to 1");
    else unexpected.push(`sets the master key weight to ${op.masterWeight}`);
  }
  if (op.setFlags !== undefined) unexpected.push(`sets account flags ${op.setFlags}`);
  if (op.clearFlags !== undefined) unexpected.push(`clears account flags ${op.clearFlags}`);
  if (op.homeDomain !== undefined) unexpected.push(`sets the home domain to "${op.homeDomain}"`);
  if (op.inflationDest !== undefined)
    unexpected.push(`sets the inflation destination to ${op.inflationDest}`);

  if (unexpected.length > 0) {
    return unexpectedOp("Change account settings", sentence([...unexpected, ...expected]));
  }
  if (expected.length === 0) {
    return unexpectedOp("Change account settings", "Changes no visible option.");
  }
  return { type: "Change account settings", detail: sentence(expected) };
}

function describeOffer(op: RawOp): OperationSummary {
  const amount = op.type === "manageBuyOffer" ? op.buyAmount : op.amount;
  const hasOfferId = op.offerId !== undefined && op.offerId !== "0";
  const pair =
    op.selling && op.buying
      ? `selling ${fullAssetLabel(op.selling)} for ${fullAssetLabel(op.buying)}`
      : "on an unknown asset pair";

  // only a zero amount on an existing offer id removes an offer. a passive offer
  // has no offer id and so can never be a cancel.
  if (op.type !== "createPassiveSellOffer" && isZeroAmount(amount) && hasOfferId) {
    if (op.type === "manageSellOffer") {
      return {
        type: "Cancel a DEX offer",
        detail: `Removes open offer ${op.offerId} (${pair}) from the order book.`,
      };
    }
    // the close builder cancels with manageSellOffer only
    return unexpectedOp(
      "Cancel a DEX buy offer",
      `Removes open buy offer ${op.offerId} (${pair}).`,
    );
  }

  const what =
    op.type === "manageBuyOffer"
      ? `buy ${amount ?? "an unknown amount"}`
      : `sell ${amount ?? "an unknown amount"}`;
  const offerRef = hasOfferId ? ` (updates offer ${op.offerId})` : "";
  return unexpectedOp(
    "Place a DEX offer",
    `Places an offer to ${what}, ${pair}, at price ${op.price ?? "unknown"}${offerRef}. This trades the account's funds on the order book.`,
  );
}

// a step that acts on another account (its own source) spends that account's
// funds or changes its settings, whatever the step itself looks like
function summarizeOp(op: RawOp, ctx: InspectContext): OperationSummary {
  const summary = summarizeOpShape(op, ctx);
  const actsOn = op.source ?? ctx.txSource;
  if (actsOn === ctx.closing) return summary;
  return unexpectedOp(
    summary.type,
    `${summary.detail ?? ""} This step acts on account ${actsOn}, not the account being closed.`.trim(),
    summary.destination,
  );
}

function summarizeOpShape(op: RawOp, ctx: InspectContext): OperationSummary {
  switch (op.type) {
    case "accountMerge":
      return {
        type: "Close this account",
        detail:
          "Sends any remaining XLM to the destination below and permanently deletes this account.",
        danger: true,
        ...(op.destination ? { destination: op.destination } : {}),
      };

    case "payment": {
      const amountText =
        op.amount && op.asset ? `${op.amount} ${fullAssetLabel(op.asset)}` : "funds";
      const dest = op.destination;
      if (op.asset && !op.asset.isNative() && dest !== undefined) {
        if (dest === op.asset.getIssuer()) {
          return {
            type: "Return an asset to its issuer",
            detail: `Returns ${op.amount ?? "the balance of"} ${assetLabel(op.asset)} to its issuer, which is how a trustline with no market is emptied before removal.`,
            destination: dest,
          };
        }
        if (ctx.mergeDestination !== null && dest === ctx.mergeDestination) {
          return {
            type: "Send an asset to the destination",
            detail: `Sends ${op.amount ?? "the balance of"} ${assetLabel(op.asset)} to the same destination as the close.`,
            destination: dest,
          };
        }
      }
      return unexpectedOp("Send a payment", `Sends ${amountText} to the address below.`, dest);
    }

    case "changeTrust": {
      if (op.line === undefined) return unexpectedOp("Change a trustline", "Changes a trustline.");
      if (isZeroAmount(op.limit)) {
        return {
          type: "Remove a trustline",
          detail: `Removes the trustline for ${assetLabel(op.line)}.`,
        };
      }
      const label = isPoolAsset(op.line) ? assetLabel(op.line) : fullAssetLabel(op.line);
      return unexpectedOp(
        "Add or change a trustline",
        `Sets the trustline for ${label} to limit ${op.limit ?? "unknown"}, which lets the account receive it.`,
      );
    }

    case "manageSellOffer":
    case "manageBuyOffer":
    case "createPassiveSellOffer":
      return describeOffer(op);

    case "claimClaimableBalance":
      return {
        type: "Claim a claimable balance",
        detail: `Claims balance ${shortAddress(op.balanceId ?? "")} into this account before it closes.`,
      };

    case "manageData": {
      const name = op.name ?? "";
      if (op.value === undefined) {
        if (name === CLOSE_MARKER_NAME) {
          return {
            type: "Close marker",
            detail: "Removes the Account Demolisher close marker set just before it.",
          };
        }
        return { type: "Delete a data entry", detail: `Deletes data entry "${name}".` };
      }
      if (name === CLOSE_MARKER_NAME) {
        return {
          type: "Close marker",
          detail:
            "Marks this transaction as an Account Demolisher close. The entry is removed again in the next step.",
        };
      }
      return unexpectedOp(
        "Write a data entry",
        `Writes data entry "${name}" with value ${toHex(op.value)}.`,
      );
    }

    case "setOptions":
      return describeSetOptions(op);

    case "liquidityPoolWithdraw":
      return {
        type: "Withdraw from a liquidity pool",
        detail: `Withdraws ${op.amount ?? "the"} pool shares from pool ${shortAddress(op.liquidityPoolId ?? "")} into this account (minimums ${op.minAmountA ?? "?"} and ${op.minAmountB ?? "?"}).`,
      };

    case "pathPaymentStrictReceive":
      return unexpectedOp(
        "Path payment",
        `Spends up to ${op.sendMax ?? "?"} ${op.sendAsset ? fullAssetLabel(op.sendAsset) : "of an asset"} so the address below receives exactly ${op.destAmount ?? "?"} ${op.destAsset ? fullAssetLabel(op.destAsset) : "of an asset"}.`,
        op.destination,
      );

    case "pathPaymentStrictSend":
      return unexpectedOp(
        "Path payment",
        `Spends ${op.sendAmount ?? "?"} ${op.sendAsset ? fullAssetLabel(op.sendAsset) : "of an asset"} so the address below receives at least ${op.destMin ?? "?"} ${op.destAsset ? fullAssetLabel(op.destAsset) : "of an asset"}.`,
        op.destination,
      );

    case "createAccount":
      return unexpectedOp(
        "Create an account",
        `Creates the account below and funds it with ${op.startingBalance ?? "?"} XLM.`,
        op.destination,
      );

    case "createClaimableBalance": {
      const claimants = (op.claimants ?? []).map((c) => c.destination);
      return unexpectedOp(
        "Create a claimable balance",
        `Locks ${op.amount ?? "?"} ${op.asset ? fullAssetLabel(op.asset) : "of an asset"} into a claimable balance for ${claimants.length > 0 ? claimants.join(", ") : "no listed claimant"}.`,
      );
    }

    default: {
      const amount = op.amount ?? op.startingBalance ?? op.sendAmount;
      const detail = amount
        ? `This operation moves ${amount}${op.asset ? ` ${fullAssetLabel(op.asset)}` : ""} or changes account state.`
        : "This operation can move value or change account state.";
      return unexpectedOp(humanizeOpType(op.type), detail, op.destination);
    }
  }
}

function describeMemo(tx: Transaction): CloseMemo {
  const memo = tx.memo;
  switch (memo.type) {
    case "none":
      return { type: "none", value: "" };
    case "id":
      return { type: "id", value: String(memo.value) };
    case "text": {
      const raw = memo.value as unknown;
      if (typeof raw === "string") return { type: "text", value: raw };
      const bytes = raw as Uint8Array;
      try {
        return { type: "text", value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch {
        return { type: "text", value: `hex ${toHex(bytes)}` };
      }
    }
    case "hash":
    case "return":
      return { type: memo.type, value: toHex(memo.value as Uint8Array) };
    default:
      return { type: "none", value: "" };
  }
}

function describePreconditions(tx: Transaction): ClosePreconditions | null {
  const out: {
    ledgerBounds?: { minLedger: number; maxLedger: number };
    minAccountSequence?: string;
    minAccountSequenceAge?: string;
    minAccountSequenceLedgerGap?: number;
    extraSigners?: string[];
  } = {};
  const lb = tx.ledgerBounds;
  if (lb !== undefined) out.ledgerBounds = { minLedger: lb.minLedger, maxLedger: lb.maxLedger };
  if (tx.minAccountSequence !== undefined) out.minAccountSequence = tx.minAccountSequence;
  const age = tx.minAccountSequenceAge;
  if (age !== undefined && age !== null && String(age) !== "0") {
    out.minAccountSequenceAge = String(age);
  }
  const gap = tx.minAccountSequenceLedgerGap;
  if (gap !== undefined && gap !== 0) out.minAccountSequenceLedgerGap = gap;
  const extra = tx.extraSigners;
  if (extra !== undefined && extra.length > 0) {
    out.extraSigners = extra.map((k) => SignerKey.encodeSignerKey(k));
  }
  return Object.keys(out).length === 0 ? null : out;
}

// decode a signing request's transaction into a plain-language summary. returns
// null for anything that isn't a classic transaction (fee-bumps have no ops).
export function inspectClose(xdrStr: string, passphrase: string): CloseInspection | null {
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXdr(xdrStr, passphrase) as Transaction;
  } catch {
    return null;
  }
  if (!Array.isArray((tx as { operations?: unknown }).operations)) return null;

  const rawOps = tx.operations as unknown as readonly RawOp[];
  const mergeOp = rawOps.find((o) => o.type === "accountMerge");

  // the account being closed is the accountMerge op's EFFECTIVE source
  // (op.source ?? tx.source), NOT blindly tx.source. the relay binds the signer
  // set to that account, so /sign must display and audit the same one.
  const closingSource = mergeOp?.source ?? tx.source;
  const ctx: InspectContext = {
    mergeDestination: mergeOp?.destination ?? null,
    closing: closingSource,
    txSource: tx.source,
  };

  const tb = tx.timeBounds;
  const timeBounds =
    tb !== undefined ? { minTime: Number(tb.minTime), maxTime: Number(tb.maxTime) } : null;

  return {
    source: closingSource,
    operations: rawOps.map((op) => summarizeOp(op, ctx)),
    mergeDestination: ctx.mergeDestination,
    timeBounds,
    feeStroops: tx.fee,
    feeXlm: stroopsToDecimal(BigInt(tx.fee)),
    memo: describeMemo(tx),
    sequence: tx.sequence,
    preconditions: describePreconditions(tx),
    isClose: mergeOp !== undefined,
  };
}
