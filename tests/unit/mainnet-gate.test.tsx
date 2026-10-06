// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the header restores and tears down wallet-kit sessions; the kit is a browser
// extension bridge that doesn't load under happy-dom
vi.mock("@/lib/wallet/kit", () => ({
  restoreKitSession: async () => null,
  disconnectKit: async () => {},
}));
vi.mock("@/lib/wallet/connector", () => ({ WalletKitConnector: class {} }));

// a page load starts with fresh modules; the acknowledgement made during one
// load must not leak into the next test
let AppShell: typeof import("@/components/layout/AppShell").AppShell;
let ThemeProvider: typeof import("@/components/layout/ThemeProvider").ThemeProvider;
let useNetworkStore: typeof import("@/stores/network").useNetworkStore;

const ACK_KEY = "demolisher.mainnetAck";
const NETWORK_KEY = "demolisher.network";

function renderShell() {
  render(
    <ThemeProvider>
      <AppShell>
        <div />
      </AppShell>
    </ThemeProvider>,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  window.localStorage.clear();
  vi.resetModules();
  ({ AppShell } = await import("@/components/layout/AppShell"));
  ({ ThemeProvider } = await import("@/components/layout/ThemeProvider"));
  ({ useNetworkStore } = await import("@/stores/network"));
});

afterEach(() => {
  cleanup();
});

describe("mainnet acknowledgement on load", () => {
  it("asks on first load when the build defaults to mainnet", async () => {
    useNetworkStore.setState({ networkId: "mainnet" });
    renderShell();
    await settle();
    expect(screen.getByTestId("mainnet-confirm")).toBeTruthy();
    expect(screen.getByTestId("mainnet-audit-notice")).toBeTruthy();
  });

  it("asks when mainnet is restored from storage without an acknowledgement", async () => {
    window.localStorage.setItem(NETWORK_KEY, "mainnet");
    renderShell();
    await settle();
    expect(useNetworkStore.getState().networkId).toBe("mainnet");
    expect(screen.getByTestId("mainnet-confirm")).toBeTruthy();
  });

  it("does not ask again once acknowledged", async () => {
    window.localStorage.setItem(ACK_KEY, "1");
    useNetworkStore.setState({ networkId: "mainnet" });
    renderShell();
    await settle();
    expect(screen.queryByTestId("mainnet-confirm")).toBeNull();
  });

  it("records the acknowledgement on confirm", async () => {
    useNetworkStore.setState({ networkId: "mainnet" });
    renderShell();
    await settle();
    fireEvent.click(screen.getByTestId("mainnet-audit-ack"));
    fireEvent.click(screen.getByTestId("mainnet-confirm-confirm"));
    await settle();
    expect(screen.queryByTestId("mainnet-confirm")).toBeNull();
    expect(window.localStorage.getItem(ACK_KEY)).toBe("1");
    expect(useNetworkStore.getState().networkId).toBe("mainnet");
  });

  it("moves to testnet when the user declines", async () => {
    useNetworkStore.setState({ networkId: "mainnet" });
    renderShell();
    await settle();
    fireEvent.click(screen.getByTestId("mainnet-confirm-cancel"));
    await settle();
    expect(useNetworkStore.getState().networkId).toBe("testnet");
    expect(window.localStorage.getItem(ACK_KEY)).toBeNull();
  });

  it("never asks on testnet", async () => {
    renderShell();
    await settle();
    expect(screen.queryByTestId("mainnet-confirm")).toBeNull();
  });
});
