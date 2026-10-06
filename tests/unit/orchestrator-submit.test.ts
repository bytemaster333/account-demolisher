import { describe, expect, it, vi } from "vitest";
import {
  Account,
  BadResponseError,
  NotFoundError,
  Operation,
  TransactionBuilder,
  TransactionFailedError,
  xdr,
} from "@stellar/stellar-sdk";

import {
  AmbiguousSubmitError,
  CloseFailure,
  SubmitRejectedError,
} from "@/lib/orchestrator/failures";
import {
  createClassicSubmitter,
  createSorobanSubmitter,
  txHashHex,
  type ClassicSubmitHorizon,
  type SorobanSubmitRpc,
} from "@/lib/orchestrator/submit";

import { DEST, PASS, USER, USER_KP } from "./orchestrator-fixtures";

// real signed envelopes; only horizon and the rpc are doubles, answering with the
// sdk's own error classes

const MAX_TIME = 1_900_000_000;

function signedXdr(maxTime = MAX_TIME): { xdr: string; hash: string } {
  const tx = new TransactionBuilder(new Account(USER, "100"), {
    fee: "100",
    networkPassphrase: PASS,
    timebounds: { minTime: 0, maxTime },
  })
    .addOperation(Operation.accountMerge({ destination: DEST }))
    .build();
  tx.sign(USER_KP);
  return { xdr: tx.toEnvelope().toXdr("base64"), hash: txHashHex(tx) };
}

function details(status: number, data: Record<string, unknown> = {}) {
  return { status, statusText: `HTTP ${status}`, data };
}

// a clock that the reconcile loop's sleeps advance
function timing(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    sleep: vi.fn(async (ms: number) => {
      now += ms;
    }),
  };
}

function horizonDouble(over: {
  submit: () => Promise<unknown>;
  lookup?: (hash: string) => Promise<unknown>;
  closedAt?: () => string;
}): ClassicSubmitHorizon & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    submitTransaction: vi.fn(over.submit),
    transactions: () => ({
      transaction: (hash: string) => ({
        call: async () => {
          lookups.push(hash);
          if (!over.lookup) throw new NotFoundError("not found", details(404));
          return over.lookup(hash);
        },
      }),
    }),
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: async () => ({
            records: [{ closed_at: over.closedAt ? over.closedAt() : "2020-01-01T00:00:00Z" }],
          }),
        }),
      }),
    }),
  } as unknown as ClassicSubmitHorizon & { lookups: string[] };
}

