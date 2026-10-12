// signature handling for multisig envelopes: merging signatures from
// independently signed copies into one canonical envelope, trimming it to what
// core will consume, and counting who has signed

import {
  Keypair,
  TransactionBuilder,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";

export interface MergeOptions {
  // allowlist of public keys we admit signatures for
  readonly expectedSigners?: readonly string[];
}

// the weight a bundled close needs. stellar thresholds are independent bytes, so
// med or low can exceed high. the bundle always holds high ops (merge, signer
// cleanup) and medium ops (the close marker, trustline and offer cleanup), and
// core checks the low threshold at the transaction level, so the bundle needs
// the largest of the three (at least 1). the relay and the client both count
// with this one rule.
export function thresholdForClose(t: {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
}): number {
  return Math.max(1, t.low, t.medium, t.high);
}

// the XDR envelope holds at most 20 decorated signatures
export const MAX_ENVELOPE_SIGNATURES = 20;

export class TooManySignaturesError extends Error {
  constructor() {
    super(
      `A transaction envelope can carry at most ${MAX_ENVELOPE_SIGNATURES} signatures, and this one already has that many.`,
    );
    this.name = "TooManySignaturesError";
  }
}

export interface MergeResult {
  readonly xdr: string;
  // how many signatures the partials added to the canonical envelope
  readonly added: number;
}

// merges novel signatures from partialXdrs into canonicalXdr and returns the
// merged envelope. throws when a partial is for a different transaction, carries
// a signature from an unknown key, or would push the envelope past 20 signatures.
export function mergeSignatures(
  canonicalXdr: string,
  partialXdrs: readonly string[],
  networkPassphrase: string,
  options: MergeOptions = {},
): string {
  return mergeNewSignatures(canonicalXdr, partialXdrs, networkPassphrase, options).xdr;
}

// mergeSignatures, also reporting how many signatures were added, so a caller
// can skip further work when a partial brought nothing new
export function mergeNewSignatures(
  canonicalXdr: string,
  partialXdrs: readonly string[],
  networkPassphrase: string,
  options: MergeOptions = {},
): MergeResult {
  if (typeof canonicalXdr !== "string" || canonicalXdr.length === 0) {
    throw new Error("mergeSignatures: canonicalXdr must be a non-empty base64 string.");
  }
  if (typeof networkPassphrase !== "string" || networkPassphrase.length === 0) {
    throw new Error("mergeSignatures: networkPassphrase must be non-empty.");
  }

  const canonical = TransactionBuilder.fromXdr(canonicalXdr, networkPassphrase);
  if (!isClassicTransaction(canonical)) {
    throw new Error(
      "mergeSignatures: canonical envelope must be a classic Transaction; " +
        "fee-bump envelopes are not supported here.",
    );
  }
  const canonicalHash = canonical.hash();

  // collect candidate public keys. with expectedSigners we trust the
  // allowlist; without it we fall back to the tx + per-op source accounts
  const candidates = collectCandidateSigners(
    canonical,
    partialXdrs,
    networkPassphrase,
    options.expectedSigners,
  ).map((key) => Keypair.fromPublicKey(key));

  // dedup by the recovered signer key, not by wire bytes. the decorated
  // signature's 4-byte hint is attacker-chosen, so keying on wire bytes lets one
  // captured signature be replayed under many hints to bloat the envelope to the
  // 20-signature XDR cap and wedge the plan. One signature per authorized key is
  // exactly what weighted multisig needs, so recover each key and admit it once.
  const presentKeys = new Set<string>();
  // signature bytes already verified for a present key. ed25519 signatures are
  // deterministic and the sdk verifies strictly (no zip215), so the same bytes
  // can only be that key's signature again: a replay of the public envelope
  // under forged hints is recognised without a verify per signer.
  const presentSigs = new Set<string>();
  for (const sig of canonical.signatures) {
    const i = matchSigner(sig, canonicalHash, candidates);
    if (i === -1) continue;
    presentKeys.add(candidates[i]!.publicKey());
    presentSigs.add(Buffer.from(sig.signature.toBytes()).toString("hex"));
  }
  let added = 0;

  for (const partialXdr of partialXdrs) {
    if (typeof partialXdr !== "string" || partialXdr.length === 0) {
      throw new Error("mergeSignatures: every partialXdr must be a non-empty base64 string.");
    }

    const partial = TransactionBuilder.fromXdr(partialXdr, networkPassphrase);
    if (!isClassicTransaction(partial)) {
      throw new Error(
        "mergeSignatures: partial envelope must be a classic Transaction (fee-bump rejected).",
      );
    }

    if (!Buffer.from(partial.hash()).equals(Buffer.from(canonicalHash))) {
      throw new Error(
        "mergeSignatures: partial envelope's transaction hash differs from the canonical " +
          "(the partial was built from a different transaction; refusing to merge).",
      );
    }

    for (const decorated of partial.signatures) {
      const bytes = Buffer.from(decorated.signature.toBytes()).toString("hex");
      if (presentSigs.has(bytes)) continue;
      const i = matchSigner(decorated, canonicalHash, candidates);
      if (i === -1) {
        throw new Error(
          "mergeSignatures: partial envelope contains a signature that does not match " +
            "any known signer for the canonical transaction (rejected).",
        );
      }

      const kp = candidates[i]!;
      const signingKey = kp.publicKey();
      presentSigs.add(bytes);
      if (presentKeys.has(signingKey)) continue;
      if (canonical.signatures.length >= MAX_ENVELOPE_SIGNATURES) {
        throw new TooManySignaturesError();
      }
      // store with the canonical hint for the recovered key, so a forged hint
      // can never occupy a parallel slot for a signer that already signed.
      canonical.signatures.push(
        new xdr.DecoratedSignature({
          hint: kp.signatureHint(),
          signature: decorated.signature.toBytes(),
        }),
      );
      presentKeys.add(signingKey);
      added += 1;
    }
  }

  return { xdr: canonical.toXdr(), added };
}

// rebuild an envelope with exactly one verified signature per expected signer,
// in signer order, dropping junk, duplicates and signatures from other keys.
// used on publish so a padded envelope can't wedge later co-signers.
export function canonicalizeSignatures(
  envelopeXdr: string,
  networkPassphrase: string,
  expectedSigners: readonly string[],
): string {
  const tx = TransactionBuilder.fromXdr(envelopeXdr, networkPassphrase);
  if (!isClassicTransaction(tx)) {
    throw new Error("canonicalizeSignatures: fee-bump envelopes are not supported here.");
  }
  const hash = tx.hash();
  const keypairs = [...new Set(expectedSigners)].map((key) => Keypair.fromPublicKey(key));
  const original = [...tx.signatures];
  const owner = original.map((ds) => matchSigner(ds, hash, keypairs));
  tx.signatures.length = 0;
  keypairs.forEach((kp, i) => {
    const sig = original[owner.indexOf(i)];
    if (sig === undefined) return;
    if (tx.signatures.length >= MAX_ENVELOPE_SIGNATURES) throw new TooManySignaturesError();
    tx.signatures.push(
      new xdr.DecoratedSignature({ hint: kp.signatureHint(), signature: sig.signature.toBytes() }),
    );
  });
  return tx.toXdr();
}

export interface WeightedSigner {
  readonly key: string;
  readonly weight: number;
}

export interface TrimResult {
  readonly xdr: string;
  // signer keys whose signatures were kept, in envelope order
  readonly kept: readonly string[];
  readonly weight: number;
  readonly met: boolean;
}

// keep only the signatures core will consume. core walks the envelope in order,
// counts each signature from a signer once, and stops at the needed weight; a
// signature left over is unused and fails the transaction (tx_bad_auth_extra).
// kept signatures get their key's canonical hint, since core skips a signature
// whose hint doesn't match.
export function trimToThreshold(
  envelopeXdr: string,
  networkPassphrase: string,
  signers: readonly WeightedSigner[],
  required: number,
): TrimResult {
  const tx = TransactionBuilder.fromXdr(envelopeXdr, networkPassphrase);
  if (!isClassicTransaction(tx)) {
    throw new Error("trimToThreshold: fee-bump envelopes are not supported here.");
  }
  const hash = tx.hash();
  const keypairs = signers.map((s) => Keypair.fromPublicKey(s.key));
  const used = new Set<number>();
  const keptSigs: xdr.DecoratedSignature[] = [];
  const kept: string[] = [];
  let weight = 0;
  for (const sig of tx.signatures) {
    if (weight >= required) break;
    const idx = matchSigner(sig, hash, keypairs);
    // a second signature from the same signer is never consumed either
    if (idx === -1 || used.has(idx)) continue;
    used.add(idx);
    const signer = signers[idx]!;
    keptSigs.push(
      new xdr.DecoratedSignature({
        hint: keypairs[idx]!.signatureHint(),
        signature: sig.signature.toBytes(),
      }),
    );
    kept.push(signer.key);
    weight += signer.weight;
  }
  tx.signatures.splice(0, tx.signatures.length, ...keptSigs);
  return { xdr: tx.toXdr(), kept, weight, met: weight >= required };
}

// which of the given signer keys have signed this envelope, in signerKeys order.
// each key is confirmed by verifying a signature over the transaction hash; the
// hint only decides which key is tried first, so a wallet with an unusual hint
// is still counted. an envelope that doesn't parse has no signers.
export function signedSigners(
  envelopeXdr: string,
  networkPassphrase: string,
  signerKeys: readonly string[],
): readonly string[] {
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXdr(envelopeXdr, networkPassphrase);
  } catch {
    return [];
  }
  if (!isClassicTransaction(tx)) return [];
  const hash = tx.hash();
  const valid: { key: string; kp: Keypair }[] = [];
  for (const key of signerKeys) {
    try {
      valid.push({ key, kp: Keypair.fromPublicKey(key) });
    } catch {
      continue;
    }
  }
  const keypairs = valid.map((v) => v.kp);
  const signed = new Set<string>();
  for (const ds of tx.signatures) {
    const i = matchSigner(ds, hash, keypairs);
    if (i !== -1) signed.add(valid[i]!.key);
  }
  return signerKeys.filter((key) => signed.has(key));
}

