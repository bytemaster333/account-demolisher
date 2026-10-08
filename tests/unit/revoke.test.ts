import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { Connector } from "@/lib/wallet/connector";

// submitRevoke reaches for getRpc / buildRevoke through
// module-level imports and reconstructs the signed tx via
// TransactionBuilder.fromXdr, so we stub those seams to drive sendTransaction's
// status and observe the enqueue guard without touching the network.

const sendTransaction = vi.fn();
const getLatestLedger = vi.fn(async () => ({ sequence: 1000 }));
const getAccount = vi.fn(async () => ({}) as never);

vi.mock("@/lib/soroban/rpc-client", () => ({
  getRpc: () => ({ getLatestLedger, getAccount, sendTransaction }),
}));
vi.mock("@/lib/soroban/allowances", () => ({
  buildRevoke: vi.fn(async () => ({}) as never),
}));
// buildRevoke is stubbed to a bare object here, so the auth-tree guard (which
// inspects a real approve tx) has nothing meaningful to check; it is verified in
// its own suite (revoke-guard.test.ts). Stub it to a no-op so these enqueue /
// serialization tests stay focused on submitRevoke's RPC behavior.
vi.mock("@/lib/soroban/revoke-guard", () => ({
  assertSafeRevokeInvocation: vi.fn(),
}));
// same for the fee cap: it reads a prepared tx's soroban data, covered with a
// real prepared tx in revoke-flow.test.ts
vi.mock("@/lib/soroban/fee-cap", () => ({
  assertSorobanFeeWithinCap: vi.fn(),
}));
vi.mock("@stellar/stellar-sdk", () => ({
  TransactionBuilder: { fromXdr: () => ({}) },
}));

import { submitRevoke } from "@/lib/soroban/revoke";

const NETWORK = { passphrase: "Test SDF Network ; September 2015" } as NetworkConfig;
const RECORD = { contractId: "C_TOKEN", spender: "G_SPENDER" } as AllowanceRecord;
const USER = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";

function connector(): Connector {
  return {
    // revoke asserts the wallet's active account still matches the address it's
    // revoking for before building; this mock reports the expected owner.
    getPublicKey: vi.fn(async () => USER),
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

  it("resends the same envelope while the RPC says TRY_AGAIN_LATER and returns the hash once queued", async () => {
    vi.useFakeTimers();
    try {
      sendTransaction
        .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER", hash: "HASH_LATER" })
        .mockResolvedValueOnce({ status: "PENDING", hash: "HASH_LATER" });
      const p = submitRevoke(NETWORK, connector(), RECORD, USER);
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBe("HASH_LATER");
      expect(sendTransaction).toHaveBeenCalledTimes(2);
      expect(sendTransaction.mock.calls[0]![0]).toBe(sendTransaction.mock.calls[1]![0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on a TRY_AGAIN_LATER that outlasts the resends instead of returning a phantom hash", async () => {
    // the RPC did NOT sequence this tx; returning send.hash would falsely report
    // the allowance as revoked. this is the regression the enqueue guard fixes.
    vi.useFakeTimers();
    try {
      sendTransaction.mockResolvedValue({ status: "TRY_AGAIN_LATER", hash: "HASH_PHANTOM" });
      const p = submitRevoke(NETWORK, connector(), RECORD, USER);
      const settled = p.catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      expect(await settled).toMatchObject({
        message: expect.stringMatching(/did not enqueue.*TRY_AGAIN_LATER/),
      });
      expect(sendTransaction).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  // importActual loads the whole sdk, which can take seconds on a busy machine
  it("throws on ERROR and preserves the result-code detail", async () => {
    const { xdr } =
      await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
    sendTransaction.mockResolvedValue({
      status: "ERROR",
      hash: "HASH_ERR",
      errorResult: new xdr.TransactionResult({
        feeCharged: 100n,
        result: xdr.TransactionResultResult.txBadSeq(),
        ext: xdr.TransactionResultExt.v0(),
      }),
    });
    await expect(submitRevoke(NETWORK, connector(), RECORD, USER)).rejects.toThrow(
      /did not enqueue.*txBadSeq/,
    );
  }, 30_000);

  it("refuses to build/submit when the wallet's active account drifted from the owner", async () => {
    // a kit wallet signing as a different account than the one we're revoking for
    // (user switched accounts in the extension) must be caught up front, not sent
    const OTHER = "GDLJJ5CGPWNOCBJMCPJY5HXDIAPV2UGQJWKUL35EVS7IR6JJZQ27WOPC";
    const drifted = {
      getPublicKey: vi.fn(async () => OTHER),
      signTransaction: vi.fn(),
    } as unknown as Connector;
    await expect(submitRevoke(NETWORK, drifted, RECORD, USER)).rejects.toThrow(
      /active account changed/,
    );
    expect(sendTransaction).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({ status: "ERROR", hash: "PHANTOM" })
      .mockResolvedValueOnce({ status: "PENDING", hash: "HASH_NEXT" });

    const p1 = submitRevoke(NETWORK, connector(), RECORD, USER);
    const p2 = submitRevoke(NETWORK, connector(), RECORD, USER);

    await expect(p1).rejects.toThrow(/did not enqueue/);
    await expect(p2).resolves.toBe("HASH_NEXT");
  });
});
