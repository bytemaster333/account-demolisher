import { test, expect, type Page } from "@playwright/test";
import { SignClient } from "@walletconnect/sign-client";
import { Networks, TransactionBuilder, type Keypair } from "@stellar/stellar-sdk";

import { accountExists, fundedPair, mergesOf, nativeBalance } from "./support/chain";
import {
  acknowledgeNotices,
  closedHeading,
  configureClose,
  confirmReviewedClose,
} from "./support/flow";

// End-to-end proof of the WalletConnect path with NO phone and NO physical wallet:
// a headless WalletConnect wallet (a second SignClient) runs in Node, pairs with
// the QR the app generates over the real relay, approves a testnet session, and
// signs the close the app requests. Drives the exact same in-browser wiring a real
// mobile wallet would. Setup + assertions hit live testnet Horizon/Friendbot.

const PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
const PASSPHRASE = Networks.TESTNET;
const STELLAR_METHODS = [
  "stellar_signXDR",
  "stellar_signAndSubmitXDR",
  "stellar_signAuthEntry",
  "stellar_signMessage",
];

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

  // the account stays under the 1000-XLM high-value gate and the destination
  // exists as a real merge target
  const { source: account, destination } = await fundedPair();
  const accountBalance = await nativeBalance(account.publicKey());
  const destBefore = await nativeBalance(destination.publicKey());

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

    // the wallet approves; the configure step appears for the connected account
    await expect(page.getByTestId("destination-input")).toBeVisible({ timeout: 45_000 });

    // --- drive the close; signing happens over WalletConnect ---
    await configureClose(page, destination.publicKey());
    await acknowledgeNotices(page);
    await confirmReviewedClose(page, destination.publicKey());

    await expect(closedHeading(page)).toBeVisible({ timeout: 120_000 });

    // on-chain truth: the account merged into the destination, which received
    // its whole balance less the network fees
    await expect
      .poll(() => accountExists(account.publicKey()), { timeout: 30_000, intervals: [2_000] })
      .toBe(false);
    expect((await mergesOf(account.publicKey())).map((m) => m.into)).toEqual([
      destination.publicKey(),
    ]);
    const received = (await nativeBalance(destination.publicKey())) - destBefore;
    expect(received).toBeLessThanOrEqual(accountBalance);
    expect(received).toBeGreaterThan(accountBalance - 1_0000000n);
  } finally {
    for (const s of wallet.session.getAll()) {
      await wallet.disconnect({
        topic: s.topic,
        reason: { code: 6000, message: "test done" },
      });
    }
  }
});
