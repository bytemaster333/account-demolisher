import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { Connector } from "@/lib/wallet/connector";

// submitPreparedRevoke reaches for getRpc through module-level imports and
// reconstructs the signed tx via TransactionBuilder.fromXdr, so we stub those
// seams to drive sendTransaction's status and observe the enqueue guard without
// touching the network.

const sendTransaction = vi.fn();
const getLatestLedger = vi.fn(async () => ({ sequence: 1000 }));
// the account still sits at the sequence the prepared revoke was built from, so
// the reviewed tx is signed as is
const getAccount = vi.fn(async () => ({ sequenceNumber: () => "1000" }) as never);

vi.mock("@/lib/soroban/rpc-client", () => ({
  getRpc: () => ({ getLatestLedger, getAccount, sendTransaction }),
}));
vi.mock("@/lib/soroban/allowances", () => ({
  buildRevoke: vi.fn(async () => ({}) as never),
}));
// buildRevoke is stubbed to a bare object here, so the auth-tree guard (which
// inspects a real approve tx) has nothing meaningful to check; it is verified in
// its own suite (revoke-guard.test.ts). Stub it to a no-op so these enqueue /
// serialization tests stay focused on submitPreparedRevoke's RPC behavior.
vi.mock("@/lib/soroban/revoke-guard", () => ({
  assertSafeRevokeInvocation: vi.fn(),
}));
// same for the fee cap: it reads a prepared tx's soroban data, covered with a
// real prepared tx in revoke-flow.test.ts
vi.mock("@/lib/soroban/fee-cap", () => ({
  assertSorobanFeeWithinCap: vi.fn(),
}));
// the network clock read is a horizon call; buildRevoke is stubbed, so its
// value only has to arrive
vi.mock("@/lib/stellar/ledger-clock", () => ({
  fetchLedgerClock: vi.fn(async () => ({ sequence: 1000, closedAt: 1_700_000_000 })),
}));
vi.mock("@stellar/stellar-sdk", () => ({
  Account: class {},
  TransactionBuilder: { fromXdr: () => ({}) },
}));

import { submitPreparedRevoke, type PreparedRevoke } from "@/lib/soroban/revoke";

const NETWORK = { passphrase: "Test SDF Network ; September 2015" } as NetworkConfig;
const RECORD = { contractId: "C_TOKEN", spender: "G_SPENDER" } as AllowanceRecord;
const USER = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";
// a reviewed revoke built at the account's next sequence, inside its time bound
const PREPARED = {
  network: NETWORK,
  record: RECORD,
  userAddress: USER,
  tx: { sequence: "1001", timeBounds: { minTime: "0", maxTime: "1700000300" } },
  fee: { totalFee: 116_000n },
} as unknown as PreparedRevoke;

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

// let a batch of queued microtasks settle (signAndSend awaits the signer check,
// the account load, the ledger clock and signing before it ever calls sendTransaction).
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("submitPreparedRevoke enqueue guard", () => {
  it("returns the hash when the RPC enqueues it (PENDING)", async () => {
    sendTransaction.mockResolvedValue({ status: "PENDING", hash: "HASH_OK" });
    await expect(submitPreparedRevoke(connector(), PREPARED)).resolves.toBe("HASH_OK");
  });

  it("returns the hash on DUPLICATE (already enqueued)", async () => {
    sendTransaction.mockResolvedValue({ status: "DUPLICATE", hash: "HASH_DUP" });
    await expect(submitPreparedRevoke(connector(), PREPARED)).resolves.toBe("HASH_DUP");
  });

  it("resends the same envelope while the RPC says TRY_AGAIN_LATER and returns the hash once queued", async () => {
    vi.useFakeTimers();
    try {
      sendTransaction
        .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER", hash: "HASH_LATER" })
        .mockResolvedValueOnce({ status: "PENDING", hash: "HASH_LATER" });
      const p = submitPreparedRevoke(connector(), PREPARED);
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
      const p = submitPreparedRevoke(connector(), PREPARED);
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
    await expect(submitPreparedRevoke(connector(), PREPARED)).rejects.toThrow(
      /did not enqueue.*txBadSeq/,
    );
  }, 30_000);

  it("refuses to sign when the wallet's active account drifted from the owner", async () => {
    // a kit wallet signing as a different account than the one we're revoking for
    // (user switched accounts in the extension) must be caught up front, not sent
    const OTHER = "GDLJJ5CGPWNOCBJMCPJY5HXDIAPV2UGQJWKUL35EVS7IR6JJZQ27WOPC";
    const drifted = {
      getPublicKey: vi.fn(async () => OTHER),
      signTransaction: vi.fn(),
    } as unknown as Connector;
    await expect(submitPreparedRevoke(drifted, PREPARED)).rejects.toThrow(/active account changed/);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

describe("submitPreparedRevoke per-source serialization", () => {
  it("does not sign the second revoke until the first has fully returned", async () => {
    // two concurrent submits for the same source must not both check the
    // account at sequence N and send at N+1; chaining guarantees the first
    // completes first.
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

    const p1 = submitPreparedRevoke(connector(), PREPARED);
    const p2 = submitPreparedRevoke(connector(), PREPARED);

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

    const p1 = submitPreparedRevoke(connector(), PREPARED);
    const p2 = submitPreparedRevoke(connector(), PREPARED);

    await expect(p1).rejects.toThrow(/did not enqueue/);
    await expect(p2).resolves.toBe("HASH_NEXT");
  });
});
