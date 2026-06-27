import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { Connector } from "@/lib/wallet/connector";

// submitRevoke reaches for getRpc / getHorizon / buildRevoke through
// module-level imports and reconstructs the signed tx via
// TransactionBuilder.fromXDR, so we stub those seams to drive sendTransaction's
// status and observe the enqueue guard without touching the network.

const sendTransaction = vi.fn();
const getLatestLedger = vi.fn(async () => ({ sequence: 1000 }));
const loadAccount = vi.fn(async () => ({}) as never);

vi.mock("@/lib/soroban/rpc-client", () => ({
  getRpc: () => ({ getLatestLedger, sendTransaction }),
}));
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({ loadAccount }),
}));
vi.mock("@/lib/soroban/allowances", () => ({
  buildRevoke: vi.fn(async () => ({}) as never),
}));
vi.mock("@stellar/stellar-sdk", () => ({
  TransactionBuilder: { fromXDR: () => ({}) },
}));

import { submitRevoke } from "@/lib/soroban/revoke";

const NETWORK = { passphrase: "Test SDF Network ; September 2015" } as NetworkConfig;
const RECORD = { contractId: "C_TOKEN", spender: "G_SPENDER" } as AllowanceRecord;
const USER = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";

function connector(): Connector {
  return {
    signTransaction: vi.fn(async () => ({ signedXdr: "AAAA", signerAddress: USER })),
  } as unknown as Connector;
}

beforeEach(() => {
  vi.clearAllMocks();
  getLatestLedger.mockResolvedValue({ sequence: 1000 });
});

// let a batch of queued microtasks settle (submitRevokeImpl awaits the ledger,
// account load, build and signing before it ever calls sendTransaction).
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("submitRevoke enqueue guard", () => {
  it("returns the hash when the RPC enqueues it (PENDING)", async () => {
    sendTransaction.mockResolvedValue({ status: "PENDING", hash: "HASH_OK" });
    await expect(submitRevoke(NETWORK, connector(), RECORD, USER)).resolves.toBe("HASH_OK");
  });

  it("returns the hash on DUPLICATE (already enqueued)", async () => {
    sendTransaction.mockResolvedValue({ status: "DUPLICATE", hash: "HASH_DUP" });
    await expect(submitRevoke(NETWORK, connector(), RECORD, USER)).resolves.toBe("HASH_DUP");
  });

  it("throws on TRY_AGAIN_LATER instead of returning a phantom hash", async () => {
    // the RPC did NOT sequence this tx; returning send.hash would falsely report
    // the allowance as revoked. this is the regression the enqueue guard fixes.
    sendTransaction.mockResolvedValue({ status: "TRY_AGAIN_LATER", hash: "HASH_PHANTOM" });
    await expect(submitRevoke(NETWORK, connector(), RECORD, USER)).rejects.toThrow(
      /did not enqueue.*TRY_AGAIN_LATER/,
    );
  });

  it("throws on ERROR and preserves the result-code detail", async () => {
    sendTransaction.mockResolvedValue({
      status: "ERROR",
      hash: "HASH_ERR",
      errorResult: { result: () => ({ switch: () => ({ name: "txBadSeq" }) }) },
    });
    await expect(submitRevoke(NETWORK, connector(), RECORD, USER)).rejects.toThrow(
      /did not enqueue.*txBadSeq/,
    );
  });
});

describe("submitRevoke per-source serialization", () => {
  it("does not build the second revoke until the first has fully returned", async () => {
    // two concurrent submits for the same source must not both read Horizon's
    // sequence N and build at N+1; chaining guarantees the first completes first.
    let firstReleased = false;
    let overlap = false;
    let firstResolve: (v: { status: string; hash: string }) => void = () => {};

    sendTransaction
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            firstResolve = resolve;
          }),
      )
      .mockImplementationOnce(async () => {
        // if the second submit started its send before the first resolved, the
        // serialization guard failed.
        if (!firstReleased) overlap = true;
        return { status: "PENDING", hash: "HASH_2" };
      });

    const p1 = submitRevoke(NETWORK, connector(), RECORD, USER);
    const p2 = submitRevoke(NETWORK, connector(), RECORD, USER);

    // drain enough microtasks that the first submit reaches its (parked)
    // sendTransaction; the second must still be waiting behind it.
    await flush();
    firstReleased = true;
    firstResolve({ status: "PENDING", hash: "HASH_1" });

    await expect(p1).resolves.toBe("HASH_1");
    await expect(p2).resolves.toBe("HASH_2");
    expect(overlap).toBe(false);
    // the guard must not swallow work: both revokes were actually built + sent.
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("still runs the next submit after a prior one rejects", async () => {
    sendTransaction
      .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER", hash: "PHANTOM" })
      .mockResolvedValueOnce({ status: "PENDING", hash: "HASH_NEXT" });

    const p1 = submitRevoke(NETWORK, connector(), RECORD, USER);
    const p2 = submitRevoke(NETWORK, connector(), RECORD, USER);

    await expect(p1).rejects.toThrow(/did not enqueue/);
    await expect(p2).resolves.toBe("HASH_NEXT");
  });
});
