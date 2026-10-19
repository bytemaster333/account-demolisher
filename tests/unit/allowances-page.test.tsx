// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    // the page reads the scan result; the cases are written as the list or the
    // partial-scan error enumerateAllowances gives for the same scan
    scanAllowances: async (...args: unknown[]) => {
      try {
        const records = (await scan.enumerate(...args)) as unknown[];
        return {
          records,
          incomplete: null,
          overflow: [],
          partnerThroughLedger: null,
          partnerError: null,
        };
      } catch (e) {
        if (
          e instanceof real.AllowanceScanIncompleteError ||
          e instanceof real.AllowanceScanOverflowError
        ) {
          return {
            records: e.partial,
            incomplete: e.incomplete,
            overflow: e.overflow,
            partnerThroughLedger: null,
            partnerError: null,
          };
        }
        throw e;
      }
    },
    confirmAllowancesOnChain: (...args: unknown[]) => scan.confirm(...args),
  };
});
vi.mock("@/lib/soroban/rpc-client", () => ({
  getRpc: () => ({ getLatestLedger: async () => ({ sequence: 100 }) }),
}));
const sep41Source = vi.fn();
vi.mock("@/lib/soroban/sep41", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soroban/sep41")>()),
  symbol: async (_rpc: unknown, _id: string, source: string) => {
    sep41Source(source);
    return "TKN";
  },
  decimals: async () => 7,
}));
vi.mock("@/lib/soroban/revoke", () => ({
  prepareRevokes: async (_n: unknown, _c: unknown, list: readonly { spender: string }[]) => ({
    prepared: list.map((record) => ({ record, fee: { totalFee: 115_929n } })),
    failed: [],
  }),
  submitPreparedRevoke: async () => "hash",
  confirmRevoke: async () => undefined,
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/wallet/connector", () => ({
  WalletKitConnector: class {},
}));
const beacon = { visits: [] as unknown[][] };
vi.mock("@/lib/metrics/beacon", () => ({
  trackVisit: (...args: unknown[]) => beacon.visits.push(args),
}));

import AllowancesPage from "@/app/allowances/page";
import {
  AllowanceScanIncompleteError,
  AllowanceScanOverflowError,
  type AllowanceRecord,
} from "@/lib/soroban/allowances";
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
    await settle();
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

describe("/allowances partial scan", () => {
  it("lists what the scan found and says which part of history it missed", async () => {
    scan.enumerate.mockRejectedValue(
      new AllowanceScanIncompleteError([rec("GSPENDA")], {
        reason: "budget",
        coveredFromLedger: 90,
        rangeStartLedger: 1,
        lastLedger: 100,
        detail: "budget",
      }),
    );
    render(<AllowancesPage />);
    await scanAddress(G_OWNER);

    expect(screen.getAllByTestId("allowance-row")).toHaveLength(1);
    const notice = screen.getByTestId("allowance-scan-incomplete").textContent ?? "";
    expect(notice).toMatch(/ran out of time/);
    expect(notice).toMatch(/may be missing/);
    expect(screen.queryByText(/allowance scan incomplete \(budget\)/)).toBeNull();
  });

  it("still reports a scan that found nothing in the part it covered as incomplete", async () => {
    scan.enumerate.mockRejectedValue(
      new AllowanceScanIncompleteError([], {
        reason: "rpc-error",
        coveredFromLedger: 101,
        rangeStartLedger: 1,
        lastLedger: 100,
        detail: "503",
      }),
    );
    render(<AllowancesPage />);
    await scanAddress(G_OWNER);
    expect(screen.getByTestId("allowance-scan-incomplete").textContent).toMatch(/503/);
    expect(screen.queryByText("No active allowances found")).toBeNull();
  });
});

describe("/allowances capped token contract", () => {
  const CUT = { contractId: "CHOSTILE", spenders: 21, kept: 20 };

  it("lists the kept rows and says which contract was cut", async () => {
    scan.enumerate.mockRejectedValue(
      new AllowanceScanOverflowError([rec("GSPENDA"), rec("GSPENDB")], [CUT]),
    );
    render(<AllowancesPage />);
    await scanAddress(G_OWNER);

    expect(screen.getAllByTestId("allowance-row")).toHaveLength(2);
    expect(screen.queryByTestId("allowance-scan-incomplete")).toBeNull();
    const notice = screen.getByTestId("allowance-scan-overflow").textContent ?? "";
    expect(notice).toMatch(/CHOSTILE/);
    expect(notice).toMatch(/21 different spenders/);
    expect(screen.queryByText(/Failed to load allowances/)).toBeNull();
  });

  it("reports both the missed history and the cut contract on a partial scan", async () => {
    scan.enumerate.mockRejectedValue(
      new AllowanceScanIncompleteError(
        [rec("GSPENDA")],
        {
          reason: "budget",
          coveredFromLedger: 90,
          rangeStartLedger: 1,
          lastLedger: 100,
          detail: "budget",
        },
        [CUT],
      ),
    );
    render(<AllowancesPage />);
    await scanAddress(G_OWNER);

    expect(screen.getAllByTestId("allowance-row")).toHaveLength(1);
    expect(screen.getByTestId("allowance-scan-incomplete").textContent).toMatch(/ran out of time/);
    expect(screen.getByTestId("allowance-scan-overflow").textContent).toMatch(/CHOSTILE/);
  });

  it("drops the cut notice when a new scan comes back clean", async () => {
    scan.enumerate.mockRejectedValueOnce(new AllowanceScanOverflowError([rec("GSPENDA")], [CUT]));
    render(<AllowancesPage />);
    await scanAddress(G_OWNER);
    expect(screen.getByTestId("allowance-scan-overflow")).toBeTruthy();

    await scanAddress(G_OWNER);
    expect(screen.queryByTestId("allowance-scan-overflow")).toBeNull();
  });
});

describe("/allowances visit metric", () => {
  it("sends one allowances visit on mount", () => {
    beacon.visits = [];
    render(<AllowancesPage />);
    expect(beacon.visits).toEqual([["allowances"]]);
  });
});

describe("/allowances scanning card (L-82)", () => {
  // a live region announces every change, and the quip under the title changes
  // every 1.6s, so only the fixed title may be one
  const LIVE_ROLES = new Set(["status", "alert", "log", "marquee", "timer"]);
  const isLive = (el: Element): boolean =>
    el.hasAttribute("aria-live") || LIVE_ROLES.has(el.getAttribute("role") ?? "");

  it("keeps the rotating quip out of every live region and announces only the title", async () => {
    scan.enumerate.mockImplementation(() => new Promise<never>(() => {}));
    render(<AllowancesPage />);
    await scanAddress(G_OWNER);

    const card = screen.getByTestId("allowance-scanning");
    const quip = within(card).getByText("Reading approve events…");
    for (let el: Element | null = quip; el !== null; el = el.parentElement) {
      expect(isLive(el), `live region around the quip: ${el.outerHTML.slice(0, 80)}`).toBe(false);
    }
    const live = [card, ...card.querySelectorAll("*")].filter(isLive);
    expect(live).toHaveLength(1);
    expect(live[0]!.getAttribute("role")).toBe("status");
    expect(live[0]!.textContent).toBe("Looking up allowances on-chain…");
  });
});
