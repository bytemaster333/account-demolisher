import { test, expect, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Keypair, Operation } from "@stellar/stellar-sdk";

import { friendbotFund, submitAs } from "./support/chain";
import { acknowledgeNotices, configureClose, connectWithSecret } from "./support/flow";

// Accessibility sweep (Tranche-3 deliverable). We fail the build on CRITICAL and
// SERIOUS axe violations (the impacts that meaningfully block users) and log
// lower-impact findings without failing, so a11y debt is visible without making
// the gate brittle on advisory rules.
const ROUTES = ["/", "/demolish", "/allowances", "/sign"] as const;

async function expectNoBlockingViolations(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  // color-contrast is ADVISORY here: axe cannot reliably compute contrast over
  // the app's ambient gradient / translucent overlay backgrounds (false
  // positives), and contrast tuning is a manual design decision. Every OTHER
  // critical/serious finding (missing labels, roles, names, ARIA misuse) hard-
  // fails the build.
  const isBlocking = (v: { impact?: string | null; id: string }): boolean =>
    (v.impact === "critical" || v.impact === "serious") && v.id !== "color-contrast";
  const blocking = results.violations.filter(isBlocking);
  const advisory = results.violations.filter((v) => !isBlocking(v));

  if (advisory.length > 0) {
    await testInfo.attach(`axe-advisory-${name.replace(/[^a-z0-9]+/gi, "_")}`, {
      body: JSON.stringify(advisory, null, 2),
      contentType: "application/json",
    });
  }

  expect(
    blocking,
    `Critical/serious a11y violations on ${name}:\n${JSON.stringify(
      blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })),
      null,
      2,
    )}`,
  ).toEqual([]);
}

for (const route of ROUTES) {
  test(`no critical/serious accessibility violations on ${route}`, async ({ page }, testInfo) => {
    await page.goto(route);
    // let SSR + client hydration settle so dynamically-rendered controls are
    // scanned (avoid networkidle: pages with a live relay/SSE never go idle)
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(600);
    await expectNoBlockingViolations(page, testInfo, route);
  });
}

// the two screens that take over /demolish when an account can't be closed.
// each needs a real testnet account in that state, since the screen only shows
// once the account has been audited.
test.describe("blocked close screens", () => {
  test("the auth-immutable block has no critical/serious violations", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    // AUTH_IMMUTABLE is permanent and stops a merge for good, so this throwaway
    // account stays on testnet with its friendbot lumens
    const account = Keypair.random();
    const destination = Keypair.random();
    await friendbotFund(account.publicKey());
    await friendbotFund(destination.publicKey());
    await submitAs(account, [Operation.setOptions({ setFlags: 4 })]);

    await page.goto("/demolish");
    await connectWithSecret(page, account.secret());
    await configureClose(page, destination.publicKey());
    const block = page.getByTestId("auth-immutable-block");
    await expect(block).toBeVisible({ timeout: 120_000 });
    await expect(block).toHaveRole("region");
    await expectNoBlockingViolations(page, testInfo, "/demolish auth-immutable block");
  });

  test("the sponsoring block has no critical/serious violations", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    // the account pays the reserves of a second account it created, which the
    // close can't release on its own
    const account = Keypair.random();
    const sponsored = Keypair.random();
    const destination = Keypair.random();
    await friendbotFund(account.publicKey());
    await friendbotFund(destination.publicKey());
    await submitAs(
      account,
      [
        Operation.beginSponsoringFutureReserves({ sponsoredId: sponsored.publicKey() }),
        Operation.createAccount({ destination: sponsored.publicKey(), startingBalance: "0" }),
        Operation.endSponsoringFutureReserves({ source: sponsored.publicKey() }),
      ],
      [sponsored],
    );

    await page.goto("/demolish");
    await connectWithSecret(page, account.secret());
    await configureClose(page, destination.publicKey());
    const block = page.getByTestId("sponsoring-block");
    await expect(block).toBeVisible({ timeout: 120_000 });
    await expect(block).toHaveRole("region");
    await expectNoBlockingViolations(page, testInfo, "/demolish sponsoring block");
  });
});

// the typed confirmation only opens after a real review, so the route sweep
// above never reaches it. it is scanned while its unlock countdown still shows.
test("the typed confirmation dialog has no critical/serious violations", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const account = Keypair.random();
  const destination = Keypair.random();
  await friendbotFund(account.publicKey());
  await friendbotFund(destination.publicKey());

  await page.goto("/demolish");
  await connectWithSecret(page, account.secret());
  await configureClose(page, destination.publicKey());
  await acknowledgeNotices(page);
  const reviewConfirm = page.getByTestId("demolish-confirm");
  await reviewConfirm.waitFor({ state: "visible", timeout: 120_000 });
  await reviewConfirm.click();
  await page.getByTestId("typed-confirmation").waitFor();
  await expect(page.getByRole("progressbar", { name: "Confirm unlock countdown" })).toBeVisible();
  await expectNoBlockingViolations(page, testInfo, "/demolish typed confirmation");
});

// the landing runs looping animations (the pulsing rings, the floating and
// turning key). with reduced motion asked for, globals.css cuts every animation
// to one near-instant run and transitions to near zero.
test.describe("reduced motion", () => {
  interface Motion {
    readonly name: string;
    readonly iterations: string;
    readonly duration: string;
  }

  // every element on the page that runs a css animation
  async function animated(page: Page): Promise<Motion[]> {
    return page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .map((el) => getComputedStyle(el))
        .filter((s) => s.animationName !== "none")
        .map((s) => ({
          name: s.animationName,
          iterations: s.animationIterationCount,
          duration: s.animationDuration,
        })),
    );
  }

  test("the landing animations loop without the preference", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const motions = await animated(page);
    // the check below means nothing unless the page really animates
    expect(motions.filter((m) => m.iterations === "infinite").map((m) => m.name)).toEqual(
      expect.arrayContaining(["ringPulse", "keyFloat", "keyTurn"]),
    );
  });

  test("the landing animations stop with prefers-reduced-motion: reduce", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const motions = await animated(page);
    expect(motions.map((m) => m.name)).toEqual(
      expect.arrayContaining(["ringPulse", "keyFloat", "keyTurn"]),
    );
    for (const m of motions) {
      expect(m.iterations, `${m.name} iteration count`).toBe("1");
      expect(Number.parseFloat(m.duration), `${m.name} duration`).toBeLessThanOrEqual(0.00001);
    }
    // the card flips and hover fades are transitions; they are cut as well
    const transitions = await page.evaluate(() =>
      [...document.querySelectorAll("*")]
        .map((el) => getComputedStyle(el).transitionDuration)
        .flatMap((d) => d.split(",").map((part) => Number.parseFloat(part))),
    );
    expect(transitions.length).toBeGreaterThan(0);
    expect(Math.max(...transitions)).toBeLessThanOrEqual(0.00001);
  });
});
