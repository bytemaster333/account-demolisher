import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  Account,
  Address,
  SorobanDataBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { address as scvAddress, i128 as scvI128, u32 as scvU32 } from "@/lib/soroban/scval";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { Connector } from "@/lib/wallet/connector";

// drives submitRevoke through the real build path: buildRevoke -> buildApprove ->
// prepareTransaction (the sdk's own assembleTransaction over a simulation
// response) -> auth guard -> fee cap -> sign -> send. only the network edge (the
// rpc server's methods) is stood in for.

const TOKEN = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const SPENDER = "GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN";
const RECORD = {
  contractId: TOKEN,
  spender: SPENDER,
} as AllowanceRecord;

const sim = { resourceFee: 15_929n, writeBytes: 0 };
let accountSeq = "100";
const sendTransaction = vi.fn();
const pollTransaction = vi.fn();
const getAccount = vi.fn(async () => new Account(USER, accountSeq));

function approveAuth(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(TOKEN).toScAddress(),
          functionName: "approve",
          args: [scvAddress(USER), scvAddress(SPENDER), scvI128(0n), scvU32(5000)],
        }),
      ),
      subInvocations: [],
    }),
  });
}

const server = {
  getLatestLedger: async () => ({ id: "x", sequence: 5000, protocolVersion: 23 }),
  getAccount,
  prepareTransaction: async (tx: Transaction) => {
    const data = new SorobanDataBuilder()
      .setResourceFee(sim.resourceFee)
      .setResources(200_000, 0, sim.writeBytes)
      .build();
    const simulation: rpc.Api.SimulateTransactionSuccessResponse = {
      id: "1",
      latestLedger: 5000,
      events: [],
      _parsed: true,
      minResourceFee: sim.resourceFee.toString(),
      transactionData: new SorobanDataBuilder(data),
      result: { auth: [approveAuth()], retval: xdr.ScVal.scvVoid() },
    };
    return rpc.assembleTransaction(tx, simulation).build();
  },
  sendTransaction,
  pollTransaction,
};
vi.mock("@/lib/soroban/rpc-client", () => ({ getRpc: () => server }));

import { REVOKE_GATE_RELEASE_MS, submitRevoke } from "@/lib/soroban/revoke";
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

beforeEach(() => {
  vi.clearAllMocks();
  sim.resourceFee = 15_929n;
  sim.writeBytes = 0;
  accountSeq = "100";
  sendTransaction.mockImplementation(async (tx: Transaction) => ({
    status: "PENDING",
    hash: Buffer.from(tx.hash()).toString("hex"),
  }));
  pollTransaction.mockResolvedValue({ status: "SUCCESS" });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("submitRevoke on the real build path", () => {
  it("builds from the rpc's view of the account and signs a measured-size revoke", async () => {
    const { c, signed } = connector();
    await submitRevoke(TESTNET, c, RECORD, USER);
    expect(getAccount).toHaveBeenCalledWith(USER);
    expect(signed).toHaveLength(1);
    expect(signed[0]!.sequence).toBe("101");
    // fee = inclusion bid + the simulated resource fee, counted once
    expect(signed[0]!.fee).toBe((100_000n + 15_929n).toString());
  });

  it("refuses to sign when the simulated resource fee is over the untrusted-token cap", async () => {
    sim.resourceFee = 4_000_000n;
    const { c, sign } = connector();
    const err = await submitRevoke(TESTNET, c, RECORD, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SorobanFeeCapError);
    expect((err as Error).message).toMatch(/0\.41 XLM/);
    expect(sign).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a token that asks to write far more than a revoke needs", async () => {
    sim.writeBytes = 128 * 1024;
    const { c, sign } = connector();
    await expect(submitRevoke(TESTNET, c, RECORD, USER)).rejects.toThrow(/write 131072 bytes/);
    expect(sign).not.toHaveBeenCalled();
  });

  it("releases the per-source gate when a confirm never settles", async () => {
    vi.useFakeTimers();
    pollTransaction.mockImplementation(() => new Promise(() => {}));
    const { c, sign } = connector();
    await submitRevoke(TESTNET, c, RECORD, USER);
    accountSeq = "101";
    const second = submitRevoke(TESTNET, c, RECORD, USER);
    await vi.advanceTimersByTimeAsync(REVOKE_GATE_RELEASE_MS - 1);
    expect(sign).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(sign).toHaveBeenCalledTimes(2);
  });
});
