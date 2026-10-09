// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the revoke module so no real tx is built/signed/submitted. submitRevoke
// (submitPreparedRevoke) is a controllable deferred so we can hold the loop
// mid-flight, unmount, then release it and assert the sweep does not keep
// submitting. the real build and fee path is covered in revoke-fee-review.test.tsx
const submitRevoke = vi.fn();
const confirmRevoke = vi.fn();
const prepareRevokes = vi.fn(
  async (_network: unknown, _connector: unknown, list: readonly AllowanceRecord[]) => ({
    prepared: list.map((record) => ({ record, fee: { totalFee: 115_929n } })),
    failed: [],
  }),
);
vi.mock("@/lib/soroban/revoke", () => ({
  prepareRevokes: (...args: Parameters<typeof prepareRevokes>) => prepareRevokes(...args),
  submitPreparedRevoke: (...args: unknown[]) => submitRevoke(...args),
  confirmRevoke: (...args: unknown[]) => confirmRevoke(...args),
}));

import { BulkRevokeBar } from "@/components/allowance-viewer/BulkRevokeBar";
import { TESTNET, type NetworkConfig } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { Connector } from "@/lib/wallet/connector";
import { useNetworkStore } from "@/stores/network";

function makeRecord(spender: string): AllowanceRecord {
  return {
    contractId: `C${spender}`,
    spender,
    amount: 1000n,
    live_until_ledger: 10_000_000,
    lastSeenLedger: 1,
    expired: false,
  };
}

// three active, non-curated approvals -> bar renders and "Revoke all" is enabled
const records: readonly AllowanceRecord[] = [
  makeRecord("GAAA1111111111111111111111111111111111111111111111111AAAA"),
  makeRecord("GBBB2222222222222222222222222222222222222222222222222BBBB"),
  makeRecord("GCCC3333333333333333333333333333333333333333333333333CCCC"),
];

// a deferred that stays pending until we call resolve(), lets a submit hang.
function deferred(): { promise: Promise<string>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<string>((res) => {
    resolve = () => res("hash");
  });
  return { promise, resolve };
}

const network: NetworkConfig = TESTNET;
const connectorRef = { current: {} as Connector };

function renderBar() {
  return render(
    <BulkRevokeBar
      records={records}
      userAddress="GUSER"
      network={network}
      connectorRef={connectorRef}
      onComplete={() => {}}
    />,
  );
}

async function startSweep(): Promise<void> {
  await act(async () => {
    screen.getByTestId("bulk-revoke-all").click();
  });
  // the revokes are built and their fees read before the confirm dialog shows
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  // confirm dialog -> go
  await act(async () => {
    screen.getByTestId("bulk-revoke-confirm-go").click();
  });
}

