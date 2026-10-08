// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// the wallet kit is a browser extension bridge; the fake connector rejects with
// the exact shapes the kit uses (sdk/kit.js authModal close and
// modules/wallet-connect.module.js network check, via utils parseError)
const connectResult = { reject: null as unknown };
vi.mock("@/lib/wallet/connector", () => ({
  WalletKitConnector: class {
    connect(): Promise<{ publicKey: string }> {
      return Promise.reject(connectResult.reject);
    }
  },
}));

import { describeConnectError } from "@/components/wallet/connect-error";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { TESTNET } from "@/lib/config/networks";
import { setActiveConnector } from "@/lib/wallet/active-connector";
import type { Connector } from "@/lib/wallet/connector";
import { useWalletStore } from "@/stores/wallet";

const G = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

afterEach(() => {
  cleanup();
  setActiveConnector(null);
  useWalletStore.setState({ publicKey: null, connectorKind: null });
});

describe("describeConnectError", () => {
  it("treats closing the wallet picker as a silent cancel", () => {
    expect(describeConnectError({ code: -1, message: "The user closed the modal." })).toBeNull();
  });

  it("keeps the wallet's own reason, which shares the generic -1 code", () => {
    const msg = describeConnectError({
      code: -1,
      message: "Network Test SDF Future Network ; October 2022 is not supported by WalletConnect.",
    });
    expect(msg).toMatch(/not supported by WalletConnect/);
  });

  it("keeps an Error's message and adds the install hint", () => {
    const msg = describeConnectError(new Error("Ledger device: app not open"));
    expect(msg).toMatch(/Ledger device: app not open/);
    expect(msg).toMatch(/installed and unlocked/);
  });
});

describe("ConnectButton", () => {
  it("shows nothing when the user closes the picker", async () => {
    connectResult.reject = { code: -1, message: "The user closed the modal." };
    render(<ConnectButton network={TESTNET} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("connect-button"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the wallet's reason when connecting fails", async () => {
    connectResult.reject = { code: -3, message: "User declined access" };
    render(<ConnectButton network={TESTNET} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("connect-button"));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/User declined access/);
  });
});

describe("ConnectButton disconnect", () => {
  // a kit connector whose teardown fails, the way an unreachable walletconnect
  // relay does; disconnectSession then reports it instead of the console
  function failingKit(error: unknown): Connector {
    return {
      kind: "kit",
      connect: async () => ({ publicKey: G }),
      disconnect: async () => {
        throw error;
      },
      getPublicKey: async () => G,
      signTransaction: async () => {
        throw new Error("not used");
      },
    };
  }

  it("disconnects the app and says the wallet may still be connected when the teardown fails", async () => {
    setActiveConnector(
      failingKit(new Error("WalletConnect could not reach its relay. Check your connection")),
    );
    useWalletStore.setState({ publicKey: G, connectorKind: "kit" });
    render(<ConnectButton network={TESTNET} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("connect-button"));
    });
    expect(useWalletStore.getState().publicKey).toBeNull();
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/could not be fully disconnected/);
    expect(alert).toMatch(/could not reach its relay\. Check your connection\./);
  });

  it("shows nothing when the teardown works", async () => {
    setActiveConnector({ ...failingKit(null), disconnect: async () => {} });
    useWalletStore.setState({ publicKey: G, connectorKind: "kit" });
    render(<ConnectButton network={TESTNET} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("connect-button"));
    });
    expect(useWalletStore.getState().publicKey).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // disconnectSession clears the store before it waits on the wallet, so the
  // button already reads as not connected while a slow walletconnect relay
  // is still being closed
  it("says disconnecting, not connecting, while the wallet teardown is still running", async () => {
    let finish: () => void = () => {};
    const teardown = new Promise<void>((resolve) => {
      finish = resolve;
    });
    setActiveConnector({ ...failingKit(null), disconnect: () => teardown });
    useWalletStore.setState({ publicKey: G, connectorKind: "kit" });
    render(<ConnectButton network={TESTNET} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("connect-button"));
    });
    const button = screen.getByTestId("connect-button");
    expect(useWalletStore.getState().publicKey).toBeNull();
    expect(button.textContent).toBe("Disconnecting…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      finish();
      await teardown;
    });
    expect(button.textContent).toBe("Connect wallet");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
