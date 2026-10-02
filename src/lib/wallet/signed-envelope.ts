// checks that what a signer hands back is the transaction the app built, signed
// by the expected key.
//
// every pre-sign guard (allow-list, auth-tree and revoke checks) runs on the
// transaction object the app built, but the bytes that get submitted are whatever
// the wallet returns. a buggy or compromised wallet could return a different
// envelope (other operations, fee or time bounds), nothing at all, or an envelope
// with no usable signature. none of that may reach the network.

import {
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

export class SignedEnvelopeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SignedEnvelopeError";
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface VerifiedEnvelope {
  readonly signedXdr: string;
  // the key whose signature verified, not whatever address the wallet reported
  readonly signerPublicKey: string;
}

// throws SignedEnvelopeError unless signedXdr is the same transaction as built
// (same kind, same network, same hash) carrying a valid signature by
// expectedSigner with that key's hint
export function verifySignedEnvelope(
  built: Transaction | FeeBumpTransaction,
  signedXdr: unknown,
  networkPassphrase: string,
  expectedSigner: string,
): VerifiedEnvelope {
  if (built.networkPassphrase !== networkPassphrase) {
    throw new SignedEnvelopeError(
      "The transaction was built for a different network than the one it is being signed for.",
    );
  }
  if (typeof signedXdr !== "string" || signedXdr.length === 0) {
    throw new SignedEnvelopeError(
      "The wallet returned no signed transaction. The request was cancelled or the wallet failed.",
    );
  }

  let signed: Transaction | FeeBumpTransaction;
  try {
    signed = TransactionBuilder.fromXdr(signedXdr, networkPassphrase);
  } catch (e) {
    throw new SignedEnvelopeError(
      "The wallet returned data that is not a valid transaction envelope.",
      { cause: e },
    );
  }

  if (signed instanceof FeeBumpTransaction !== built instanceof FeeBumpTransaction) {
    throw new SignedEnvelopeError(
      "The wallet returned a different kind of transaction envelope than the one it was asked to sign.",
    );
  }

  const hash = built.hash();
  if (!sameBytes(signed.hash(), hash)) {
    throw new SignedEnvelopeError(
      "The wallet returned a different transaction than the one Account Demolisher built and " +
        "checked. Nothing was submitted.",
    );
  }

  const keypair = Keypair.fromPublicKey(expectedSigner);
  const hint = keypair.signatureHint();
  const verified = signed.signatures.some(
    (sig) => sameBytes(sig.hint.toBytes(), hint) && keypair.verify(hash, sig.signature.toBytes()),
  );
  if (!verified) {
    throw new SignedEnvelopeError(
      `The wallet's envelope carries no valid signature from ${expectedSigner}. Make sure the ` +
        "wallet is signing with the connected account.",
    );
  }
  return { signedXdr, signerPublicKey: expectedSigner };
}