describe("BulkRevokeBar unmount guard", () => {
  beforeEach(() => {
    submitRevoke.mockReset();
    confirmRevoke.mockReset();
    confirmRevoke.mockResolvedValue(undefined);
    // reset the network store to a known value between tests
    useNetworkStore.setState({ networkId: "testnet" });
  });

  afterEach(() => {
    cleanup();
  });

  it("stops submitting once the component unmounts mid-sweep", async () => {
    const first = deferred();
    // first submit hangs; if a second submit ever fires the test would resolve it
    // too, but we assert it is never called.
    submitRevoke.mockReturnValueOnce(first.promise);
    submitRevoke.mockResolvedValue("hash2");

    const { unmount } = renderBar();
    await startSweep();

    // the loop kicked off exactly one submit and is now awaiting it
    expect(submitRevoke).toHaveBeenCalledTimes(1);

    // navigate away: unmount fires the cleanup that sets stopRef = true
    unmount();

    // release the in-flight submit; the loop resumes after the await
    await act(async () => {
      first.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // WITHOUT the unmount guard the loop would proceed to record #2 and call
    // submitRevoke again. With the guard it halts at the next iteration check.
    expect(submitRevoke).toHaveBeenCalledTimes(1);
  });

  it("stops the sweep when the network is switched mid-flight", async () => {
    const first = deferred();
    submitRevoke.mockReturnValueOnce(first.promise);
    submitRevoke.mockResolvedValue("hash2");

    renderBar();
    await startSweep();

    expect(submitRevoke).toHaveBeenCalledTimes(1);

    // switch network mid-sweep -> effect sets stopRef = true
    await act(async () => {
      useNetworkStore.setState({ networkId: "mainnet" });
    });

    await act(async () => {
      first.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // the loop must not have advanced to the second record
    expect(submitRevoke).toHaveBeenCalledTimes(1);
  });
});

describe("BulkRevokeBar wallet disconnect", () => {
  beforeEach(() => {
    submitRevoke.mockReset();
    confirmRevoke.mockReset();
    confirmRevoke.mockResolvedValue(undefined);
    useNetworkStore.setState({ networkId: "testnet" });
  });

  afterEach(() => {
    cleanup();
  });

  it("stops at a disconnect, records it once and keeps showing the summary", async () => {
    const first = deferred();
    submitRevoke.mockReturnValueOnce(first.promise);
    submitRevoke.mockResolvedValue("hash2");
    const ref = { current: {} as Connector } as { current: Connector | null };

    const { rerender } = render(
      <BulkRevokeBar
        records={records}
        userAddress="GUSER"
        network={network}
        connectorRef={ref}
        onComplete={() => {}}
      />,
    );
    await startSweep();
    expect(submitRevoke).toHaveBeenCalledTimes(1);

    // the page drops the connector and stops passing a ref when the wallet disconnects
    ref.current = null;
    rerender(
      <BulkRevokeBar
        records={records}
        userAddress="GUSER"
        network={network}
        connectorRef={null}
        onComplete={() => {}}
      />,
    );
    // the running card must not vanish mid-sweep
    expect(screen.queryByTestId("bulk-revoke-running")).not.toBeNull();

    await act(async () => {
      first.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(submitRevoke).toHaveBeenCalledTimes(1);
    const done = screen.getByTestId("bulk-revoke-done");
    expect(done.textContent).toMatch(/Revoked 1 of 1/);
    expect(done.textContent?.match(/wallet disconnected/gi)?.length).toBe(1);
  });
});

describe("BulkRevokeBar active approvals", () => {
  afterEach(() => {
    cleanup();
  });

  it("leaves out approvals the token already reports as zero", () => {
    const zeroed: readonly AllowanceRecord[] = [
      {
        ...makeRecord("GAAA1111111111111111111111111111111111111111111111111AAAA"),
        onChainAmount: 0n,
      },
      makeRecord("GBBB2222222222222222222222222222222222222222222222222BBBB"),
      makeRecord("GCCC3333333333333333333333333333333333333333333333333CCCC"),
    ];
    render(
      <BulkRevokeBar
        records={zeroed}
        userAddress="GUSER"
        network={network}
        connectorRef={connectorRef}
        onComplete={() => {}}
      />,
    );
    expect(screen.getByTestId("bulk-revoke-all").textContent).toBe("Revoke all 2");
  });
});

describe("BulkRevokeBar fee confirmation", () => {
  beforeEach(() => {
    submitRevoke.mockReset();
    confirmRevoke.mockReset();
    confirmRevoke.mockResolvedValue(undefined);
    prepareRevokes.mockClear();
    useNetworkStore.setState({ networkId: "testnet" });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the summed fee and submits nothing until the user confirms", async () => {
    renderBar();
    await act(async () => {
      screen.getByTestId("bulk-revoke-all").click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(prepareRevokes).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("bulk-revoke-fee-total").textContent).toBe(
      "Network fees: up to 0.0347787 XLM in total.",
    );
    expect(submitRevoke).not.toHaveBeenCalled();
    await act(async () => {
      screen.getByTestId("bulk-revoke-cancel").click();
    });
    expect(submitRevoke).not.toHaveBeenCalled();
  });

  it("rebuilds and asks again before retrying a revoke that failed", async () => {
    submitRevoke.mockRejectedValueOnce(new Error("The fee for this revoke rose"));
    submitRevoke.mockResolvedValue("hash");
    renderBar();
    await startSweep();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("bulk-revoke-done").textContent).toMatch(/Revoked 2 of 3/);
    await act(async () => {
      screen.getByTestId("bulk-revoke-retry").click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(prepareRevokes).toHaveBeenCalledTimes(2);
    expect(prepareRevokes.mock.calls[1]![2]).toEqual([records[0]]);
    expect(screen.getByTestId("bulk-revoke-fee-total").textContent).toMatch(/0\.0115929 XLM/);
    expect(submitRevoke).toHaveBeenCalledTimes(3);
  });
});
