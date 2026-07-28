import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Accessibility sweep (Tranche-3 deliverable). We fail the build on CRITICAL and
// SERIOUS axe violations — the impacts that meaningfully block users — and log
// lower-impact findings without failing, so a11y debt is visible without making
// the gate brittle on advisory rules.
const ROUTES = ["/", "/demolish", "/allowances", "/sign"] as const;

for (const route of ROUTES) {
  test(`no critical/serious accessibility violations on ${route}`, async ({ page }, testInfo) => {
    await page.goto(route);
    // let SSR + client hydration settle so dynamically-rendered controls are
    // scanned (avoid networkidle: pages with a live relay/SSE never go idle)
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(600);

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
      await testInfo.attach(`axe-advisory-${route.replace(/\//g, "_")}`, {
        body: JSON.stringify(advisory, null, 2),
        contentType: "application/json",
      });
    }

    expect(
      blocking,
      `Critical/serious a11y violations on ${route}:\n${JSON.stringify(
        blocking.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })),
        null,
        2,
      )}`,
    ).toEqual([]);
  });
}
