// the in-house Connector abstraction — the only signing surface anything
// else in the codebase imports.
//
// two implementations:
//   - WalletKitConnector (this file): backed by stellar-wallets-kit.
//   - SecretKeyConnector (./secret-key.ts): in-memory S... seed signer.
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

import { getKit, type KitHandle } from "@/lib/wallet/kit";
import type { NetworkConfig } from "@/lib/config/networks";

export type ConnectorKind = "kit" | "secret";

export interface Connector {
  readonly kind: ConnectorKind;
  connect(): Promise<{ publicKey: string }>;
  disconnect(): Promise<void>;
  getPublicKey(): Promise<string>;
  signTransaction(
    tx: Transaction | FeeBumpTransaction,
    networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerPublicKey: string }>;
  signAuthEntry(
    authEntryXdr: string,
    address: string,
    networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerAddress: string }>;
}

// Connector backed by the shared StellarWalletsKit handle. construction is
// cheap; the kit itself is the singleton.
export class WalletKitConnector implements Connector {
  public readonly kind: ConnectorKind = "kit";

  private readonly kit: KitHandle;
  private cachedAddress: string | null = null;

  constructor(network: NetworkConfig) {
    this.kit = getKit(network);
  }

  // opens the kit's authModal, returns the picked wallet's public key.
  async connect(): Promise<{ publicKey: string }> {
    const { address } = await this.kit.authModal();
    this.cachedAddress = address;
    return { publicKey: address };
  }

  async disconnect(): Promise<void> {
    this.cachedAddress = null;
    await this.kit.disconnect();
  }

  async getPublicKey(): Promise<string> {
    if (this.cachedAddress !== null) return this.cachedAddress;
    const { address } = await this.kit.getAddress();
    this.cachedAddress = address;
    return address;
  }

  // sep-43 sign. maps the kit's { signedTxXdr, signerAddress } to our
  // { signedXdr, signerPublicKey } shape so callers don't import kit types.
  async signTransaction(
    tx: Transaction | FeeBumpTransaction,
    networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerPublicKey: string }> {
    const address = await this.getPublicKey();
    const { signedTxXdr, signerAddress } = await this.kit.signTransaction(tx.toXDR(), {
      networkPassphrase,
      address,
    });
    return {
      signedXdr: signedTxXdr,
      signerPublicKey: signerAddress ?? address,
    };
  }

  // sep-43 soroban auth-entry sign. let underlying wallet errors propagate
  // so the orchestrator can fall back.
  async signAuthEntry(
    authEntryXdr: string,
    address: string,
    networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerAddress: string }> {
    const { signedAuthEntry, signerAddress } = await this.kit.signAuthEntry(authEntryXdr, {
      networkPassphrase,
      address,
    });
    return {
      signedXdr: signedAuthEntry,
      signerAddress: signerAddress ?? address,
    };
  }
}
