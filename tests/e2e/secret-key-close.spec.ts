import { test, expect } from "@playwright/test";

import { accountExists, fundedPair, mergesOf, nativeBalance } from "./support/chain";
import {
  acknowledgeNotices,
  closedHeading,
  configureClose,
  confirmReviewedClose,
  connectWithSecret,
} from "./support/flow";

// End-to-end proof of the secret-key fallback closure: a real browser drives the
// /demolish flow, connects by pasting a throwaway testnet secret key (no wallet
// extension), and closes the account for real. Setup and assertions hit live
// testnet Horizon + Friendbot; nothing is mocked. The source is kept under the
// 1000-XLM high-value threshold so the flow runs straight to Review (the
// high-value gate has its own unit coverage).

test("secret-key fallback closes a funded testnet account end to end", async ({ page }) => {
  test.setTimeout(180_000);

  const { source, destination } = await fundedPair();
  const sourceBalance = await nativeBalance(source.publicKey());
  const destBefore = await nativeBalance(destination.publicKey());

  await page.goto("/demolish");
  await connectWithSecret(page, source.secret());
  await configureClose(page, destination.publicKey());
  await acknowledgeNotices(page);
  await confirmReviewedClose(page, destination.publicKey());

  // what the person sees: the close finished
  await expect(closedHeading(page)).toBeVisible({ timeout: 120_000 });

  // on chain: the source merged straight into the destination, which received
  // its whole balance less the network fees
  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
  const merges = await mergesOf(source.publicKey());
  expect(merges.map((m) => m.into)).toEqual([destination.publicKey()]);
  const received = (await nativeBalance(destination.publicKey())) - destBefore;
  expect(received).toBeLessThanOrEqual(sourceBalance);
  expect(received).toBeGreaterThan(sourceBalance - 1_0000000n);
});
