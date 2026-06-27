// in-memory secret-key fallback connector
import {
  Keypair,
  StrKey,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";

import type { Connector, ConnectorKind } from "@/lib/wallet/connector";

export class SecretKeyConnector implements Connector {
  public readonly kind: ConnectorKind = "secret";

  // the raw s... seed. we don't cache the derived keypair — it's rebuilt
  // per sign so the in-memory secret-key bytes live for one method call
  readonly #seed: string;
  readonly #publicKey: string;

  constructor(seed: string) {
    if (typeof seed !== "string" || seed.length === 0) {
      throw new Error("SecretKeyConnector: seed must be a non-empty string.");
    }
    if (!StrKey.isValidEd25519SecretSeed(seed)) {
      throw new Error(
        "SecretKeyConnector: invalid Stellar secret seed. " +
          "Expected a base32-encoded ed25519 seed starting with 'S'.",
      );
    }
    this.#seed = seed;
    // derive once so getPublicKey() doesn't re-run derivation; the pubkey
    // is public so caching it is fine
    this.#publicKey = Keypair.fromSecret(seed).publicKey();
  }

  // no-op for the in-memory path; the seed was supplied at construction
  async connect(): Promise<{ publicKey: string }> {
    return { publicKey: this.#publicKey };
  }

  // can't zeroize js memory. callers must drop every reference to this
  // instance after disconnect() so the gc can reclaim it
  async disconnect(): Promise<void> {
    return;
  }

  async getPublicKey(): Promise<string> {
    return this.#publicKey;
  }

  // sign and return the signed xdr
  async signTransaction(
    tx: Transaction | FeeBumpTransaction,
    networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerPublicKey: string }> {
    const cloned = TransactionBuilder.fromXDR(tx.toXDR(), networkPassphrase);
    const keypair = Keypair.fromSecret(this.#seed);
    cloned.sign(keypair);
    return {
      signedXdr: cloned.toXDR(),
      signerPublicKey: keypair.publicKey(),
    };
  }

  // sign a soroban auth-entry preimage xdr (sep-43).
  //
  // signing the raw base64 bytes here would produce a plain ed25519 signature,
  // not a valid network-bound Soroban auth signature: SEP-43 requires signing
  // the sha-256 hash of an xdr.HashIdPreimageSorobanAuthorization that binds the
  // network id, nonce, and signature-expiration ledger — none of which the single
  // authEntryXdr string carries. No production caller reaches this method, so —
  // like MultiSignerConnector.signAuthEntry — refuse rather than sign wrongly.
  async signAuthEntry(
    _authEntryXdr: string,
    _address: string,
    _networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerAddress: string }> {
    throw new Error(
      "SecretKeyConnector: SEP-43 auth-entry signing is not implemented. " +
        "Signing raw entry bytes would not produce a valid network-bound Soroban auth signature.",
    );
  }
}
