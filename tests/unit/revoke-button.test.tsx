// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the revoke primitives build, sign, submit and poll real transactions; here they
// are replaced so the button's own state handling can be driven step by step.
// the real path is covered in revoke-fee-review.test.tsx and revoke-flow.test.ts
const prepareRevoke = vi.fn();
const submitPreparedRevoke = vi.fn();
const confirmRevoke = vi.fn();
vi.mock("@/lib/soroban/revoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soroban/revoke")>()),
  prepareRevoke: (...args: unknown[]) => prepareRevoke(...args),
  submitPreparedRevoke: (...args: unknown[]) => submitPreparedRevoke(...args),
  confirmRevoke: (...args: unknown[]) => confirmRevoke(...args),
}));

import { RevokeButton } from "@/components/allowance-viewer/RevokeButton";
import { TESTNET } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import { RevokeFeeChangedError, type PreparedRevoke } from "@/lib/soroban/revoke";
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
const rowId = "CTOKEN-GSPENDER";

function prepared(totalFee: bigint): PreparedRevoke {
  return { record, userAddress: "GUSER", network, fee: { totalFee } } as unknown as PreparedRevoke;
}

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

async function openReview(onRevoked = vi.fn()) {
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

async function clickRevoke(onRevoked = vi.fn()) {
  await openReview(onRevoked);
  await act(async () => {
    fireEvent.click(screen.getByTestId(`revoke-sign-${rowId}`));
  });
  return onRevoked;
}

beforeEach(() => {
  prepareRevoke.mockReset();
  submitPreparedRevoke.mockReset();
  confirmRevoke.mockReset();
  prepareRevoke.mockResolvedValue(prepared(115_929n));
  submitPreparedRevoke.mockResolvedValue("abcdef0123456789");
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

describe("RevokeButton fee review", () => {
  it("shows the fee and submits nothing until the user signs", async () => {
    await openReview();
    expect(screen.getByTestId(`revoke-fee-${rowId}`).textContent).toBe(
      "Network fee up to 0.0115929 XLM",
    );
    expect(submitPreparedRevoke).not.toHaveBeenCalled();
  });

  it("puts a dearer rebuilt revoke back up for review instead of signing it", async () => {
    const reviewed = prepared(115_929n);
    const current = prepared(120_000n);
    prepareRevoke.mockResolvedValue(reviewed);
    submitPreparedRevoke.mockRejectedValueOnce(new RevokeFeeChangedError(reviewed, current));
    await clickRevoke();
    expect(screen.getByTestId(`revoke-fee-${rowId}`).textContent).toBe(
      "Network fee up to 0.012 XLM",
    );
    expect(screen.getByRole("alert").textContent).toMatch(/rose to 0\.012 XLM/);

    submitPreparedRevoke.mockResolvedValueOnce("abcdef0123456789");
    confirmRevoke.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(screen.getByTestId(`revoke-sign-${rowId}`));
    });
    expect(submitPreparedRevoke.mock.calls[1]![1]).toBe(current);
    expect(screen.getByText("Revoked")).toBeTruthy();
  });

  it("shows why a revoke could not be built and offers a retry", async () => {
    prepareRevoke.mockRejectedValue(new Error("Refusing to sign: this step would cost 0.41 XLM"));
    await openReview();
    expect(screen.getByRole("alert").textContent).toMatch(/0\.41 XLM/);
    expect(screen.getByTestId(testId).textContent).toBe("Retry revoke");
    expect(submitPreparedRevoke).not.toHaveBeenCalled();
  });
});
