import { test, expect } from "@playwright/test";
import { Keypair, Operation } from "@stellar/stellar-sdk";

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

test("closes into a memo-required deposit account through the mediator", async ({ page }) => {
  test.setTimeout(240_000);

  const { source } = await fundedPair();
  const exchange = Keypair.random();
  await friendbotFund(exchange.publicKey());
  await submitAs(exchange, [Operation.manageData({ name: "config.memo_required", value: "1" })]);
  const depositMemo = `e2e-${Date.now().toString(36)}`;

  const sourceBalance = await nativeBalance(source.publicKey());
  const exchangeBefore = await nativeBalance(exchange.publicKey());

  await page.goto("/demolish");
  await connectWithSecret(page, source.secret());
  await configureClose(page, exchange.publicKey(), { type: "Text", value: depositMemo });
  await acknowledgeNotices(page);
  // the review shows the memo the exchange will receive
  await expect(page.getByTestId("review-memo")).toContainText(depositMemo, { timeout: 120_000 });
  await confirmReviewedClose(page, exchange.publicKey());

  await expect(closedHeading(page)).toBeVisible({ timeout: 180_000 });

  // the source merged into a temporary account, never straight into the exchange
  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
  const [sourceMerge, ...extraMerges] = await mergesOf(source.publicKey());
  expect(extraMerges).toEqual([]);
  const mediator = sourceMerge!.into;
  expect(mediator).not.toBe(exchange.publicKey());

  // the temporary account forwarded everything to the exchange in one memo'd
  // transaction and is gone
  expect(await accountExists(mediator)).toBe(false);
  const forwards = await mergesOf(mediator);
  expect(forwards.map((f) => f.into)).toEqual([exchange.publicKey()]);
  const forwardTx = await horizon.transactions().transaction(forwards[0]!.tx).call();
  expect(forwardTx.memo_type).toBe("text");
  expect(forwardTx.memo).toBe(depositMemo);

  // the exchange got the account's balance less the network fees
  const received = (await nativeBalance(exchange.publicKey())) - exchangeBefore;
  expect(received).toBeLessThanOrEqual(sourceBalance);
  expect(received).toBeGreaterThan(sourceBalance - 1_0000000n);
});
