// envelope handling shared by the initiator's Signatures step and the /sign page.
//
// the relay only ever hands back the same transaction with more signatures. the
// id in the link is that transaction's hash, so every envelope the relay sends
// is checked against it before anything is shown or signed. signatures are only
// ever added to the envelope a page already holds, so a late or stale relay
// response can't drop one. before submit the envelope is trimmed to the
// signatures stellar-core will actually use: an unused signature fails the whole
// transaction with tx_bad_auth_extra.

import {
  Keypair,
  TransactionBuilder,
  xdr,
  type FeeBumpTransaction,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

export class EnvelopeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeMismatchError";
  }
}

function isFeeBump(tx: Transaction | FeeBumpTransaction): tx is FeeBumpTransaction {
  return (tx as { innerTransaction?: unknown }).innerTransaction !== undefined;
}

export function transactionHashHex(tx: Transaction): string {
  return Buffer.from(tx.hash()).toString("hex");
}

// decode an envelope and require it to be the classic transaction the link names
export function decodePinned(envelopeXdr: string, passphrase: string, planId: string): Transaction {
  let decoded: Transaction | FeeBumpTransaction;
  try {
    decoded = TransactionBuilder.fromXdr(envelopeXdr, passphrase);
  } catch {
    throw new EnvelopeMismatchError("The signing request returned an unreadable transaction.");
  }
  if (isFeeBump(decoded)) {
    throw new EnvelopeMismatchError("The signing request returned a fee-bump, not the close.");
  }
  if (transactionHashHex(decoded) !== planId) {
    throw new EnvelopeMismatchError(
      "The signing request returned a different transaction than the one in the link. Nothing was changed.",
    );
  }
  return decoded;
}

// fold the signatures of a relay envelope into the one already held. the body
// always stays the held one; the incoming envelope only adds signatures, and only
// after it proves to be the same transaction. dedup is on the signature bytes, so
// the same signature under a different hint is not added twice.
export function mergeRelayEnvelope(
  held: string,
  incoming: string,
  passphrase: string,
  planId: string,
): string {
  const next = decodePinned(incoming, passphrase, planId);
  const base = decodePinned(held, passphrase, planId);
  const seen = new Set(
    base.signatures.map((s) => Buffer.from(s.signature.toBytes()).toString("hex")),
  );
  let added = false;
  for (const sig of next.signatures) {
    const k = Buffer.from(sig.signature.toBytes()).toString("hex");
    if (seen.has(k)) continue;
    seen.add(k);
    base.signatures.push(sig);
    added = true;
  }
  return added ? base.toXdr() : held;
}

export interface WeightedSigner {
  readonly key: string;
  readonly weight: number;
}

export interface CloseSignerSet {
  readonly signers: readonly WeightedSigner[];
  // weight the close needs. the bundle always has an accountMerge (high), usually
  // medium cleanup ops, and core checks the tx-level low threshold too. the three
  // are independent bytes, so the largest one is what the bundle needs.
  readonly required: number;
}

export function closeSignerSet(account: Horizon.AccountResponse): CloseSignerSet {
  const t = account.thresholds;
  return {
    signers: account.signers
      .filter((s) => s.type === "ed25519_public_key" && s.weight > 0)
      .map((s) => ({ key: s.key, weight: s.weight })),
    required: Math.max(1, t.low_threshold, t.med_threshold, t.high_threshold),
  };
}

export interface TrimResult {
  readonly xdr: string;
  // signer keys whose signatures were kept, in envelope order
  readonly kept: readonly string[];
  readonly weight: number;
  readonly met: boolean;
}

// keep only the signatures core will consume. core walks the envelope in order,
// counts each signature from a current signer once, and stops at the needed
// weight; anything left over is unused and fails the transaction. kept signatures
// get the canonical hint for their key, since core skips a signature whose hint
// does not match.
export function trimToThreshold(
  envelopeXdr: string,
  passphrase: string,
  signers: readonly WeightedSigner[],
  required: number,
): TrimResult {
  const decoded = TransactionBuilder.fromXdr(envelopeXdr, passphrase);
  if (isFeeBump(decoded)) throw new Error("trimToThreshold: fee-bump envelopes are not supported.");
  const tx = decoded;
  const hash = tx.hash();
  const remaining = signers.map((s) => ({ ...s, kp: Keypair.fromPublicKey(s.key) }));
  const keptSigs: xdr.DecoratedSignature[] = [];
  const kept: string[] = [];
  let weight = 0;
  for (const sig of tx.signatures) {
    if (weight >= required) break;
    const bytes = sig.signature.toBytes();
    const idx = remaining.findIndex((s) => s.kp.verify(hash, bytes));
    if (idx === -1) continue;
    const signer = remaining[idx]!;
    remaining.splice(idx, 1);
    keptSigs.push(
      new xdr.DecoratedSignature({ hint: signer.kp.signatureHint(), signature: bytes }),
    );
    kept.push(signer.key);
    weight += signer.weight;
  }
  tx.signatures.splice(0, tx.signatures.length, ...keptSigs);
  return { xdr: tx.toXdr(), kept, weight, met: weight >= required };
}
