import { test, expect, type Page } from "@playwright/test";
import { SignClient } from "@walletconnect/sign-client";
import {
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// End-to-end proof of the WalletConnect path with NO phone and NO physical wallet:
// a headless WalletConnect wallet (a second SignClient) runs in Node, pairs with
// the QR the app generates over the real relay, approves a testnet session, and
// signs the close the app requests. Drives the exact same in-browser wiring a real
// mobile wallet would. Setup + assertions hit live testnet Horizon/Friendbot.

const PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const STELLAR_METHODS = [
  "stellar_signXDR",
  "stellar_signAndSubmitXDR",
  "stellar_signAuthEntry",
  "stellar_signMessage",
];

const server = new Horizon.Server(HORIZON_URL);

async function friendbotFund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: HTTP ${res.status}`);
}

async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await server.loadAccount(publicKey);
    return true;
  } catch (err: unknown) {
    if ((err as { response?: { status?: number } })?.response?.status === 404) return false;
    throw err;
  }
}

// a minimal WalletConnect "wallet": approves the incoming session for our testnet
// account and signs every stellar_signXDR request with its keypair.
async function startHeadlessWcWallet(kp: Keypair) {
  const wallet = await SignClient.init({
    projectId: PROJECT_ID,
    metadata: {
      name: "Test Stellar Wallet",
      description: "headless test wallet",
      url: "https://example.test",
      icons: [],
    },
  });

  wallet.on("session_proposal", (event) => {
    void wallet.approve({
      id: event.id,
      namespaces: {
        stellar: {
          accounts: [`stellar:testnet:${kp.publicKey()}`],
          methods: STELLAR_METHODS,
          events: [],
        },
      },
    });
  });

  wallet.on("session_request", async (event) => {
    const { topic, id, params } = event;
    const { request } = params;
    if (request.method === "stellar_signXDR") {
      const tx = TransactionBuilder.fromXdr(request.params.xdr as string, PASSPHRASE);
      tx.sign(kp);
      await wallet.respond({
        topic,
        response: { id, jsonrpc: "2.0", result: { signedXDR: tx.toXdr() } },
      });
      return;
    }
    await wallet.respond({
      topic,
      response: { id, jsonrpc: "2.0", error: { code: 5000, message: "unsupported method" } },
    });
  });

  return wallet;
}

// pull the wc: pairing uri out of the AppKit QR element (it lives as a JS property
// on the <wui-qr-code> custom element inside shadow DOM)
async function readPairingUri(page: Page): Promise<string> {
  return await page
    .locator("wui-qr-code")
    .first()
    .evaluate((el) => (el as unknown as { uri?: string }).uri ?? "");
}

test("closes a testnet account signed over WalletConnect (headless wallet, no phone)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  test.skip(PROJECT_ID === "", "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID not set");

  const account = Keypair.random();
  const destination = Keypair.random();

  // fund the account, spin the destination off it so the account stays under the
  // 1000-XLM high-value gate and the destination exists as a real merge target
  await friendbotFund(account.publicKey());
  const loaded = await server.loadAccount(account.publicKey());
  const setup = new TransactionBuilder(loaded, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.createAccount({ destination: destination.publicKey(), startingBalance: "9400" }),
    )
    .setTimeout(120)
    .build();
  setup.sign(account);
  await server.submitTransaction(setup);

  const wallet = await startHeadlessWcWallet(account);

  try {
    // --- connect over WalletConnect ---
    await page.goto("/demolish");
    await page.getByTestId("connect-button").click();
    await page.getByText("WalletConnect", { exact: true }).first().click();

    // the QR modal renders the pairing uri; hand it to the headless wallet
    await page.locator("wui-qr-code").first().waitFor({ timeout: 30_000 });
    let uri = "";
    await expect
      .poll(async () => (uri = await readPairingUri(page)).startsWith("wc:"), { timeout: 20_000 })
      .toBe(true);
    await wallet.pair({ uri });

    // the wallet approves; the app records the connected account
    await expect(page.getByTestId("connector-ready")).toHaveValue("true", { timeout: 45_000 });

    // --- drive the close; signing happens over WalletConnect ---
    await page.getByTestId("destination-input").fill(destination.publicKey());
    const start = page.getByTestId("demolish-start");
    await expect(start).toBeEnabled();
    await start.click();

    // acknowledge any Warnings-step notices, then Review
    const ackContinue = page.getByTestId("acknowledge-continue");
    const reviewConfirm = page.getByTestId("demolish-confirm");
    await expect(ackContinue.or(reviewConfirm).first()).toBeVisible({ timeout: 90_000 });
    if (await ackContinue.isVisible()) {
      const acks = page.getByRole("checkbox");
      for (let i = 0; i < (await acks.count()); i++) await acks.nth(i).check();
      await expect(ackContinue).toBeEnabled();
      await ackContinue.click();
    }
    await reviewConfirm.waitFor({ state: "visible", timeout: 90_000 });
    await reviewConfirm.click();

    // typed confirmation, then the app asks the WalletConnect wallet to sign
    await page.getByTestId("typed-confirmation").waitFor();
    await page.getByTestId("typed-confirmation-input").fill(destination.publicKey().slice(-4));
    const finalConfirm = page.getByTestId("typed-confirmation-confirm");
    await expect(finalConfirm).toBeEnabled({ timeout: 15_000 });
    await finalConfirm.click();

    await expect(page.getByTestId("machine-state")).toHaveValue("succeeded", { timeout: 90_000 });

    // on-chain truth: the account was merged away
    await expect
      .poll(() => accountExists(account.publicKey()), { timeout: 30_000, intervals: [2_000] })
      .toBe(false);
  } finally {
    for (const s of wallet.session.getAll()) {
      await wallet.disconnect({
        topic: s.topic,
        reason: { code: 6000, message: "test done" },
      });
    }
  }
});
