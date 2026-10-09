// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";

// the kit's default browser-extension modules pull in wallet SDKs that do not load
// under vitest, and the picker theme does not depend on them
vi.mock("@creit.tech/stellar-wallets-kit/modules/utils", () => ({ defaultModules: () => [] }));

// values only our palettes carry (the kit's own default light theme has a
// different primary and font), so a match proves our palette was applied
const LIGHT = {
  background: "#ffffff",
  primary: "#1f7a52",
  "foreground-strong": "#15171a",
  "font-family": "Geist, ui-sans-serif, system-ui, sans-serif",
};
const DARK = {
  background: "#141618",
  primary: "#46a479",
  "foreground-strong": "#eef0f2",
  "font-family": "Geist, ui-sans-serif, system-ui, sans-serif",
};

type KitPackage = typeof import("@creit.tech/stellar-wallets-kit");
type KitWrapper = typeof import("@/lib/wallet/kit");

// kit.ts initializes the kit once per module instance, so every test loads a
// fresh copy of both the wrapper and the kit's state
async function freshKit(): Promise<{ swk: KitPackage; kit: KitWrapper }> {
  vi.resetModules();
  const swk = await import("@creit.tech/stellar-wallets-kit");
  const kit = await import("@/lib/wallet/kit");
  return { swk, kit };
}

function setPageTheme(value: string | null): void {
  if (value === null) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
}

beforeEach(() => {
  setPageTheme(null);
  vi.restoreAllMocks();
});

describe("wallet picker theme follows the page theme (L-78)", () => {
  it("creates the kit with the light palette on a light page", async () => {
    setPageTheme("light");
    const { swk, kit } = await freshKit();
    kit.getKit(TESTNET);
    expect(swk.theme.value).toMatchObject(LIGHT);
  });

  it("creates the kit with the dark palette on a dark page", async () => {
    setPageTheme("dark");
    const { swk, kit } = await freshKit();
    kit.getKit(TESTNET);
    expect(swk.theme.value).toMatchObject(DARK);
  });

  // layout.tsx renders dark unless the page is explicitly light
  it("creates the kit with the dark palette when the page sets no theme", async () => {
    const { swk, kit } = await freshKit();
    kit.getKit(TESTNET);
    expect(swk.theme.value).toMatchObject(DARK);
  });

  it("applyKitTheme picks up a theme switch made after the kit was created", async () => {
    setPageTheme("dark");
    const { swk, kit } = await freshKit();
    kit.getKit(TESTNET);
    expect(swk.theme.value).toMatchObject(DARK);

    setPageTheme("light");
    kit.applyKitTheme();
    expect(swk.theme.value).toMatchObject(LIGHT);

    setPageTheme("dark");
    kit.applyKitTheme();
    expect(swk.theme.value).toMatchObject(DARK);
  });

  it("opens the picker in the theme the page has when connect is pressed", async () => {
    setPageTheme("dark");
    const { swk } = await freshKit();
    const { WalletKitConnector } = await import("@/lib/wallet/connector");
    const connector = new WalletKitConnector(TESTNET);
    expect(swk.theme.value).toMatchObject(DARK);

    // the modal itself is a web component that does not render under vitest;
    // what matters is the theme in effect at the moment it is asked to open
    const address = Keypair.random().publicKey();
    let themeAtOpen: unknown = null;
    vi.spyOn(swk.StellarWalletsKit, "authModal").mockImplementation(async () => {
      themeAtOpen = { ...swk.theme.value };
      return { address };
    });

    setPageTheme("light");
    await expect(connector.connect()).resolves.toEqual({ publicKey: address });
    expect(themeAtOpen).toMatchObject(LIGHT);
  });
});
