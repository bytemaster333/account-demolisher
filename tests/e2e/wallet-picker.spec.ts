import { test, expect } from "@playwright/test";

import { watchCspViolations } from "./support/csp";

// Verifies the wallet picker integrates the two Tranche-1 wallets that aren't in
// the kit's zero-config defaults: Ledger (hardware, always present) and
// WalletConnect (mobile via QR, added only when a project id is configured).
// Opening the picker must not start WalletConnect (src/lib/wallet/kit.ts builds it
// only when it is picked), and nothing the picker loads may be blocked by the
// Content-Security-Policy. Full hardware/mobile signing is out of scope for an
// unattended run; this asserts the modules are present and load cleanly.
// In CI the build and this test process receive the same
// NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID from the job environment, so the
// WalletConnect assertion tracks the picker's actual conditional behaviour.
const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ?? "";

test("wallet picker lists Ledger and WalletConnect and loads without error", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const cspViolations = await watchCspViolations(page);

  await page.goto("/demolish");

  await page.getByTestId("connect-button").click();

  // the kit renders its picker as a custom element; wallet names are queryable
  // through Playwright's open-shadow-DOM piercing
  await expect(page.getByText("Ledger", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  // WalletConnect is present only when a project id is configured (the app leaves
  // it out otherwise). Assert it is visible when this run has one; when it does
  // not, skip the check rather than assume the build had none, since a local build
  // can read the id from .env.local while this process does not.
  if (WC_PROJECT_ID !== "") {
    await expect(page.getByText("WalletConnect", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
  } else {
    test.info().annotations.push({
      type: "skip",
      description: "WalletConnect not configured (NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID unset)",
    });
  }

  // the browser-extension defaults must still be there (nothing regressed)
  await expect(page.getByText("Freighter", { exact: true }).first()).toBeVisible();

  expect(pageErrors, `unexpected page errors: ${pageErrors.join("\n")}`).toEqual([]);
  // the wallet icons and the picker itself load under the policy as shipped
  expect(await cspViolations()).toEqual([]);
});
