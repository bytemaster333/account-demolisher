import { test, expect, type Page } from "@playwright/test";
import { Asset, Keypair, Operation } from "@stellar/stellar-sdk";

import {
  accountExists,
  friendbotFund,
  fundedPair,
  horizon,
  mergesOf,
  nativeBalance,
  submitAs,
} from "./support/chain";
import {
  acknowledgeNotices,
  closedHeading,
  configureClose,
  confirmReviewedClose,
  connectWithSecret,
  failedHeading,
} from "./support/flow";

// an exchange close end to end on testnet: the destination is a deposit account
// that publishes SEP-29 config.memo_required, so the app routes the close
// through the mediator (the same rule as for a registry exchange): the account
// funds and merges into a per-flow temporary account minted by
// /api/mediator/sign, and the server co-signs the forward that pays everything
// to the destination with the deposit memo and merges the temporary account.
//
// the server runs with a MEDIATOR_SECRET generated for the run, behind the
// reverse proxy the app requires (tests/helpers/e2e-server.mjs). no exchange
// registry entry is needed: a SEP-29 account takes the same mediator route, so
// nothing test-only is added to the app.
//
// the check is on chain, not on the account being gone: a merge into the
// temporary account also deletes the source, so only the forward landing at the
// destination with the memo proves the close reached the exchange.

// a fresh deposit account that publishes config.memo_required, and the account
// to close into it
async function exchangeFixture() {
  const { source } = await fundedPair();
  const exchange = Keypair.random();
  await friendbotFund(exchange.publicKey());
  await submitAs(exchange, [Operation.manageData({ name: "config.memo_required", value: "1" })]);
  const depositMemo = `e2e-${Date.now().toString(36)}`;
  return { source, exchange, depositMemo };
}

async function startExchangeClose(
  page: Page,
  source: Keypair,
  exchange: Keypair,
  depositMemo: string,
): Promise<void> {
  await page.goto("/demolish");
  await connectWithSecret(page, source.secret());
  await configureClose(page, exchange.publicKey(), { type: "Text", value: depositMemo });
  await acknowledgeNotices(page);
  // the review shows the memo the exchange will receive
  await expect(page.getByTestId("review-memo")).toContainText(depositMemo, { timeout: 120_000 });
  await confirmReviewedClose(page, exchange.publicKey());
}

// the source merged into one temporary account, which forwarded everything to
// the exchange in one memo'd transaction and is gone
async function expectForwardedToExchange(
  source: Keypair,
  exchange: Keypair,
  depositMemo: string,
): Promise<void> {
  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
  const [sourceMerge, ...extraMerges] = await mergesOf(source.publicKey());
  expect(extraMerges).toEqual([]);
  const mediator = sourceMerge!.into;
  expect(mediator).not.toBe(exchange.publicKey());

  expect(await accountExists(mediator)).toBe(false);
  const forwards = await mergesOf(mediator);
  expect(forwards.map((f) => f.into)).toEqual([exchange.publicKey()]);
  const forwardTx = await horizon.transactions().transaction(forwards[0]!.tx).call();
  expect(forwardTx.memo_type).toBe("text");
  expect(forwardTx.memo).toBe(depositMemo);
}

test("closes into a memo-required deposit account through the mediator", async ({ page }) => {
  test.setTimeout(240_000);

  const { source, exchange, depositMemo } = await exchangeFixture();
  const sourceBalance = await nativeBalance(source.publicKey());
  const exchangeBefore = await nativeBalance(exchange.publicKey());

  await startExchangeClose(page, source, exchange, depositMemo);
  await expect(closedHeading(page)).toBeVisible({ timeout: 180_000 });
  await expectForwardedToExchange(source, exchange, depositMemo);

  // the exchange got the account's balance less the network fees
  const received = (await nativeBalance(exchange.publicKey())) - exchangeBefore;
  expect(received).toBeLessThanOrEqual(sourceBalance);
  expect(received).toBeGreaterThan(sourceBalance - 1_0000000n);
});

