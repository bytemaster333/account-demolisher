// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the walletconnect project id is build config; each test decides whether the
// deployment has one
const env = { wcProjectId: undefined as string | undefined };
vi.mock("@/lib/config/env", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
    NEXT_PUBLIC_DEPLOYMENT_MODE: "reference",
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: env.wcProjectId,
  }),
}));
vi.mock("@/lib/metrics/beacon", () => ({ trackVisit: () => {} }));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <main data-testid="shell-main">{children}</main>
  ),
}));

import LandingPage from "@/app/page";

beforeEach(() => {
  env.wcProjectId = undefined;
});

afterEach(cleanup);

describe("landing page structure", () => {
  it("adds no second main landmark inside the shell", () => {
    render(<LandingPage />);
    expect(screen.getByTestId("shell-main").querySelectorAll("main")).toHaveLength(0);
  });

  it("wires each FAQ toggle to its answer", () => {
    render(<LandingPage />);
    const toggles = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-controls")?.startsWith("faq-"));
    expect(toggles.length).toBeGreaterThan(3);
    for (const t of toggles) {
      expect(["true", "false"]).toContain(t.getAttribute("aria-expanded"));
      expect(document.getElementById(t.getAttribute("aria-controls")!)).not.toBeNull();
    }
  });

  it("names every focusable card", () => {
    const { container } = render(<LandingPage />);
    const focusable = container.querySelectorAll<HTMLElement>("div[tabindex='0']");
    expect(focusable.length).toBeGreaterThan(0);
    for (const el of focusable) {
      expect(el.getAttribute("role")).toBe("group");
      expect(el.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
      expect(el.style.outline).not.toBe("none");
    }
  });
});

describe("landing page claims", () => {
  it("does not overstate the allow-list, signing, fees or permanence", () => {
    const { container } = render(<LandingPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Every contract is on a hardcoded allow-list/);
    expect(text).not.toMatch(/every integration on a hardcoded allow-list/);
    expect(text).not.toMatch(/Nothing is auto-signed/);
    expect(text).not.toMatch(/You approve every transaction in your wallet/);
    expect(text).not.toMatch(/Real fees from a live simulation/);
    expect(text).not.toMatch(/forever/);
    expect(text).not.toMatch(/5 OPS/);
    expect(text).not.toMatch(/Revoke any of them with a single signed call/);
    expect(text).toMatch(/last 7 days/);
  });

  it("makes no claim about FxDAO, which shut down and is not supported", () => {
    const { container } = render(<LandingPage />);
    expect(container.textContent ?? "").not.toMatch(/FxDAO/i);
  });

  it("links the security docs to the docs site, not the readme", () => {
    render(<LandingPage />);
    const link = screen.getByText("Read the security docs").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "https://docs.demolisher.app/docs/developers/security/model",
    );
  });

  it("leaves WalletConnect out when the deployment has no project id", () => {
    const { container } = render(<LandingPage />);
    expect(container.textContent).not.toMatch(/WalletConnect/);
  });

  it("lists WalletConnect when the deployment has a project id", () => {
    env.wcProjectId = "abc123";
    const { container } = render(<LandingPage />);
    expect(container.textContent).toMatch(/WalletConnect/);
  });
});