export function isClassicTransaction(tx: Transaction | FeeBumpTransaction): tx is Transaction {
  // FeeBumpTransaction exposes feeSource + innerTransaction
  const candidate = tx as unknown as { feeSource?: unknown; innerTransaction?: unknown };
  return candidate.feeSource === undefined && candidate.innerTransaction === undefined;
}

// when expectedSigners is set we use it verbatim; otherwise fall back to the
// tx + per-op source accounts as the smallest defensible candidate set
function collectCandidateSigners(
  canonical: Transaction,
  partialXdrs: readonly string[],
  networkPassphrase: string,
  expectedSigners: readonly string[] | undefined,
): readonly string[] {
  if (expectedSigners && expectedSigners.length > 0) {
    return Array.from(new Set(expectedSigners));
  }

  const candidates = new Set<string>();
  candidates.add(canonical.source);
  for (const op of canonical.operations) {
    if (op.source) candidates.add(op.source);
  }

  // walk partials too as a safety net for hand-rolled envelopes
  for (const partial of partialXdrs) {
    try {
      const tx = TransactionBuilder.fromXdr(partial, networkPassphrase);
      if (!isClassicTransaction(tx)) continue;
      candidates.add(tx.source);
      for (const op of tx.operations) {
        if (op.source) candidates.add(op.source);
      }
    } catch {
      // defer parse errors to the main loop
    }
  }

  return Array.from(candidates);
}

// index of the keypair that made sig over txHash, or -1. keys whose hint matches
// are tried first and the rest only when none of them verifies (a wallet with an
// unusual hint), so a normal envelope costs one ed25519 check per signature
// instead of one per signer.
export function matchSigner(
  sig: xdr.DecoratedSignature,
  txHash: Uint8Array,
  keypairs: readonly Keypair[],
): number {
  const hint = Buffer.from(sig.hint.toBytes());
  const signature = sig.signature.toBytes();
  const hinted = keypairs.map((kp) => Buffer.from(kp.signatureHint()).equals(hint));
  for (let i = 0; i < keypairs.length; i++) {
    if (hinted[i] && keypairs[i]!.verify(txHash, signature)) return i;
  }
  for (let i = 0; i < keypairs.length; i++) {
    if (!hinted[i] && keypairs[i]!.verify(txHash, signature)) return i;
  }
  return -1;
}
