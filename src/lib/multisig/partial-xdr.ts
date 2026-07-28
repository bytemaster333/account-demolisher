// merges signatures from independently-signed envelopes into a canonical one

import { Keypair, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";

export interface MergeOptions {
  // allowlist of public keys we admit signatures for
  readonly expectedSigners?: readonly string[];
}

// merges novel signatures from partialXdrs into canonicalXdr; returns the
export function mergeSignatures(
  canonicalXdr: string,
  partialXdrs: readonly string[],
  networkPassphrase: string,
  options: MergeOptions = {},
): string {
  if (typeof canonicalXdr !== "string" || canonicalXdr.length === 0) {
    throw new Error("mergeSignatures: canonicalXdr must be a non-empty base64 string.");
  }
  if (typeof networkPassphrase !== "string" || networkPassphrase.length === 0) {
    throw new Error("mergeSignatures: networkPassphrase must be non-empty.");
  }

  const canonical = TransactionBuilder.fromXDR(canonicalXdr, networkPassphrase);
  if (!isClassicTransaction(canonical)) {
    throw new Error(
      "mergeSignatures: canonical envelope must be a classic Transaction; " +
        "fee-bump envelopes are not supported here.",
    );
  }
  const canonicalHash = canonical.hash();

  // collect candidate public keys. with expectedSigners we trust the
  // allowlist; without it we fall back to the tx + per-op source accounts
  const candidates: readonly string[] = collectCandidateSigners(
    canonical,
    partialXdrs,
    networkPassphrase,
    options.expectedSigners,
  );

  // dedup by the RECOVERED SIGNER KEY, not by wire bytes. The decorated
  // signature's 4-byte hint is attacker-chosen, so keying on wire bytes lets one
  // captured signature be replayed under many hints to bloat the envelope to the
  // 20-signature XDR cap and wedge the plan. One signature per authorized key is
  // exactly what weighted multisig needs, so recover each key and admit it once.
  const presentKeys = new Set<string>();
  for (const sig of canonical.signatures) {
    const k = recoverSigningKey(sig, canonicalHash, candidates);
    if (k) presentKeys.add(k);
  }

  for (const partialXdr of partialXdrs) {
    if (typeof partialXdr !== "string" || partialXdr.length === 0) {
      throw new Error("mergeSignatures: every partialXdr must be a non-empty base64 string.");
    }

    const partial = TransactionBuilder.fromXDR(partialXdr, networkPassphrase);
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
      const signingKey = recoverSigningKey(decorated, canonicalHash, candidates);
      if (!signingKey) {
        throw new Error(
          "mergeSignatures: partial envelope contains a signature that does not match " +
            "any known signer for the canonical transaction (rejected).",
        );
      }

      if (presentKeys.has(signingKey)) continue;
      // store with the canonical hint for the recovered key, so a forged hint
      // can never occupy a parallel slot for a signer that already signed.
      const kp = Keypair.fromPublicKey(signingKey);
      canonical.signatures.push(
        new xdr.DecoratedSignature({
          hint: kp.signatureHint(),
          signature: Buffer.from(decorated.signature()),
        }),
      );
      presentKeys.add(signingKey);
    }
  }

  return canonical.toXDR();
}

function isClassicTransaction(
  tx: Transaction | import("@stellar/stellar-sdk").FeeBumpTransaction,
): tx is Transaction {
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
      const tx = TransactionBuilder.fromXDR(partial, networkPassphrase);
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

// recover the public key that signed sig over txHash
function recoverSigningKey(
  sig: xdr.DecoratedSignature,
  txHash: Buffer,
  candidates: readonly string[],
): string | null {
  const hint = Buffer.from(sig.hint());
  const signature = Buffer.from(sig.signature());

  // hint-narrowed first
  for (const key of candidates) {
    const kp = Keypair.fromPublicKey(key);
    if (Buffer.from(kp.signatureHint()).equals(hint) && kp.verify(txHash, signature)) {
      return key;
    }
  }

  // full sweep for quirky wallets with unusual hints
  for (const key of candidates) {
    const kp = Keypair.fromPublicKey(key);
    if (kp.verify(txHash, signature)) return key;
  }

  return null;
}
