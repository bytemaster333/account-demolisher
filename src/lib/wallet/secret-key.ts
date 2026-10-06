// in-memory secret-key fallback connector
import {
  Keypair,
  StrKey,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";

import type { Connector, ConnectorKind } from "@/lib/wallet/connector";
import { verifySignedEnvelope } from "@/lib/wallet/signed-envelope";

export class SecretKeyConnector implements Connector {
  public readonly kind: ConnectorKind = "secret";

  // the raw s... seed. we don't cache the derived keypair. it's rebuilt
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

  // sign a clone and return the signed xdr. the same envelope check the wallet
  // path uses runs here too: a passphrase that differs from the one tx was built
  // with would otherwise yield a valid-looking signature for the wrong network.
  async signTransaction(
    tx: Transaction | FeeBumpTransaction,
    networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerPublicKey: string }> {
    const cloned = TransactionBuilder.fromXdr(tx.toXdr(), networkPassphrase);
    const keypair = Keypair.fromSecret(this.#seed);
    cloned.sign(keypair);
    return verifySignedEnvelope(tx, cloned.toXdr(), networkPassphrase, keypair.publicKey());
  }
}
