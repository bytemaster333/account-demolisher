import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  Account,
  Address,
  SorobanDataBuilder,
  rpc,
  xdr,
  type Operation,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { Connector } from "@/lib/wallet/connector";

// drives the revoke through the real build path: buildRevoke -> buildApprove ->
// assembleSubmittable (the sdk's own assembleTransaction over a simulation
// response) -> auth guard -> fee cap -> review -> sign -> send. only the network
// edge (the rpc server's methods and the ledger clock) is stood in for.

const TOKEN = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const TOKEN_2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_HOSTILE = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const SPENDER = "GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN";
const RECORD = { contractId: TOKEN, spender: SPENDER } as AllowanceRecord;
const RECORD_2 = { contractId: TOKEN_2, spender: SPENDER } as AllowanceRecord;
const RECORD_HOSTILE = { contractId: TOKEN_HOSTILE, spender: SPENDER } as AllowanceRecord;

const sim = {
  resourceFee: 15_929n,
  writeBytes: 0,
  // a token whose simulation asks for far more than a revoke needs
  hostileFee: 4_000_000n,
};
let accountSeq = "100";
const sendTransaction = vi.fn();
const pollTransaction = vi.fn();
const getAccount = vi.fn(async () => new Account(USER, accountSeq));

// the auth entry the simulation hands back authorizes exactly the call it ran
function approveAuth(call: xdr.InvokeContractArgs): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    }),
  });
}

const server = {
  getLatestLedger: async () => ({ id: "x", sequence: 5000, protocolVersion: 23 }),
  getAccount,
  simulateTransaction: async (
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionSuccessResponse> => {
    const call = xdr.expectUnionVariant(
      (tx.operations[0] as Operation.InvokeHostFunction).func,
      "hostFunctionTypeInvokeContract",
    ).invokeContract;
    const token = Address.fromScAddress(call.contractAddress).toString();
    const resourceFee = token === TOKEN_HOSTILE ? sim.hostileFee : sim.resourceFee;
    const data = new SorobanDataBuilder()
      .setResourceFee(resourceFee)
      .setResources(200_000, 0, sim.writeBytes)
      .build();
    return {
      id: "1",
      latestLedger: 5000,
      events: [],
      _parsed: true,
      minResourceFee: resourceFee.toString(),
      transactionData: new SorobanDataBuilder(data),
      result: { auth: [approveAuth(call)], retval: xdr.ScVal.scvVoid() },
    };
  },
  sendTransaction,
  pollTransaction,
};
vi.mock("@/lib/soroban/rpc-client", () => ({ getRpc: () => server }));
// the network's clock, far from the test machine's, so a bound taken from
// Date.now() fails
const LEDGER_CLOSE = 1_700_000_000;
const fetchLedgerClock = vi.fn(async (_network: unknown) => ({
  sequence: 5000,
  closedAt: LEDGER_CLOSE,
}));
vi.mock("@/lib/stellar/ledger-clock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/ledger-clock")>()),
  fetchLedgerClock: (network: unknown) => fetchLedgerClock(network),
}));

import {
  REVOKE_GATE_RELEASE_MS,
  RevokeFailedOnChainError,
  RevokeFeeChangedError,
  confirmRevoke,
  prepareRevoke,
  prepareRevokes,
  submitPreparedRevoke,
} from "@/lib/soroban/revoke";
import { SorobanFeeCapError } from "@/lib/soroban/fee-cap";

function connector() {
  const signed: Transaction[] = [];
  const c = {
    getPublicKey: vi.fn(async () => USER),
    signTransaction: vi.fn(async (tx: Transaction) => {
      signed.push(tx);
      return { signedXdr: tx.toXDR(), signerAddress: USER };
    }),
  };
  return { c: c as unknown as Connector, signed, sign: c.signTransaction };
}

function hashOf(tx: Transaction): string {
  return Buffer.from(tx.hash()).toString("hex");
}

