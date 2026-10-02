// the in-house connector abstraction: the only signing surface anything
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import { LEDGER_ID, type LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";

import { ensureWalletConnectReady, getKit, type KitHandle } from "@/lib/wallet/kit";
import { toLedgerSigningError } from "@/lib/wallet/ledger-errors";
import { verifySignedEnvelope } from "@/lib/wallet/signed-envelope";
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

// connector backed by the shared StellarWalletsKit handle. construction is
// cheap; the kit itself is the singleton
export class WalletKitConnector implements Connector {
  public readonly kind: ConnectorKind = "kit";

  private readonly kit: KitHandle;
  private cachedAddress: string | null = null;

  constructor(network: NetworkConfig) {
    this.kit = getKit(network);
  }

  // opens the kit's authModal, returns the picked wallet's public key
  async connect(): Promise<{ publicKey: string }> {
    // make sure a configured WalletConnect has finished its relay handshake so it
    // renders as connectable in the picker (see ensureWalletConnectReady)
    await ensureWalletConnectReady();
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

  // sep-43 sign. the returned envelope is checked against the transaction we
  // built (same hash, valid signature by the connected key) before it is handed
  // back, because every pre-sign guard ran on `tx`, not on the wallet's bytes.
  // signerPublicKey is the key whose signature verified, never the wallet's echo.
  async signTransaction(
    tx: Transaction | FeeBumpTransaction,
    networkPassphrase: string,
  ): Promise<{ signedXdr: string; signerPublicKey: string }> {
    const address = await this.getPublicKey();
    const isLedger = this.kit.selectedModule.productId === LEDGER_ID;
    // without nonBlindTx the ledger module signs tx.hash() (INS_SIGN_HASH): the
    // device shows 32 opaque bytes instead of the operations and the merge
    // destination, and its stellar app refuses that unless hash signing was
    // switched on. the kit spreads opts into the module unchanged.
    const opts: NonNullable<Parameters<LedgerModule["signTransaction"]>[1]> = {
      networkPassphrase,
      address,
      ...(isLedger ? { nonBlindTx: true } : {}),
    };
    let signedTxXdr: unknown;
    try {
      ({ signedTxXdr } = await this.kit.signTransaction(tx.toXdr(), opts));
    } catch (e) {
      // a device refusal (too large, rejected, ...) gets an actionable message.
      // there is deliberately no retry as a hash signature.
      throw (isLedger ? toLedgerSigningError(e) : null) ?? e;
    }
    return verifySignedEnvelope(tx, signedTxXdr, networkPassphrase, address);
  }

  // sep-43 soroban auth-entry sign. let underlying wallet errors propagate
  // so the orchestrator can fall back
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
