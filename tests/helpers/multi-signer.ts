// test helper: a Connector that holds several signers' keys and returns one
// envelope carrying all of their signatures.
//
// the app does not use this. a shared account is closed in production through
// the signing relay: the initiator publishes the bundled close (CollectSignatures)
// and each co-signer adds a signature on /sign, merged server-side. this helper
// lets tests produce a threshold-meeting envelope for a multisig account without
// driving that flow.
//
// it signs with every member, not just enough to meet the threshold, so a test
// that gives it more weight than the account needs gets tx_bad_auth_extra from
// the network. it signs plain transactions only.

import { FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";

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
    // a key listed twice signs once and counts once
    const seen = new Set<string>();
    this.#members = members.filter((m) => {
      if (seen.has(m.publicKey)) return false;
      seen.add(m.publicKey);
      return true;
    });
  }

  // total signing weight the distinct members contribute
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
    if (tx instanceof FeeBumpTransaction) {
      throw new Error("MultiSignerConnector: fee-bump envelopes are not supported.");
    }
    const base = tx.toXdr();
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
}
