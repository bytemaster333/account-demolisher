// multi-signer connector for closing multisig accounts.
//
// The account being demolished is the transaction source; closing it needs
// signature weight >= the account's high threshold. This connector holds the
// keys of several authorized signers and, for every transaction in the plan,
// applies all of their signatures and merges them into one envelope. That
// satisfies the RFP's "add multiple secret keys / sign with different wallets"
// requirement without changing the executor: it just receives a connector that
// happens to produce a fully-signed, threshold-meeting envelope.

import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import type { Connector, ConnectorKind } from "@/lib/wallet/connector";
import { mergeSignatures } from "@/lib/multisig/partial-xdr";

export interface MultiSignerMember {
  readonly connector: Connector;
  readonly publicKey: string;
  readonly weight: number;
}

export class MultiSignerConnector implements Connector {
  public readonly kind: ConnectorKind = "secret";

  readonly #accountPublicKey: string;
  readonly #members: readonly MultiSignerMember[];

  constructor(accountPublicKey: string, members: readonly MultiSignerMember[]) {
    if (members.length === 0) {
      throw new Error("MultiSignerConnector: at least one signer is required.");
    }
    this.#accountPublicKey = accountPublicKey;
    this.#members = members;
  }

  // total signing weight the collected members contribute
  get totalWeight(): number {
    return this.#members.reduce((sum, m) => sum + m.weight, 0);
  }

  get signerKeys(): readonly string[] {
    return this.#members.map((m) => m.publicKey);
  }

  async connect(): Promise<{ publicKey: string }> {
    return { publicKey: this.#accountPublicKey };
  }

  async disconnect(): Promise<void> {
    for (const m of this.#members) await m.connector.disconnect();
  }

  async getPublicKey(): Promise<string> {
    return this.#accountPublicKey;
  }

  // sign with every member and merge the signatures into one envelope
  async signTransaction(
    tx: Transaction | FeeBumpTransaction,
    networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerPublicKey: string }> {
    const base = tx.toXDR();
    const partials: string[] = [];
    for (const member of this.#members) {
      const { signedXdr } = await member.connector.signTransaction(tx, networkPassphrase);
      partials.push(signedXdr);
    }
    const merged = mergeSignatures(base, partials, networkPassphrase, {
      expectedSigners: this.signerKeys,
    });
    return { signedXdr: merged, signerPublicKey: this.#accountPublicKey };
  }

  // per-signer Soroban auth-entry signing isn't part of the demolition flow
  // (source-account auth is carried by the envelope signatures above), and doing
  // it correctly for multisig is non-trivial. refuse rather than sign wrongly.
  async signAuthEntry(): Promise<{ signedXdr: string; signerAddress: string }> {
    throw new Error(
      "MultiSignerConnector: SEP-43 auth-entry signing is not supported for multisig accounts.",
    );
  }
}
