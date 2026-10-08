import { test, expect } from "@playwright/test";

import { accountExists, fundedPair, mergesOf, nativeBalance } from "./support/chain";
import {
  acknowledgeNotices,
  closedHeading,
  configureClose,
  confirmReviewedClose,
  connectWithSecret,
  failedHeading,
} from "./support/flow";

// failure and recovery in the browser, with the fault injected where it happens
// in real life: between the browser and testnet Horizon. playwright routes the
// page's own requests to horizon-testnet.stellar.org; the app and the network
// are untouched.

const FEE_STATS = "https://horizon-testnet.stellar.org/fee_stats*";
const SUBMIT = "https://horizon-testnet.stellar.org/transactions";

test("a close that fails while Horizon is unreachable finishes on Retry", async ({ page }) => {
  test.setTimeout(240_000);

  const { source, destination } = await fundedPair();
  const sourceBalance = await nativeBalance(source.publicKey());
  const destBefore = await nativeBalance(destination.publicKey());

  await page.goto("/demolish");
  await connectWithSecret(page, source.secret());
  await configureClose(page, destination.publicKey());
  await acknowledgeNotices(page);

  // Horizon's fee endpoint stops answering after the review was built
  await page.getByTestId("demolish-confirm").waitFor({ state: "visible", timeout: 120_000 });
  await page.route(FEE_STATS, (route) => route.abort("connectionrefused"));
  await confirmReviewedClose(page, destination.publicKey());

  // the person sees the close stopped, why, and that nothing was sent
  await expect(failedHeading(page)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("demolish-status-widget")).toContainText(
    "network fees could not be read",
  );
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeEnabled();
  expect(await accountExists(source.publicKey())).toBe(true);
  expect(await mergesOf(source.publicKey())).toEqual([]);

  // Horizon is back; Retry runs the reviewed close
  await page.unroute(FEE_STATS);
  await retry.click();
  await expect(closedHeading(page)).toBeVisible({ timeout: 120_000 });

  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
  expect((await mergesOf(source.publicKey())).map((m) => m.into)).toEqual([
    destination.publicKey(),
  ]);
  const received = (await nativeBalance(destination.publicKey())) - destBefore;
  expect(received).toBeLessThanOrEqual(sourceBalance);
  expect(received).toBeGreaterThan(sourceBalance - 1_0000000n);
});

test("a submit whose reply is lost is settled from the chain, not sent twice", async ({ page }) => {
  test.setTimeout(240_000);

  const { source, destination } = await fundedPair();

  await page.goto("/demolish");
  await connectWithSecret(page, source.secret());
  await configureClose(page, destination.publicKey());
  await acknowledgeNotices(page);

  // the merge reaches Horizon and lands, but the connection drops before the
  // browser reads the answer
  let submits = 0;
  await page.route(SUBMIT, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submits += 1;
    await route.fetch();
    await route.abort("connectionreset");
  });
  await confirmReviewedClose(page, destination.publicKey());

  await expect(closedHeading(page)).toBeVisible({ timeout: 180_000 });
  // one submission, found on chain by its hash; nothing was signed or sent again
  expect(submits).toBe(1);
  expect(await accountExists(source.publicKey())).toBe(false);
  expect((await mergesOf(source.publicKey())).map((m) => m.into)).toEqual([
    destination.publicKey(),
  ]);
});
