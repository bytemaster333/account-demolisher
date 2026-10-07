// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the revoke primitives build, sign, submit and poll real transactions; here they
// are replaced so the button's own state handling can be driven step by step
const submitRevoke = vi.fn();
const confirmRevoke = vi.fn();
vi.mock("@/lib/soroban/revoke", () => ({
  submitRevoke: (...args: unknown[]) => submitRevoke(...args),
  confirmRevoke: (...args: unknown[]) => confirmRevoke(...args),
}));

import { RevokeButton } from "@/components/allowance-viewer/RevokeButton";
import { TESTNET } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { Connector } from "@/lib/wallet/connector";

const record: AllowanceRecord = {
  contractId: "CTOKEN",
  spender: "GSPENDER",
  amount: 5n,
  live_until_ledger: 100,
  lastSeenLedger: 1,
  expired: false,
};
const network = TESTNET;
const testId = "revoke-button-CTOKEN-GSPENDER";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function clickRevoke(onRevoked = vi.fn()) {
  render(
    <RevokeButton
      record={record}
      userAddress="GUSER"
      network={network}
      connectorRef={{ current: {} as Connector }}
      onRevoked={onRevoked}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
  return onRevoked;
}

beforeEach(() => {
  submitRevoke.mockReset();
  confirmRevoke.mockReset();
  submitRevoke.mockResolvedValue("abcdef0123456789");
});

afterEach(cleanup);

describe("RevokeButton confirmation", () => {
  it("shows submitted, not revoked, until the transaction is confirmed", async () => {
    const confirm = deferred();
    confirmRevoke.mockReturnValue(confirm.promise);
    const onRevoked = await clickRevoke();

    expect(screen.queryByText("Revoked")).toBeNull();
    expect(screen.getByTestId(testId).textContent).toMatch(/Submitted, confirming/);

    await act(async () => {
      confirm.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(onRevoked).toHaveBeenCalledWith(record, "abcdef0123456789");
  });

  it("never shows revoked when confirmation times out", async () => {
    confirmRevoke.mockRejectedValue(
      new Error("Revoke did not confirm within the polling window; it may still land."),
    );
    const onRevoked = await clickRevoke();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Revoked")).toBeNull();
    expect(screen.getByTestId("revoke-unconfirmed").textContent).toMatch(/Not confirmed\./);
    expect(screen.getByRole("link").getAttribute("href")).toContain("abcdef0123456789");
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it("never shows revoked when polling itself fails", async () => {
    confirmRevoke.mockRejectedValue(new TypeError("fetch failed"));
    await clickRevoke();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Revoked")).toBeNull();
    expect(screen.getByTestId("revoke-unconfirmed").textContent).toMatch(/fetch failed/);
  });

  it("offers a retry after an on-chain failure", async () => {
    confirmRevoke.mockRejectedValue(new Error("Revoke transaction failed on-chain: trapped"));
    await clickRevoke();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Revoked")).toBeNull();
    expect(screen.getByTestId("revoke-unconfirmed").textContent).toMatch(/failed on-chain/);
    expect(screen.getByTestId(testId).textContent).toBe("Retry revoke");
  });
});