describe("classic submit reports what horizon really said", () => {
  it("looks the hash up after a 504 and returns the receipt when the tx landed", async () => {
    const { xdr: env, hash } = signedXdr();
    const horizon = horizonDouble({
      submit: async () => {
        throw new BadResponseError("timeout", details(504, { title: "Timeout" }));
      },
      lookup: async () => ({ successful: true, ledger_attr: 4242 }),
    });
    const submit = createClassicSubmitter(horizon, PASS, timing(Date.now()));
    await expect(submit(env)).resolves.toEqual({ txHash: hash, ledger: 4242 });
    expect(horizon.lookups).toEqual([hash]);
  });

  it("keeps the hash and says the outcome is unknown when horizon never answers", async () => {
    const { xdr: env, hash } = signedXdr();
    const horizon = horizonDouble({
      submit: async () => {
        throw new BadResponseError("timeout", details(504, { title: "Timeout" }));
      },
    });
    const clock = timing(MAX_TIME * 1000 - 20 * 60_000);
    const submit = createClassicSubmitter(horizon, PASS, clock);
    const err = await submit(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousSubmitError);
    expect(err).toMatchObject({ txHash: hash, maxTime: MAX_TIME, kind: "ambiguous" });
    expect((err as Error).message).toMatch(/HTTP 504: Timeout/);
  });

  it("calls it a definite miss once a ledger past the tx's maxTime closed without it", async () => {
    const { xdr: env } = signedXdr();
    const horizon = horizonDouble({
      submit: async () => {
        throw Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ECONNABORTED" });
      },
      closedAt: () => new Date((MAX_TIME + 5) * 1000).toISOString(),
    });
    const submit = createClassicSubmitter(horizon, PASS, timing(Date.now()));
    const err = await submit(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloseFailure);
    expect(err).toMatchObject({ kind: "network" });
    expect((err as Error).message).toMatch(/expired without landing/);
  });

  it("keeps the result codes of a refusal", async () => {
    const { xdr: env } = signedXdr();
    const codes = { transaction: "tx_failed", operations: ["op_underfunded"] };
    const horizon = horizonDouble({
      submit: async () => {
        throw new TransactionFailedError(
          "failed",
          details(400, { extras: { result_codes: codes } }),
        );
      },
    });
    const err = await createClassicSubmitter(horizon, PASS)(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmitRejectedError);
    expect((err as SubmitRejectedError).codes).toEqual(codes);
    expect((err as SubmitRejectedError).httpStatus).toBe(400);
  });

  it("names the status of a rate limit instead of a bare <no result_codes>", async () => {
    const { xdr: env } = signedXdr();
    const horizon = horizonDouble({
      submit: async () => {
        throw new BadResponseError("slow down", details(429, { title: "Rate Limit Exceeded" }));
      },
    });
    const clock = timing(MAX_TIME * 1000 - 20 * 60_000);
    const err = await createClassicSubmitter(horizon, PASS, clock)(env).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/HTTP 429: Rate Limit Exceeded/);
    expect((err as Error).message).not.toMatch(/no result_codes/);
  });
});

describe("soroban submit resends on TRY_AGAIN_LATER", () => {
  function rpcDouble(statuses: string[]): SorobanSubmitRpc & {
    sendTransaction: ReturnType<typeof vi.fn>;
  } {
    const sendTransaction = vi.fn(async () => ({
      status: statuses.shift() ?? "PENDING",
      hash: "SOROBANHASH",
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    }));
    return {
      sendTransaction,
      pollTransaction: vi.fn(async () => ({ status: "SUCCESS", ledger: 77 })),
    } as unknown as SorobanSubmitRpc & { sendTransaction: ReturnType<typeof vi.fn> };
  }

  it("resends the same signed envelope until the rpc accepts it", async () => {
    const { xdr: env } = signedXdr();
    const rpcServer = rpcDouble(["TRY_AGAIN_LATER", "TRY_AGAIN_LATER", "PENDING"]);
    const sleep = vi.fn(async () => {});
    const submit = createSorobanSubmitter(rpcServer, PASS, { sleep });
    await expect(submit(env)).resolves.toEqual({ txHash: "SOROBANHASH", ledger: 77 });
    expect(rpcServer.sendTransaction).toHaveBeenCalledTimes(3);
    const sent = rpcServer.sendTransaction.mock.calls.map((c) =>
      (c[0] as { toEnvelope(): xdr.TransactionEnvelope }).toEnvelope().toXdr("base64"),
    );
    expect(new Set(sent)).toEqual(new Set([env]));
  });

  it("gives up after a bounded number of resends with a transient failure", async () => {
    const { xdr: env } = signedXdr();
    const rpcServer = rpcDouble(Array.from({ length: 10 }, () => "TRY_AGAIN_LATER"));
    const submit = createSorobanSubmitter(rpcServer, PASS, { sleep: async () => {} });
    const err = await submit(env).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "network" });
    expect(rpcServer.sendTransaction).toHaveBeenCalledTimes(6);
  });

  it("reports a poll that never settled as an unknown outcome with its hash", async () => {
    const { xdr: env } = signedXdr();
    const rpcServer = {
      sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "H2" })),
      pollTransaction: vi.fn(async () => ({ status: "NOT_FOUND" })),
    } as unknown as SorobanSubmitRpc;
    const err = await createSorobanSubmitter(rpcServer, PASS)(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousSubmitError);
    expect(err).toMatchObject({ txHash: "H2" });
  });
});
