import { test, expect } from "@playwright/test";

// Verifies the wallet picker integrates the two Tranche-1 wallets that aren't in
// the kit's zero-config defaults: Ledger (hardware) and WalletConnect (mobile via
// QR). Constructing the WalletConnect module spins up Reown AppKit + a relay
// client, so this also proves that wiring loads at runtime without throwing and
// without breaking the picker. Full hardware/mobile signing is out of scope for
// an unattended run; this asserts the modules are present and load cleanly.

test("wallet picker lists Ledger and WalletConnect and loads without error", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto("/demolish");

  await page.getByTestId("connect-button").click();

  // the kit renders its picker as a custom element; wallet names are queryable
  // through Playwright's open-shadow-DOM piercing
  await expect(page.getByText("Ledger", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("WalletConnect", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });

  // the browser-extension defaults must still be there (nothing regressed)
  await expect(page.getByText("Freighter", { exact: true }).first()).toBeVisible();

  expect(pageErrors, `unexpected page errors: ${pageErrors.join("\n")}`).toEqual([]);
});
