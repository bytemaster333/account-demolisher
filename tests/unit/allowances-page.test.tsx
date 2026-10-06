// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// rpc reads, simulations and revoke transactions are network boundaries; the
// fakes record what the page asked for
const scan = {
  enumerate: vi.fn(),
  confirm: vi.fn(),
};
vi.mock("@/lib/soroban/allowances", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/soroban/allowances")>();
  return {
    ...real,
    enumerateAllowances: (...args: unknown[]) => scan.enumerate(...args),
    confirmAllowancesOnChain: (...args: unknown[]) => scan.confirm(...args),
  };
});
vi.mock("@/lib/soroban/rpc-client", () => ({
  getRpc: () => ({ getLatestLedger: async () => ({ sequence: 100 }) }),
}));
const sep41Source = vi.fn();
vi.mock("@/lib/soroban/sep41", () => ({
  symbol: async (_rpc: unknown, _id: string, source: string) => {
    sep41Source(source);
    return "TKN";
  },
  decimals: async () => 7,
}));
vi.mock("@/lib/soroban/revoke", () => ({
  submitRevoke: async () => "hash",
  confirmRevoke: async () => undefined,
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/wallet/connector", () => ({
  WalletKitConnector: class {},
}));

import AllowancesPage from "@/app/allowances/page";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import { setActiveConnector } from "@/lib/wallet/active-connector";
import type { Connector } from "@/lib/wallet/connector";
import { useNetworkStore } from "@/stores/network";
import { useWalletStore } from "@/stores/wallet";

const G_OWNER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const G_OTHER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const C_TARGET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function rec(spender: string): AllowanceRecord {
  return {
    contractId: `CTOKEN${spender}`,
    spender,
    amount: 5n,
    live_until_ledger: 1_000,
    lastSeenLedger: 1,
    expired: false,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function scanAddress(addr: string): Promise<void> {
  fireEvent.change(screen.getByTestId("address-input"), { target: { value: addr } });
  await act(async () => {
    fireEvent.click(screen.getByTestId("load-allowances-button"));
  });
  await settle();
}

beforeEach(() => {
  scan.enumerate.mockReset();
  scan.confirm.mockReset();
  sep41Source.mockReset();
  scan.enumerate.mockResolvedValue([rec("GSPENDA"), rec("GSPENDB")]);
  scan.confirm.mockImplementation(async (_rpc, _owner, list: readonly AllowanceRecord[]) =>
    list.map((r) => ({ ...r, onChainAmount: r.amount })),
  );
  useNetworkStore.setState({ networkId: "testnet" });
  useWalletStore.setState({ publicKey: null, connectorKind: null });
  setActiveConnector(null);
});

afterEach(() => {
  cleanup();
  setActiveConnector(null);
});

describe("/allowances bulk refresh", () => {
  it("re-scans the swept address, not whatever is in the input box", async () => {
    setActiveConnector({} as Connector);
    useWalletStore.setState({ publicKey: G_OWNER, connectorKind: "secret" });
    render(<AllowancesPage />);
    await scanAddress(G_OWNER);

    await act(async () => {
      fireEvent.click(screen.getByTestId("bulk-revoke-all"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("bulk-revoke-confirm-go"));
    });
    await settle();
    expect(screen.getByTestId("bulk-revoke-done")).toBeTruthy();

    fireEvent.change(screen.getByTestId("address-input"), { target: { value: G_OTHER } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("bulk-revoke-refresh"));
    });
    await settle();
    const lastTarget = scan.enumerate.mock.calls.at(-1)![1];
    expect(lastTarget).toBe(G_OWNER);
  });
});

describe("/allowances C-address scan", () => {
  it("loads token details with the connected wallet as the simulation source", async () => {
    useWalletStore.setState({ publicKey: G_OTHER, connectorKind: "kit" });
    render(<AllowancesPage />);
    await scanAddress(C_TARGET);
    expect(sep41Source).toHaveBeenCalled();
    expect(sep41Source.mock.calls.every(([s]) => s === G_OTHER)).toBe(true);
  });

  it("links the viewed contract address to the contract explorer page", async () => {
    useWalletStore.setState({ publicKey: G_OTHER, connectorKind: "kit" });
    render(<AllowancesPage />);
    await scanAddress(C_TARGET);
    const link = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href")?.endsWith(C_TARGET));
    expect(link?.getAttribute("href")).toContain(`/contract/${C_TARGET}`);
  });

  it("asks for a wallet instead of simulating with the contract address", async () => {
    render(<AllowancesPage />);
    await scanAddress(C_TARGET);
    expect(sep41Source).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("row-token-hint").length).toBeGreaterThan(0);
  });
});
