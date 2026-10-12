// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";

// the kit's default browser-extension modules pull in wallet SDKs that do not load
// under vitest; the tests register their own wallet modules instead
vi.mock("@creit.tech/stellar-wallets-kit/modules/utils", () => ({ defaultModules: () => [] }));

// the real StellarWalletsKit is used, so the opts the connector passes go through
// the kit's own spread into the selected module. only the wallet module (the
// external device or extension) is a stand-in.

type SignOpts = { networkPassphrase?: string; address?: string; nonBlindTx?: boolean };
type SignFn = (
  xdr: string,
  opts: SignOpts,
) => Promise<{ signedTxXdr: string; signerAddress?: string }>;

const NET = Networks.TESTNET;
const signer = Keypair.random();

let kitApi: typeof import("@creit.tech/stellar-wallets-kit");
let kitState: typeof import("@creit.tech/stellar-wallets-kit/state");
let LEDGER_ID: string;
let WalletKitConnector: typeof import("@/lib/wallet/connector").WalletKitConnector;

// loading the kit and the connector transforms a large module graph. on a
// heavily loaded runner that has run past the default 10s hook timeout and
// skipped every test in the file, so the import gets its own budget
beforeAll(async () => {
  delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  kitApi = await import("@creit.tech/stellar-wallets-kit");
  kitState = await import("@creit.tech/stellar-wallets-kit/state");
  ({ LEDGER_ID } = await import("@creit.tech/stellar-wallets-kit/modules/ledger"));
  ({ WalletKitConnector } = await import("@/lib/wallet/connector"));
}, 120_000);

function walletModule(productId: string, signTransaction: SignFn) {
  return {
    moduleType: "HOT_WALLET",
    productId,
    productName: productId,
    productUrl: "https://example.com",
    productIcon: "https://example.com/icon.png",
    isAvailable: async () => true,
    getAddress: async () => ({ address: signer.publicKey() }),
    signTransaction,
    signAuthEntry: async () => ({ signedAuthEntry: "" }),
    signMessage: async () => ({ signedMessage: "" }),
    getNetwork: async () => ({ network: "TESTNET", networkPassphrase: NET }),
  };
}

// connect a WalletKitConnector to the given module as the kit's selected wallet
function connectTo(mod: ReturnType<typeof walletModule>) {
  const connector = new WalletKitConnector(TESTNET);
  kitApi.StellarWalletsKit.init({
    modules: [mod as unknown as Parameters<typeof kitApi.StellarWalletsKit.init>[0]["modules"][0]],
  });
  kitApi.StellarWalletsKit.setWallet(mod.productId);
  kitState.activeAddress.value = signer.publicKey();
  return connector;
}

