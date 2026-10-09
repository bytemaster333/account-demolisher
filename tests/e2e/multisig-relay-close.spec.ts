import { test, expect } from "@playwright/test";
import { Keypair, Operation } from "@stellar/stellar-sdk";

import { accountExists, fundedPair, mergesOf, nativeBalance, submitAs } from "./support/chain";
import {
  acknowledgeNotices,
  closedHeading,
  configureClose,
  connectWithSecret,
  typeConfirmation,
} from "./support/flow";

// a shared account closed through the signing relay, with two people in two
// separate browser contexts (no shared storage, as on two machines). the
// account needs both keys: the initiator builds and signs the request on
// /demolish, sends the link, the co-signer opens it on /sign and adds a
// signature, and the initiator, seeing the weight reach the threshold, closes.

test("two signers close a shared account through the signing relay", async ({ browser }) => {
  test.setTimeout(240_000);

  const { source, destination } = await fundedPair();
  const cosigner = Keypair.random();
  // master weight 1, co-signer weight 1, every threshold 2: both must sign
  await submitAs(source, [
    Operation.setOptions({
      signer: { ed25519PublicKey: cosigner.publicKey(), weight: 1 },
      masterWeight: 1,
      lowThreshold: 2,
      medThreshold: 2,
      highThreshold: 2,
    }),
  ]);
  const sourceBalance = await nativeBalance(source.publicKey());
  const destBefore = await nativeBalance(destination.publicKey());

  const initiatorContext = await browser.newContext();
  const cosignerContext = await browser.newContext();
  try {
    // --- the initiator builds the request and signs it with their key ---
    const initiator = await initiatorContext.newPage();
    await initiator.goto("/demolish");
    await connectWithSecret(initiator, source.secret());
    await configureClose(initiator, destination.publicKey());
    await acknowledgeNotices(initiator);
    const create = initiator.getByTestId("review-create-request");
    await expect(create).toBeEnabled({ timeout: 120_000 });
    await create.click();

    const link = initiator.getByTestId("collect-link");
    await expect(link).toContainText("/sign?id=", { timeout: 60_000 });
    const progress = initiator.getByTestId("collect-progress");
    await expect(progress).toContainText("1 of 2", { timeout: 60_000 });
    await expect(initiator.getByTestId("collect-close")).toBeDisabled();
    const url = new URL((await link.innerText()).trim());

    // --- the co-signer opens the link elsewhere and adds their signature ---
    const other = await cosignerContext.newPage();
    await other.goto(`${url.pathname}${url.search}`);
    // the co-signer sees what they are signing: this account, merged into the
    // destination, with nothing unexpected in it
    await expect(other.getByText("EVERYTHING LEFT GOES TO")).toBeVisible({ timeout: 60_000 });
    await expect(other.locator("main")).toContainText(destination.publicKey());
    await expect(other.locator("main")).toContainText(source.publicKey());
    await expect(other.getByTestId("sign-op-unexpected")).toHaveCount(0);
    await other.getByTestId("sign-secret").fill(cosigner.secret());
    await other.getByTestId("sign-secret-submit").click();
    await expect(other.getByTestId("sign-progress")).toContainText("2 of 2", { timeout: 60_000 });

    // --- the initiator sees the threshold met and closes ---
    await expect(progress).toContainText("2 of 2", { timeout: 60_000 });
    const close = initiator.getByTestId("collect-close");
    await expect(close).toBeEnabled({ timeout: 60_000 });
    await expect(close).toHaveText(/Continue to final confirmation/, { timeout: 60_000 });
    await close.click();
    await typeConfirmation(initiator, destination.publicKey());

    await expect(closedHeading(initiator)).toBeVisible({ timeout: 120_000 });

    await expect
      .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
      .toBe(false);
    expect((await mergesOf(source.publicKey())).map((m) => m.into)).toEqual([
      destination.publicKey(),
    ]);
    const received = (await nativeBalance(destination.publicKey())) - destBefore;
    expect(received).toBeLessThanOrEqual(sourceBalance);
    expect(received).toBeGreaterThan(sourceBalance - 1_0000000n);
  } finally {
    await initiatorContext.close();
    await cosignerContext.close();
  }
});
