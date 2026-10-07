// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the wallet kit is a browser extension bridge that doesn't load under happy-dom;
// the fake records whether the header tore the session down
const kit = { disconnects: 0 };
vi.mock("@/lib/wallet/kit", () => ({
  restoreKitSession: async () => null,
  disconnectKit: async () => {
    kit.disconnects += 1;
  },
}));
vi.mock("@/lib/wallet/connector", () => ({ WalletKitConnector: class {} }));

import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { useCloseBusy } from "@/stores/close-busy";
import { useNetworkStore } from "@/stores/network";
import { useWalletStore } from "@/stores/wallet";

const G = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const LOCK = "A close is running on this network.";

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

function link(name: string): HTMLElement {
  return screen.getAllByRole("link").find((a) => a.textContent === name)!;
}

beforeEach(() => {
  // happy-dom has no confirm(); a browser's is a blocking dialog, so a stub
  // that the tests spy on stands in for the user's answer
  if (typeof window.confirm !== "function") window.confirm = () => true;
  window.localStorage.clear();
  kit.disconnects = 0;
  useCloseBusy.setState({ busy: false });
  useNetworkStore.setState({ networkId: "testnet", lockReason: null });
  useWalletStore.setState({ publicKey: null, connectorKind: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppShell while a close runs", () => {
  it("asks before a header link leaves the page, and stays when declined", async () => {
    useCloseBusy.setState({ busy: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderShell();
    await settle();
    const navigated = fireEvent.click(link("Allowances"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatch(/close is running/);
    expect(navigated).toBe(false);
  });

  it("guards the logo and the footer links too", async () => {
    useCloseBusy.setState({ busy: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderShell();
    await settle();
    expect(fireEvent.click(screen.getByRole("link", { name: "Home" }))).toBe(false);
    expect(fireEvent.click(link("Close an account"))).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("lets a link through without asking when no close is running", async () => {
    const confirm = vi.spyOn(window, "confirm");
    renderShell();
    await settle();
    fireEvent.click(link("Allowances"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("locks the network switcher with the reason", async () => {
    useNetworkStore.setState({ lockReason: LOCK });
    renderShell();
    await settle();
    const trigger = screen.getByRole("button", { name: /Select network/ });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("title")).toBe(LOCK);
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(useNetworkStore.getState().networkId).toBe("testnet");
  });

  it("closes an open network menu when a close takes the lock", async () => {
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Select network/ }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    act(() => useNetworkStore.setState({ lockReason: LOCK }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the wallet connected when Disconnect is pressed while locked", async () => {
    useNetworkStore.setState({ lockReason: LOCK });
    useWalletStore.setState({ publicKey: G, connectorKind: "kit" });
    renderShell();
    await settle();
    fireEvent.click(screen.getByTestId("wallet-menu-trigger"));
    const item = screen.getByTestId("wallet-disconnect") as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain(LOCK);
    fireEvent.click(item);
    await settle();
    expect(useWalletStore.getState().publicKey).toBe(G);
    expect(kit.disconnects).toBe(0);
  });

  it("disconnects normally when nothing holds the lock", async () => {
    useWalletStore.setState({ publicKey: G, connectorKind: "kit" });
    renderShell();
    await settle();
    fireEvent.click(screen.getByTestId("wallet-menu-trigger"));
    fireEvent.click(screen.getByTestId("wallet-disconnect"));
    await settle();
    expect(useWalletStore.getState().publicKey).toBeNull();
  });
});
