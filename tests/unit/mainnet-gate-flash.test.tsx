// @vitest-environment happy-dom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/wallet/kit", () => ({
  restoreKitSession: async () => null,
  disconnectKit: async () => {},
}));
vi.mock("@/lib/wallet/connector", () => ({ WalletKitConnector: class {} }));

// the dialog focuses itself and remembers what had focus when it mounts, so
// even a dialog that is gone a moment later has side effects; count mounts
const dialog = { mounts: 0 };
vi.mock("@/components/layout/MainnetConfirm", () => ({
  MainnetConfirm: () => {
    dialog.mounts += 1;
    return <div data-testid="mainnet-confirm" />;
  },
}));

import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { useNetworkStore } from "@/stores/network";

beforeEach(() => {
  window.localStorage.clear();
  dialog.mounts = 0;
});

afterEach(cleanup);

describe("mainnet acknowledgement with a stored testnet choice", () => {
  it("never shows the dialog when the build defaults to mainnet but this browser chose testnet", async () => {
    window.localStorage.setItem("demolisher.network", "testnet");
    useNetworkStore.setState({ networkId: "mainnet" });
    render(
      <ThemeProvider>
        <AppShell>
          <div />
        </AppShell>
      </ThemeProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useNetworkStore.getState().networkId).toBe("testnet");
    expect(dialog.mounts).toBe(0);
  });

  it("still asks when the stored choice is mainnet", async () => {
    window.localStorage.setItem("demolisher.network", "mainnet");
    useNetworkStore.setState({ networkId: "testnet" });
    render(
      <ThemeProvider>
        <AppShell>
          <div />
        </AppShell>
      </ThemeProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(dialog.mounts).toBeGreaterThan(0);
  });
});
