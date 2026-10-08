// the steps a person takes on /demolish, driven through what the page shows:
// labels, buttons and the acknowledgement checkboxes. nothing here reads the
// app's internal state.

import { expect, type Page } from "@playwright/test";

export async function connectWithSecret(page: Page, secret: string): Promise<void> {
  await page.locator('button[aria-controls="advanced-secret-panel"]').click();
  await page.getByTestId("secret-key-input").fill(secret);
  await page.getByTestId("secret-key-submit").click();
  // the configure step appears once the wallet is connected
  await expect(page.getByTestId("destination-input")).toBeVisible();
}

export interface MemoInput {
  readonly type: "Text" | "ID";
  readonly value: string;
}

export async function configureClose(
  page: Page,
  destination: string,
  memo?: MemoInput,
): Promise<void> {
  await page.getByTestId("destination-input").fill(destination);
  if (memo !== undefined) {
    await page.getByRole("button", { name: "Memo type" }).click();
    await page.getByRole("option", { name: memo.type, exact: true }).click();
    await page.getByTestId("memo-value-input").fill(memo.value);
  }
  const start = page.getByTestId("demolish-start");
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();
}

// the warnings step, when the plan has notices to read. only the
// acknowledgement checkboxes are ticked (their ids start with "ack-"), never a
// checkbox that would opt into something.
export async function acknowledgeNotices(page: Page): Promise<void> {
  const ackContinue = page.getByTestId("acknowledge-continue");
  const reviewConfirm = page.getByTestId("demolish-confirm");
  const createRequest = page.getByTestId("review-create-request");
  await expect(ackContinue.or(reviewConfirm).or(createRequest).first()).toBeVisible({
    timeout: 120_000,
  });
  if (!(await ackContinue.isVisible())) return;
  const acks = page.locator('input[type="checkbox"][data-testid^="ack-"]');
  const count = await acks.count();
  for (let i = 0; i < count; i++) await acks.nth(i).check();
  await expect(ackContinue).toBeEnabled();
  await ackContinue.click();
}

// review, then the typed confirmation: the last four characters of the
// destination, after the deliberate delay
export async function confirmReviewedClose(page: Page, destination: string): Promise<void> {
  const reviewConfirm = page.getByTestId("demolish-confirm");
  await reviewConfirm.waitFor({ state: "visible", timeout: 120_000 });
  await reviewConfirm.click();
  await typeConfirmation(page, destination);
}

export async function typeConfirmation(page: Page, destination: string): Promise<void> {
  await page.getByTestId("typed-confirmation").waitFor();
  await page.getByTestId("typed-confirmation-input").fill(destination.slice(-4));
  const finalConfirm = page.getByTestId("typed-confirmation-confirm");
  await expect(finalConfirm).toBeEnabled({ timeout: 15_000 });
  await finalConfirm.click();
}

export function closedHeading(page: Page) {
  return page.getByRole("heading", { name: "Account closed" });
}

export function failedHeading(page: Page) {
  return page.getByRole("heading", { name: "Couldn't finish closing the account" });
}
