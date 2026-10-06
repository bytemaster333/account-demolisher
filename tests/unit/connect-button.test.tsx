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
import { resolveNetwork } from "@/lib/config/networks";

afterEach(cleanup);

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
    render(<ConnectButton network={resolveNetwork("testnet")} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("connect-button"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the wallet's reason when connecting fails", async () => {
    connectResult.reject = { code: -3, message: "User declined access" };
    render(<ConnectButton network={resolveNetwork("testnet")} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("connect-button"));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/User declined access/);
  });
});