// the case the close must never report as done: the merge into the temporary
// account landed, but the forward could not be co-signed because the mediator
// endpoint stopped answering. the page has to say where the balance is, keep
// Retry, and finish the forward on Retry without repeating the merge.
test("a forward the mediator could not co-sign finishes on Retry", async ({ page }) => {
  test.setTimeout(270_000);

  const { source, exchange, depositMemo } = await exchangeFixture();
  const sourceBalance = await nativeBalance(source.publicKey());
  const exchangeBefore = await nativeBalance(exchange.publicKey());

  // the flow is minted with a GET; the only POST is the forward's co-signature
  let cosignAttempts = 0;
  await page.route("**/api/mediator/sign", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    cosignAttempts += 1;
    await route.abort("connectionrefused");
  });
  await startExchangeClose(page, source, exchange, depositMemo);

  await expect(failedHeading(page)).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("failure-kind-note")).toContainText(
    "Your balance is in the temporary forwarding account",
  );
  expect(cosignAttempts).toBeGreaterThan(0);

  // on chain: the source is gone into the temporary account, which still holds
  // the balance and has not paid the exchange
  expect(await accountExists(source.publicKey())).toBe(false);
  const [merge] = await mergesOf(source.publicKey());
  const mediator = merge!.into;
  expect(mediator).not.toBe(exchange.publicKey());
  expect(await accountExists(mediator)).toBe(true);
  expect(await nativeBalance(mediator)).toBeGreaterThan(sourceBalance - 1_0000000n);
  expect(await nativeBalance(exchange.publicKey())).toBe(exchangeBefore);

  // the endpoint is back; Retry runs only the forward
  await page.unroute("**/api/mediator/sign");
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(closedHeading(page)).toBeVisible({ timeout: 180_000 });

  await expectForwardedToExchange(source, exchange, depositMemo);
  const received = (await nativeBalance(exchange.publicKey())) - exchangeBefore;
  expect(received).toBeLessThanOrEqual(sourceBalance);
  expect(received).toBeGreaterThan(sourceBalance - 1_0000000n);
});

// an account with little more than its reserves: the temporary account's 2 XLM
// starting balance only fits once the close has removed the account's
// trustlines and data entry, so the funding has to come after them in the
// batch. funding it first fails op_underfunded and nothing reaches the exchange.
test("closes a near-reserve account into a memo-required deposit account", async ({ page }) => {
  test.setTimeout(240_000);

  const funder = Keypair.random();
  const issuer = Keypair.random();
  const source = Keypair.random();
  const exchange = Keypair.random();
  await friendbotFund(funder.publicKey());
  await friendbotFund(issuer.publicKey());
  await friendbotFund(exchange.publicKey());
  await submitAs(exchange, [Operation.manageData({ name: "config.memo_required", value: "1" })]);
  // 4.6 XLM over five entries: 3 XLM of it is reserve until they are removed
  await submitAs(
    funder,
    [
      Operation.createAccount({ destination: source.publicKey(), startingBalance: "4.6" }),
      ...["AAA", "BBB", "CCC"].map((code) =>
        Operation.changeTrust({
          asset: new Asset(code, issuer.publicKey()),
          source: source.publicKey(),
        }),
      ),
      Operation.manageData({ name: "note", value: "1", source: source.publicKey() }),
    ],
    [source],
  );
  const depositMemo = `e2e-low-${Date.now().toString(36)}`;
  const sourceBalance = await nativeBalance(source.publicKey());
  expect(sourceBalance).toBe(4_6000000n);
  const exchangeBefore = await nativeBalance(exchange.publicKey());

  await startExchangeClose(page, source, exchange, depositMemo);
  await expect(closedHeading(page)).toBeVisible({ timeout: 180_000 });
  await expectForwardedToExchange(source, exchange, depositMemo);

  const received = (await nativeBalance(exchange.publicKey())) - exchangeBefore;
  expect(received).toBeLessThanOrEqual(sourceBalance);
  expect(received).toBeGreaterThan(sourceBalance - 1_0000000n);
});
