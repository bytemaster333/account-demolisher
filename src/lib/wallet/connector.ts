// the in-house connector abstraction: the only signing surface the app uses,
// whole transactions only
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";
import { LEDGER_ID, type LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";

import {
  applyKitTheme,
  disconnectKit,
  getKit,
  restoreKitSessionSnapshot,
  snapshotKitSession,
  type KitHandle,
} from "@/lib/wallet/kit";
import { toLedgerSigningError } from "@/lib/wallet/ledger-errors";
import { verifySignedEnvelope } from "@/lib/wallet/signed-envelope";
import { reportTeardownError } from "@/lib/wallet/teardown-report";
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
    applyKitTheme();
    const { address } = await this.kit.authModal();
    this.cachedAddress = address;
    return { publicKey: address };
  }

  // the kit's own disconnect() does not wait for the wallet, so a refusal would
  // be an unhandled rejection. disconnectKit waits and throws it.
  async disconnect(): Promise<void> {
    this.cachedAddress = null;
    await disconnectKit();
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
}

// the connector a scoped session hands to run(): once the picker answers it
// checks whether the page was left in the meantime
class ScopedKitConnector extends WalletKitConnector {
  constructor(
    network: NetworkConfig,
    private readonly afterPick: () => Promise<void>,
  ) {
    super(network);
  }

  override async connect(): Promise<{ publicKey: string }> {
    const picked = await super.connect();
    await this.afterPick();
    return picked;
  }
}

// sign with a wallet picked just for this one signature (a co-signer on /sign)
// without it becoming the app's connected wallet. the kit persists whatever the
// picker selects, so without this a later page load would restore the
// co-signer's account as the connected one. the session that existed before is
// put back afterwards, or the kit is disconnected if there was none, whether the
// signature succeeded or not.
//
// the co-signer can also leave while the wallet is still open. closing or
// reloading the tab fires pagehide, and the restore runs there: it writes the
// kit's state (and so localStorage) before it awaits anything, so it lands even
// while the page unloads. leaving /sign inside the app aborts `left`; the
// session is put back at once and not again when run() settles, so a wallet the
// app connects in the meantime is kept. a wallet picked in the still open
// picker after that is let go straight away.
//
// a teardown failure (an extension or the walletconnect relay refusing the
// disconnect) goes to onTeardownError and never replaces run()'s outcome: a
// signature that worked is still returned, and a signing error is still thrown
// as itself. the caller shows the teardown failure so the co-signer can end the
// connection in their wallet.
export async function withScopedKitSession<T>(
  network: NetworkConfig,
  run: (connector: WalletKitConnector) => Promise<T>,
  onTeardownError: (error: unknown) => void,
  left?: AbortSignal,
): Promise<T> {
  if (left?.aborted === true) {
    throw new Error("The signing page was left before the wallet was opened.");
  }
  getKit(network);
  const before = snapshotKitSession();
  const restore = async (): Promise<void> => {
    try {
      await restoreKitSessionSnapshot(before);
    } catch (error) {
      reportTeardownError(onTeardownError, error);
    }
  };
  const onPageHide = (): void => {
    void restore();
  };
  let wasLeft = false;
  const onLeft = (): void => {
    wasLeft = true;
    void restore();
  };
  window.addEventListener("pagehide", onPageHide);
  left?.addEventListener("abort", onLeft, { once: true });
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const connector = new ScopedKitConnector(network, async () => {
      if (!wasLeft) return;
      await restore();
      throw new Error("The signing page was left before the wallet was picked, so it was let go.");
    });
    outcome = { ok: true, value: await run(connector) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    window.removeEventListener("pagehide", onPageHide);
    left?.removeEventListener("abort", onLeft);
  }
  if (!wasLeft) await restore();
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
