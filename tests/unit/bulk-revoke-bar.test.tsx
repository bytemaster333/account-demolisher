// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the revoke module so no real tx is built/signed/submitted. submitRevoke
// is a controllable deferred so we can hold the loop mid-flight, unmount, then
// release it and assert the sweep does not keep submitting.
const submitRevoke = vi.fn();
const confirmRevoke = vi.fn();
vi.mock("@/lib/soroban/revoke", () => ({
  submitRevoke: (...args: unknown[]) => submitRevoke(...args),
  confirmRevoke: (...args: unknown[]) => confirmRevoke(...args),
}));

import { BulkRevokeBar } from "@/components/allowance-viewer/BulkRevokeBar";
import type { NetworkConfig } from "@/lib/config/networks";
import { resolveNetwork } from "@/lib/config/networks";
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

// a deferred that stays pending until we call resolve() — lets a submit hang.
function deferred(): { promise: Promise<string>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<string>((res) => {
    resolve = () => res("hash");
  });
  return { promise, resolve };
}

const network: NetworkConfig = resolveNetwork("testnet");
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