function buildTx(seq = "1", amount = "1"): Transaction {
  return new TransactionBuilder(new Account(signer.publicKey(), seq), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(
      Operation.payment({ destination: signer.publicKey(), asset: Asset.native(), amount }),
    )
    .build();
}

function signedBy(xdr: string, kp: Keypair): string {
  const tx = new Transaction(xdr, NET);
  tx.sign(kp);
  return tx.toXdr();
}

function ledgerError(name: string, statusCode: number): Error {
  // the shape @ledgerhq/hw-app-str throws: a named error wrapping the transport
  // status error as its cause
  const err = new Error(name, { cause: { statusCode } });
  err.name = name;
  return err;
}

// behaves like the Stellar Ledger app with default settings: it signs a full
// transaction it can show (INS_SIGN_TX) and refuses a bare hash (0x6c66)
function ledgerDevice() {
  const calls: SignOpts[] = [];
  const mod = walletModule("LEDGER", async (xdr, opts) => {
    calls.push({ ...opts });
    if (!opts.nonBlindTx) throw ledgerError("StellarHashSigningNotEnabledError", 0x6c66);
    return { signedTxXdr: signedBy(xdr, signer), signerAddress: signer.publicKey() };
  });
  return { mod, calls };
}

describe("WalletKitConnector on a Ledger (H-34)", () => {
  it("uses the real Ledger product id", () => {
    expect(LEDGER_ID).toBe("LEDGER");
  });

  it("asks the device to show and sign the full transaction, never a blind hash", async () => {
    const { mod, calls } = ledgerDevice();
    const connector = connectTo(mod);
    const tx = buildTx();
    const out = await connector.signTransaction(tx, NET);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ nonBlindTx: true, address: signer.publicKey() });
    expect(out.signerPublicKey).toBe(signer.publicKey());
  });

  it("reports a transaction too large for the device and does not fall back to hash signing", async () => {
    const calls: SignOpts[] = [];
    const mod = walletModule("LEDGER", async (_xdr, opts) => {
      calls.push({ ...opts });
      throw ledgerError("StellarDataTooLargeError", 0xb004);
    });
    const connector = connectTo(mod);
    await expect(connector.signTransaction(buildTx(), NET)).rejects.toMatchObject({
      name: "LedgerSigningError",
      refusal: "too-large",
      message: expect.stringMatching(/another wallet/),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.nonBlindTx).toBe(true);
  });

  it("maps a rejection on the device by status code alone", async () => {
    const mod = walletModule("LEDGER", async () => {
      throw Object.assign(new Error("Ledger device: UNKNOWN_ERROR (0x6985)"), {
        statusCode: 0x6985,
      });
    });
    const connector = connectTo(mod);
    await expect(connector.signTransaction(buildTx(), NET)).rejects.toMatchObject({
      refusal: "rejected",
    });
  });

  it("passes a non-Ledger wallet's own error through unchanged", async () => {
    const original = { code: -1, message: "User declined" };
    const mod = walletModule("freighter", async () => {
      throw original;
    });
    const connector = connectTo(mod);
    await expect(connector.signTransaction(buildTx(), NET)).rejects.toBe(original);
  });

  it("does not send the Ledger-only option to other wallets", async () => {
    const calls: SignOpts[] = [];
    const mod = walletModule("freighter", async (xdr, opts) => {
      calls.push({ ...opts });
      return { signedTxXdr: signedBy(xdr, signer) };
    });
    const connector = connectTo(mod);
    await connector.signTransaction(buildTx(), NET);
    expect(calls[0]).not.toHaveProperty("nonBlindTx");
  });
});

describe("WalletKitConnector checks the envelope the wallet returns (M-49)", () => {
  function walletReturning(respond: (xdr: string) => unknown) {
    return connectTo(
      walletModule("freighter", async (xdr) => ({
        signedTxXdr: respond(xdr) as string,
        // echoes the requested address, as several wallets do, so the connector
        // cannot rely on it
        signerAddress: signer.publicKey(),
      })),
    );
  }

  it("returns a correctly signed copy of the built transaction", async () => {
    const tx = buildTx();
    const connector = walletReturning((xdr) => signedBy(xdr, signer));
    const out = await connector.signTransaction(tx, NET);
    expect(out.signerPublicKey).toBe(signer.publicKey());
    expect(Buffer.from(new Transaction(out.signedXdr, NET).hash())).toEqual(Buffer.from(tx.hash()));
  });

  it("rejects a different transaction than the one built", async () => {
    const connector = walletReturning(() => signedBy(buildTx("1", "999").toXdr(), signer));
    await expect(connector.signTransaction(buildTx(), NET)).rejects.toThrow(
      /different transaction/,
    );
  });

  it("rejects a missing envelope (a wallet that returns undefined on cancel)", async () => {
    const connector = walletReturning(() => undefined);
    await expect(connector.signTransaction(buildTx(), NET)).rejects.toThrow(
      /no signed transaction/,
    );
  });

  it("rejects an unsigned envelope", async () => {
    const connector = walletReturning((xdr) => xdr);
    await expect(connector.signTransaction(buildTx(), NET)).rejects.toThrow(/no valid signature/);
  });

  it("rejects a signature from another key", async () => {
    const other = Keypair.random();
    const connector = walletReturning((xdr) => signedBy(xdr, other));
    await expect(connector.signTransaction(buildTx(), NET)).rejects.toThrow(/no valid signature/);
  });

  it("rejects a fee-bump returned for a plain transaction", async () => {
    const connector = walletReturning((xdr) => {
      const inner = new Transaction(signedBy(xdr, signer), NET);
      const bump = TransactionBuilder.buildFeeBumpTransaction(signer, "200", inner, NET);
      bump.sign(signer);
      expect(bump).toBeInstanceOf(FeeBumpTransaction);
      return bump.toXdr();
    });
    await expect(connector.signTransaction(buildTx(), NET)).rejects.toThrow(/different kind/);
  });

  it("rejects bytes that are not an envelope", async () => {
    const connector = walletReturning(() => "not-xdr");
    await expect(connector.signTransaction(buildTx(), NET)).rejects.toThrow(
      /not a valid transaction envelope/,
    );
  });
});
