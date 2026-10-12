import { test, expect } from "@playwright/test";

import { watchCspViolations } from "./support/csp";

// Basic smoke coverage: every top-level route renders server-side without a
// client-side crash and shows its primary content. No wallet needed: these
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

// both pages build zod schemas while they load. zod's eval probe would show up
// here as a script-src violation, since the production policy has no
// 'unsafe-eval' (NPF-41, src/lib/zod.ts)
for (const route of ["/demolish", "/allowances"]) {
  test(`${route} loads with no Content-Security-Policy violation`, async ({ page }) => {
    const cspViolations = await watchCspViolations(page);
    // goto waits for the load event, which waits for the page's async chunk
    // scripts, so the schemas have been built by the time it returns
    const response = await page.goto(route, { waitUntil: "load" });
    expect(response?.ok()).toBeTruthy();
    await expect(page.getByRole("button", { name: /select network/i })).toBeVisible();
    expect(await cspViolations()).toEqual([]);
  });
}

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
  // (mainnet-confirm.test.tsx) + the AppShell switcher logic. Here we only assert
  // the switcher is present and defaults to testnet; driving the custom listbox
  // dropdown through Playwright is flaky and adds no coverage the unit tests don't.
  await page.goto("/demolish");
  const netButton = page.getByRole("button", { name: /select network/i });
  await expect(netButton).toBeVisible();
  await expect(netButton).toContainText(/testnet/i);
});

test("serves the SEP-1 stellar.toml at the well-known path, CORS-readable", async ({ request }) => {
  const res = await request.get("/.well-known/stellar.toml");
  expect(res.ok()).toBeTruthy();
  expect(res.headers()["access-control-allow-origin"]).toBe("*");
  expect(await res.text()).toContain("[DOCUMENTATION]");
});

test("serves a sitemap and robots pointing at the canonical origin", async ({ request }) => {
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBeTruthy();
  expect(await sitemap.text()).toContain("<urlset");

  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBeTruthy();
  expect(await robots.text()).toMatch(/Sitemap:\s*https?:\/\//i);
});
