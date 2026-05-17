// in-memory secret-key fallback connector.
//
// the user pastes a raw S... seed; we wrap it in a SecretKeyConnector held
// in a React useRef scoped to the active flow. seed never leaves memory:
// no storage, no module cache, no logging, no network transmission. when
// the flow ends the React layer drops its ref and the connector is gc'd.
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

  // the raw S... seed. we don't cache the derived keypair — it's rebuilt
  // per sign so the in-memory secret-key bytes live for one method call.
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
    // is public so caching it is fine.
    this.#publicKey = Keypair.fromSecret(seed).publicKey();
  }

  // no-op for the in-memory path; the seed was supplied at construction.
  async connect(): Promise<{ publicKey: string }> {
    return { publicKey: this.#publicKey };
  }

  // can't zeroize js memory. callers must drop every reference to this
  // instance after disconnect() so the gc can reclaim it.
  async disconnect(): Promise<void> {
    return;
  }

  async getPublicKey(): Promise<string> {
    return this.#publicKey;
  }

  // sign and return the signed xdr. rehydrate from xdr to avoid mutating
  // the caller's tx.signatures; the Keypair built here is gc-eligible
  // immediately on return.
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

  // sign a soroban auth-entry preimage xdr (sep-43). wallets sign over the
  // bytes of the preimage, not its sha256. address is ignored — we always
  // sign with our single account.
  async signAuthEntry(
    authEntryXdr: string,
    _address: string,
    _networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerAddress: string }> {
    if (typeof authEntryXdr !== "string" || authEntryXdr.length === 0) {
      throw new Error("SecretKeyConnector.signAuthEntry: authEntryXdr must be non-empty.");
    }
    const keypair = Keypair.fromSecret(this.#seed);
    const signature = keypair.sign(Buffer.from(authEntryXdr, "base64"));
    return {
      signedXdr: signature.toString("base64"),
      signerAddress: keypair.publicKey(),
    };
  }
}
