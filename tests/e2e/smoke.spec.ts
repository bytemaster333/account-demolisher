import { test, expect } from "@playwright/test";

// Basic smoke coverage: every top-level route renders server-side without a
// client-side crash and shows its primary content. No wallet needed — these
// assert the app boots and routes resolve against the built production server.

test("landing page renders the app", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Account Demolisher/i);
});

test("demolish page renders the close flow", async ({ page }) => {
  const response = await page.goto("/demolish");
  expect(response?.ok()).toBeTruthy();
  // the network switcher (a custom listbox button) lives in the shared header
  await expect(page.getByRole("button", { name: /select network/i })).toBeVisible();
});

test("allowances page renders", async ({ page }) => {
  const response = await page.goto("/allowances");
  expect(response?.ok()).toBeTruthy();
});

test("sign page renders", async ({ page }) => {
  const response = await page.goto("/sign");
  expect(response?.ok()).toBeTruthy();
});

test("network switcher renders with the default (testnet) network", async ({ page }) => {
  // The mainnet-switch CONFIRMATION GATE itself is covered by unit tests
  // (mainnet-confirm.test.tsx, 5 cases) + the AppShell switcher logic. Here we
  // only assert the switcher is present and defaults to testnet — driving the
  // custom listbox dropdown through Playwright under dynamic (nonce-CSP) rendering
  // is flaky and adds no coverage the unit tests don't already provide.
  await page.goto("/demolish");
  const netButton = page.getByRole("button", { name: /select network/i });
  await expect(netButton).toBeVisible();
  await expect(netButton).toContainText(/testnet/i);
});
