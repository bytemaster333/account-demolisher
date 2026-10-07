// @vitest-environment happy-dom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// token metadata comes from soroban simulations; the fake records which source
// account each read was simulated with and rejects a non-G source the way
// simulateRead's new Account(source, "0") does
const sep41 = {
  symbol: vi.fn(),
  decimals: vi.fn(),
};
vi.mock("@/lib/soroban/sep41", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soroban/sep41")>()),
  symbol: (...args: unknown[]) => sep41.symbol(...args),
  decimals: (...args: unknown[]) => sep41.decimals(...args),
}));
// one server object per test, as getRpc caches one per network; token metadata
// is cached per server, so a fresh one keeps each test's reads its own
let rpcServer: object = {};
vi.mock("@/lib/soroban/rpc-client", () => ({ getRpc: () => rpcServer }));

import { AllowanceList } from "@/components/allowance-viewer/AllowanceList";
import { TESTNET } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";

const network = TESTNET;
const C_OWNER = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const G_WALLET = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function rec(spender: string, extra: Partial<AllowanceRecord> = {}): AllowanceRecord {
  return {
    contractId: `CTOKEN${spender}`,
    spender,
    amount: 10_000_000n,
    live_until_ledger: 1_000,
    lastSeenLedger: 1,
    expired: false,
    ...extra,
  };
}

function renderList(
  records: readonly AllowanceRecord[],
  simulationSource: string | null,
  showExpired = false,
) {
  render(
    <AllowanceList
      records={records}
      userAddress={C_OWNER}
      simulationSource={simulationSource}
      network={network}
      currentLedger={10}
      connectorRef={null}
      showExpired={showExpired}
    />,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  rpcServer = {};
  sep41.symbol.mockReset();
  sep41.decimals.mockReset();
  const check = (source: string) => {
    if (!source.startsWith("G")) throw new Error("accountId is invalid");
  };
  sep41.symbol.mockImplementation(async (_rpc, _id, source: string) => {
    check(source);
    return "USDC";
  });
  sep41.decimals.mockImplementation(async (_rpc, _id, source: string) => {
    check(source);
    return 7;
  });
});

afterEach(cleanup);

describe("AllowanceList token metadata for a C-address scan", () => {
  it("simulates with the G source, not the scanned contract", async () => {
    renderList([rec("GSPEND1")], G_WALLET);
    await settle();
    expect(sep41.symbol.mock.calls[0]![2]).toBe(G_WALLET);
    expect(sep41.decimals.mock.calls[0]![2]).toBe(G_WALLET);
    expect(screen.getByTestId("row-token-symbol").textContent).toBe("USDC");
    expect(screen.getByTestId("row-amount").textContent).toContain("1");
    expect(screen.getByTestId("row-amount").textContent).not.toContain("10,000,000");
  });

  it("asks for a wallet instead of failing when there is no G source", async () => {
    renderList([rec("GSPEND1")], null);
    await settle();
    expect(sep41.symbol).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("row-token-hint").textContent).toMatch(/Connect a wallet/);
    expect(screen.getByTestId("row-amount").textContent).toMatch(/base units/);
  });
});

describe("AllowanceList on-chain confirmation", () => {
  it("does not count an approval the token reports as zero", async () => {
    renderList(
      [
        rec("GSPEND1", { onChainAmount: 0n }),
        rec("GSPEND2", { onChainAmount: null }),
        rec("GSPEND3"),
        rec("GSPEND4", { onChainAmount: 20_000_000n }),
      ],
      G_WALLET,
    );
    await settle();
    expect(screen.getByText(/3 active approvals/)).toBeTruthy();
    expect(screen.getAllByTestId("allowance-row")).toHaveLength(3);
  });

  it("marks rows whose amount was not confirmed on chain", async () => {
    renderList(
      [
        rec("GSPEND2", { onChainAmount: null }),
        rec("GSPEND3"),
        rec("GSPEND4", { onChainAmount: 5n }),
      ],
      G_WALLET,
    );
    await settle();
    const rows = screen.getAllByTestId("allowance-row");
    expect(within(rows[0]!).queryByTestId("row-unconfirmed")).not.toBeNull();
    expect(within(rows[1]!).queryByTestId("row-unconfirmed")).not.toBeNull();
    expect(within(rows[2]!).queryByTestId("row-unconfirmed")).toBeNull();
  });

  it("shows the on-chain value as the spend limit and the event value as the note", async () => {
    renderList([rec("GSPEND4", { amount: 10_000_000n, onChainAmount: 20_000_000n })], G_WALLET);
    await settle();
    const primary = screen.getByTestId("row-amount-primary").textContent ?? "";
    expect(primary).toContain("2");
    expect(primary).not.toContain("1");
    expect(screen.getByTestId("row-amount-mismatch").textContent).toMatch(/events: 1/);
  });
});

describe("AllowanceList metadata reads", () => {
  it("reads a token's metadata once however many rows show it", async () => {
    const shared = "CSHAREDTOKEN";
    renderList(
      Array.from({ length: 12 }, (_, i) => rec(`GSPEND${i}`, { contractId: shared })),
      G_WALLET,
    );
    await settle();
    await settle();
    expect(sep41.symbol).toHaveBeenCalledTimes(1);
    expect(sep41.decimals).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("row-token-symbol").map((e) => e.textContent)).toEqual(
      Array(12).fill("USDC"),
    );
  });

  it("drops the read of a row that unmounts and shows no error for it", async () => {
    let release!: () => void;
    sep41.symbol.mockImplementation(
      () => new Promise<string>((resolve) => (release = () => resolve("USDC"))),
    );
    renderList([rec("GSPEND1")], G_WALLET);
    await settle();
    cleanup();
    release();
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AllowanceList amount formatting", () => {
  it("shows raw units, without hanging or throwing, for decimals a token can't need", async () => {
    sep41.decimals.mockResolvedValue(4_294_967_295);
    renderList([rec("GSPEND1", { amount: 12_345n, onChainAmount: 12_345n })], G_WALLET);
    await settle();
    expect(screen.getByTestId("row-amount-primary").textContent).toBe("12,345");
  });

  it("shows raw units for 39 decimals", async () => {
    sep41.decimals.mockResolvedValue(39);
    renderList([rec("GSPEND1", { amount: 7n, onChainAmount: 7n })], G_WALLET);
    await settle();
    expect(screen.getByTestId("row-amount-primary").textContent).toBe("7");
  });

  it("trims trailing zeros of the fraction", async () => {
    renderList([rec("GSPEND1", { amount: 12_500_000n, onChainAmount: 12_500_000n })], G_WALLET);
    await settle();
    expect(screen.getByTestId("row-amount-primary").textContent).toBe("1.25");
  });
});

describe("AllowanceList token symbols", () => {
  it("badges a symbol with non-ASCII letters", async () => {
    sep41.symbol.mockResolvedValue("USDС");
    renderList([rec("GSPEND1")], G_WALLET);
    await settle();
    expect(screen.getByTestId("row-token-nonascii")).toBeTruthy();
  });

  it("does not badge a plain ASCII symbol", async () => {
    renderList([rec("GSPEND1")], G_WALLET);
    await settle();
    expect(screen.getByTestId("row-token-symbol").textContent).toBe("USDC");
    expect(screen.queryByTestId("row-token-nonascii")).toBeNull();
  });
});
