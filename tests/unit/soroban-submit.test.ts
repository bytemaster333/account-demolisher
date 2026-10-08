import { describe, it, expect, vi } from "vitest";
import { xdr, type Transaction } from "@stellar/stellar-sdk";

import {
  pollSoroban,
  sendSoroban,
  SorobanNotQueuedError,
  TRY_AGAIN_LATER_RESENDS,
} from "@/lib/soroban/submit";

const tx = { marker: "signed" } as unknown as Transaction;

function rpcAnswering(...answers: Array<Record<string, unknown>>) {
  const queue = [...answers];
  return {
    sendTransaction: vi.fn(
      async (_tx: Transaction) => queue.shift() ?? answers[answers.length - 1],
    ),
  };
}

describe("sendSoroban", () => {
  it("returns the hash of a queued or already queued transaction", async () => {
    await expect(
      sendSoroban(rpcAnswering({ status: "PENDING", hash: "A" }) as never, tx),
    ).resolves.toBe("A");
    await expect(
      sendSoroban(rpcAnswering({ status: "DUPLICATE", hash: "B" }) as never, tx),
    ).resolves.toBe("B");
  });

  it("resends the same envelope on TRY_AGAIN_LATER with a doubling wait", async () => {
    const rpc = rpcAnswering(
      { status: "TRY_AGAIN_LATER", hash: "H" },
      { status: "TRY_AGAIN_LATER", hash: "H" },
      { status: "PENDING", hash: "H" },
    );
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(sendSoroban(rpc as never, tx, sleep)).resolves.toBe("H");
    expect(rpc.sendTransaction.mock.calls.map((c) => c[0])).toEqual([tx, tx, tx]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1_000, 2_000]);
  });

  it("refuses with the hash once the resends run out, so it is never treated as queued", async () => {
    const rpc = rpcAnswering({ status: "TRY_AGAIN_LATER", hash: "H" });
    const sleep = vi.fn(async (_ms: number) => {});
    const err = await sendSoroban(rpc as never, tx, sleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SorobanNotQueuedError);
    expect(err).toMatchObject({ status: "TRY_AGAIN_LATER", hash: "H", resultCode: null });
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(TRY_AGAIN_LATER_RESENDS + 1);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  it("keeps the result code and diagnostics of an ERROR answer and does not resend it", async () => {
    // the sdk hands diagnostic events over parsed; only their xdr is kept
    const event = { toXdr: (format: string) => `diag-${format}` };
    const rpc = rpcAnswering({
      status: "ERROR",
      hash: "H",
      errorResult: new xdr.TransactionResult({
        feeCharged: 100n,
        result: xdr.TransactionResultResult.txInsufficientFee(),
        ext: xdr.TransactionResultExt.v0(),
      }),
      diagnosticEvents: [event],
    });
    const err = await sendSoroban(rpc as never, tx, async () => {}).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: "ERROR",
      resultCode: "txInsufficientFee",
      diagnostics: ["diag-base64"],
    });
    expect((err as Error).message).toMatch(/refused transaction H \(txInsufficientFee\)/);
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("lets a failed send request reach the caller untouched", async () => {
    const dropped = new Error("socket hang up");
    const rpc = {
      sendTransaction: vi.fn(async () => {
        throw dropped;
      }),
    };
    await expect(sendSoroban(rpc as never, tx)).rejects.toBe(dropped);
  });
});

describe("pollSoroban", () => {
  it("returns the ledger of a landed transaction and asks for the given number of lookups", async () => {
    const rpc = { pollTransaction: vi.fn(async () => ({ status: "SUCCESS", ledger: 42 })) };
    await expect(pollSoroban(rpc as never, "H", 7)).resolves.toEqual({
      status: "SUCCESS",
      ledger: 42,
    });
    expect(rpc.pollTransaction).toHaveBeenCalledWith("H", { attempts: 7 });
  });

  it("reports a failure with its decoded reason, and an unseen transaction as still pending", async () => {
    const failed = { pollTransaction: vi.fn(async () => ({ status: "FAILED" })) };
    await expect(pollSoroban(failed as never, "H")).resolves.toEqual({
      status: "FAILED",
      reason: "",
    });
    const unseen = { pollTransaction: vi.fn(async () => ({ status: "NOT_FOUND" })) };
    await expect(pollSoroban(unseen as never, "H")).resolves.toEqual({ status: "NOT_FOUND" });
    expect(unseen.pollTransaction).toHaveBeenCalledWith("H", { attempts: 60 });
  });
});
