import { test, expect } from "@playwright/test";
import {
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// End-to-end proof of the secret-key fallback closure (funded Tranche-1
// deliverable): a real browser drives the /demolish flow, connects by pasting a
// throwaway testnet secret key (no wallet extension), and closes the account for
// real. Setup and assertions hit live testnet Horizon + Friendbot; nothing is
// mocked. The source is kept under the 1000-XLM high-value threshold so the flow
// runs straight to Review (the high-value gate has its own unit coverage).

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;

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
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return false;
    throw err; // a transient error must not read as "account gone"
  }
}

test("secret-key fallback closes a funded testnet account end to end", async ({ page }) => {
  test.setTimeout(150_000);

  const source = Keypair.random();
  const destination = Keypair.random();

  // fund the source, then spin the destination off it so the source is left with
  // a few hundred XLM (below the 1000-XLM high-value gate) and the destination
  // exists as a real, funded merge target.
  await friendbotFund(source.publicKey());
  const sourceAccount = await server.loadAccount(source.publicKey());
  const setupTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.createAccount({ destination: destination.publicKey(), startingBalance: "9400" }),
    )
    .setTimeout(120)
    .build();
  setupTx.sign(source);
  await server.submitTransaction(setupTx);

  expect(await accountExists(source.publicKey())).toBe(true);
  expect(await accountExists(destination.publicKey())).toBe(true);

  // --- drive the real UI ---
  await page.goto("/demolish");
  await expect(page.getByTestId("machine-state")).toHaveValue("idle");

  // connect by pasting the secret key (the wallet-extension alternative)
  await page.locator('button[aria-controls="advanced-secret-panel"]').click();
  await page.getByTestId("secret-key-input").fill(source.secret());
  await page.getByTestId("secret-key-submit").click();
  await expect(page.getByTestId("connector-ready")).toHaveValue("true");

  // configure the merge destination and build the plan
  await page.getByTestId("destination-input").fill(destination.publicKey());
  const start = page.getByTestId("demolish-start");
  await expect(start).toBeEnabled();
  await start.click();

  // the plan build may land on the Warnings step first (e.g. the optional
  // custom-SEP-41 event scan can't cover the full window on testnet, which the
  // app surfaces as a read-and-understand notice). Acknowledge every required
  // notice, then continue to Review.
  const ackContinue = page.getByTestId("acknowledge-continue");
  const reviewConfirm = page.getByTestId("demolish-confirm");
  await expect(ackContinue.or(reviewConfirm).first()).toBeVisible({ timeout: 90_000 });
  if (await ackContinue.isVisible()) {
    const acks = page.getByRole("checkbox");
    for (let i = 0; i < (await acks.count()); i++) await acks.nth(i).check();
    await expect(ackContinue).toBeEnabled();
    await ackContinue.click();
  }

  // review the plan and confirm
  await reviewConfirm.waitFor({ state: "visible", timeout: 90_000 });
  await reviewConfirm.click();

  // typed confirmation: type the destination's last 4 chars, wait out the
  // deliberate delay, then close for real
  await page.getByTestId("typed-confirmation").waitFor();
  await page.getByTestId("typed-confirmation-input").fill(destination.publicKey().slice(-4));
  const finalConfirm = page.getByTestId("typed-confirmation-confirm");
  await expect(finalConfirm).toBeEnabled({ timeout: 15_000 });
  await finalConfirm.click();

  // the flow reports success and shows the status widget with the merge result
  await expect(page.getByTestId("machine-state")).toHaveValue("succeeded", { timeout: 90_000 });
  await expect(page.getByTestId("demolish-status-widget")).toBeVisible();

  // on-chain truth: the source account has been merged away and no longer exists
  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
});