beforeEach(() => {
  vi.clearAllMocks();
  sim.resourceFee = 15_929n;
  sim.writeBytes = 0;
  accountSeq = "100";
  fetchLedgerClock.mockImplementation(async () => ({ sequence: 5000, closedAt: LEDGER_CLOSE }));
  sendTransaction.mockImplementation(async (tx: Transaction) => ({
    status: "PENDING",
    hash: hashOf(tx),
  }));
  pollTransaction.mockResolvedValue({ status: "SUCCESS" });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("prepareRevoke on the real build path", () => {
  it("builds from the rpc's view of the account and reports the fee without signing", async () => {
    const { c, sign } = connector();
    const p = await prepareRevoke(TESTNET, c, RECORD, USER);
    expect(getAccount).toHaveBeenCalledWith(USER);
    expect(p.tx.sequence).toBe("101");
    // fee = inclusion bid + the simulated resource fee, counted once
    expect(p.fee.totalFee).toBe(100_000n + 15_929n);
    expect(p.tx.fee).toBe(p.fee.totalFee.toString());
    expect(sign).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("times the revoke from the latest ledger's close time", async () => {
    const { c } = connector();
    const p = await prepareRevoke(TESTNET, c, RECORD, USER);
    expect(fetchLedgerClock).toHaveBeenCalledWith(TESTNET);
    expect(Number(p.tx.timeBounds?.minTime)).toBe(0);
    expect(Number(p.tx.timeBounds?.maxTime)).toBe(LEDGER_CLOSE + 300);
  });

  it("builds nothing when the ledger clock can't be read", async () => {
    fetchLedgerClock.mockRejectedValueOnce(new Error("horizon down"));
    const { c, sign } = connector();
    await expect(prepareRevoke(TESTNET, c, RECORD, USER)).rejects.toThrow(/horizon down/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a simulated resource fee over the untrusted-token cap before any review", async () => {
    sim.resourceFee = 4_000_000n;
    const { c, sign } = connector();
    const err = await prepareRevoke(TESTNET, c, RECORD, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SorobanFeeCapError);
    expect((err as Error).message).toMatch(/0\.41 XLM/);
    expect(sign).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a token that asks to write far more than a revoke needs", async () => {
    sim.writeBytes = 128 * 1024;
    const { c, sign } = connector();
    await expect(prepareRevoke(TESTNET, c, RECORD, USER)).rejects.toThrow(/write 131072 bytes/);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("submitPreparedRevoke", () => {
  it("signs exactly the transaction whose fee was reviewed", async () => {
    const { c, signed } = connector();
    const p = await prepareRevoke(TESTNET, c, RECORD, USER);
    const hash = await submitPreparedRevoke(c, p);
    expect(signed).toHaveLength(1);
    expect(hashOf(signed[0]!)).toBe(hashOf(p.tx));
    expect(hash).toBe(hashOf(p.tx));
  });

  it("rebuilds a revoke whose sequence went stale and signs it when the fee did not rise", async () => {
    const { c, signed } = connector();
    const p = await prepareRevoke(TESTNET, c, RECORD, USER);
    // another revoke for this account landed while this one was on screen
    accountSeq = "101";
    await submitPreparedRevoke(c, p);
    expect(signed).toHaveLength(1);
    expect(signed[0]!.sequence).toBe("102");
    expect(signed[0]!.fee).toBe(p.tx.fee);
  });

  it("signs nothing when the rebuilt revoke costs more than the reviewed fee", async () => {
    const { c, sign } = connector();
    const p = await prepareRevoke(TESTNET, c, RECORD, USER);
    accountSeq = "101";
    sim.resourceFee = 20_000n;
    const err = await submitPreparedRevoke(c, p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevokeFeeChangedError);
    const changed = err as RevokeFeeChangedError;
    expect(changed.reviewed.fee.totalFee).toBe(115_929n);
    expect(changed.current.fee.totalFee).toBe(120_000n);
    expect(changed.current.tx.sequence).toBe("102");
    expect(changed.message).toMatch(/0\.012 XLM from the 0\.0115929 XLM/);
    expect(sign).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("rebuilds a revoke whose time bound ran out while the fee was on screen", async () => {
    const { c, signed } = connector();
    const p = await prepareRevoke(TESTNET, c, RECORD, USER);
    fetchLedgerClock.mockImplementation(async () => ({
      sequence: 5060,
      closedAt: LEDGER_CLOSE + 300,
    }));
    await submitPreparedRevoke(c, p);
    expect(signed).toHaveLength(1);
    expect(signed[0]!.sequence).toBe("101");
    expect(Number(signed[0]!.timeBounds?.maxTime)).toBe(LEDGER_CLOSE + 600);
  });

  it("refuses when the wallet's account changed while the fee was on screen", async () => {
    const { c, sign } = connector();
    const p = await prepareRevoke(TESTNET, c, RECORD, USER);
    (c.getPublicKey as ReturnType<typeof vi.fn>).mockResolvedValue(SPENDER);
    await expect(submitPreparedRevoke(c, p)).rejects.toThrow(/active account changed/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("releases the per-source gate when a confirm never settles", async () => {
    vi.useFakeTimers();
    pollTransaction.mockImplementation(() => new Promise(() => {}));
    const { c, sign } = connector();
    const first = await prepareRevoke(TESTNET, c, RECORD, USER);
    const second = await prepareRevoke(TESTNET, c, RECORD_2, USER);
    await submitPreparedRevoke(c, first);
    accountSeq = "101";
    const pending = submitPreparedRevoke(c, second);
    await vi.advanceTimersByTimeAsync(REVOKE_GATE_RELEASE_MS - 1);
    expect(sign).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(sign).toHaveBeenCalledTimes(2);
    // the gate is module state shared by every test; let the second one open too
    await vi.advanceTimersByTimeAsync(REVOKE_GATE_RELEASE_MS);
  });

  it("builds the next review only after a revoke in flight for the same account lands", async () => {
    vi.useFakeTimers();
    pollTransaction.mockImplementation(() => new Promise(() => {}));
    const { c } = connector();
    await submitPreparedRevoke(c, await prepareRevoke(TESTNET, c, RECORD, USER));
    accountSeq = "101";
    let built: Awaited<ReturnType<typeof prepareRevoke>> | null = null;
    const next = prepareRevoke(TESTNET, c, RECORD_2, USER).then((p) => (built = p));
    await vi.advanceTimersByTimeAsync(REVOKE_GATE_RELEASE_MS - 1);
    expect(built).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(built!.tx.sequence).toBe("102");
  });
});

describe("prepareRevokes for a sweep", () => {
  it("gives the revokes consecutive sequence numbers so each is signed as reviewed", async () => {
    const { c, signed } = connector();
    const { prepared, failed } = await prepareRevokes(TESTNET, c, [RECORD, RECORD_2], USER);
    expect(failed).toEqual([]);
    expect(prepared.map((p) => p.tx.sequence)).toEqual(["101", "102"]);
    await submitPreparedRevoke(c, prepared[0]!);
    accountSeq = "101";
    await submitPreparedRevoke(c, prepared[1]!);
    expect(signed.map(hashOf)).toEqual(prepared.map((p) => hashOf(p.tx)));
  });

  it("reports a record that fails to build and gives it no sequence number", async () => {
    const { c, sign } = connector();
    const progress: number[] = [];
    const { prepared, failed } = await prepareRevokes(
      TESTNET,
      c,
      [RECORD, RECORD_HOSTILE, RECORD_2],
      USER,
      { onProgress: (n) => progress.push(n) },
    );
    expect(prepared.map((p) => [p.record.contractId, p.tx.sequence])).toEqual([
      [TOKEN, "101"],
      [TOKEN_2, "102"],
    ]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.record).toBe(RECORD_HOSTILE);
    expect(failed[0]!.error).toBeInstanceOf(SorobanFeeCapError);
    expect(progress).toEqual([1, 2, 3]);
    expect(sign).not.toHaveBeenCalled();
  });

  it("stops building when aborted", async () => {
    const { c } = connector();
    const controller = new AbortController();
    const run = prepareRevokes(TESTNET, c, [RECORD, RECORD_2], USER, {
      signal: controller.signal,
      onProgress: () => controller.abort(new Error("cancelled")),
    });
    await expect(run).rejects.toThrow(/cancelled/);
  });
});

// a revoke the ledger rejected is a definite failure, unlike one the poll never
// saw, which may still land (NPF-29)
describe("confirmRevoke", () => {
  const failedResult = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result: xdr.TransactionResultResult.txFailed([]),
    ext: xdr.TransactionResultExt.v0(),
  });

  it("names an on-chain failure as definite, with the result code", async () => {
    pollTransaction.mockResolvedValue({
      status: "FAILED",
      resultXdr: failedResult,
      diagnosticEventsXdr: [],
    });
    const err = await confirmRevoke(TESTNET, "ab".repeat(32)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevokeFailedOnChainError);
    expect((err as Error).message).toMatch(/failed on chain/);
    expect((err as Error).message).toMatch(/txFailed/);
  });

  it("keeps a revoke the poll never saw apart from a failed one", async () => {
    pollTransaction.mockResolvedValue({ status: "NOT_FOUND" });
    const err = await confirmRevoke(TESTNET, "cd".repeat(32)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RevokeFailedOnChainError);
    expect((err as Error).message).toMatch(/may still land/);
  });
});
