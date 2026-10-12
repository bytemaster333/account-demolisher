// collects every Content-Security-Policy violation the page reports, so a spec
// fails when the policy blocks something the page needed. the listener goes in
// before any page script runs.

import type { Page } from "@playwright/test";

export interface CspViolation {
  readonly directive: string;
  readonly blockedUri: string;
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
  }
}

export async function watchCspViolations(page: Page): Promise<() => Promise<CspViolation[]>> {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations?.push({ directive: e.effectiveDirective, blockedUri: e.blockedURI });
    });
  });
  return () => page.evaluate(() => window.__cspViolations ?? []);
}

// the WalletConnect telemetry hosts the policy leaves out on purpose
// (src/lib/config/csp.ts): AppKit still tries to send its mandatory events there
export function isWalletConnectTelemetry(v: CspViolation): boolean {
  return /^https:\/\/pulse\.walletconnect\.(com|org)(\/|$)/.test(v.blockedUri);
}
