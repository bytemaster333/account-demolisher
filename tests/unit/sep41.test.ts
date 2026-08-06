import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Account,
  Address,
  Operation,
  StrKey,
  scValToNative,
  xdr,
  type Horizon,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

// assembleSubmittable normally simulates; stub it to pass the tx through so we can
// decode the built ABI. simulateRead is controlled per-test for the read helpers.
const simulateRead = vi.fn();
vi.mock("@/lib/soroban/simulate", () => ({
  assembleSubmittable: async (_s: unknown, tx: unknown) => tx,
  simulateRead: (...a: unknown[]) => simulateRead(...a),
}));

import {
  allowance,
  balance,
  buildApprove,
  buildTransfer,
  decimals,
  decodeAllowance,
  symbol,
} from "@/lib/soroban/sep41";
import { i128 as scvI128, u32 as scvU32, symbol as scvSymbol } from "@/lib/soroban/scval";
import { TESTNET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const SPENDER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 5));

function sourceAccount(): Horizon.AccountResponse {
  return new Account(USER, "1") as unknown as Horizon.AccountResponse;
}

function invokeCall(tx: Transaction): { contract: string; fn: string; args: readonly xdr.ScVal[] } {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = op.func.invokeContract();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    fn: Buffer.from(call.functionName()).toString(),
    args: call.args(),
  };
}

describe("sep41 decodeAllowance — SAC (bare i128) vs custom token (scvMap)", () => {
  it("decodes a Stellar Asset Contract's bare-i128 allowance (no expiry ledger)", () => {
    expect(decodeAllowance(scvI128(500n))).toEqual({ amount: 500n, live_until_ledger: 0 });
  });

  it("decodes a custom token's scvMap allowance (amount + live_until_ledger)", () => {
    const v = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: scvSymbol("amount"), val: scvI128(750n) }),
      new xdr.ScMapEntry({ key: scvSymbol("live_until_ledger"), val: scvU32(1000) }),
    ]);
    expect(decodeAllowance(v)).toEqual({ amount: 750n, live_until_ledger: 1000 });
  });

  it("throws on a scvMap missing a required key", () => {
    const v = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: scvSymbol("amount"), val: scvI128(1n) }),
    ]);
    expect(() => decodeAllowance(v)).toThrow(/missing required keys/);
  });

  it("throws on an unexpected scv type", () => {
    expect(() => decodeAllowance(xdr.ScVal.scvBool(true))).toThrow(/Expected scvMap or scvI128/);
  });
});

describe("sep41 read helpers (simulate-backed)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("balance() decodes the i128 retval", async () => {
    simulateRead.mockResolvedValue({ retval: scvI128(1234n) });
    expect(await balance({} as rpc.Server, TOKEN, USER, USER, TESTNET)).toBe(1234n);
    expect(simulateRead).toHaveBeenCalledWith(
      expect.anything(),
      TOKEN,
      "balance",
      expect.any(Array),
      USER,
      TESTNET,
    );
  });

  it("decimals() decodes the u32 retval", async () => {
    simulateRead.mockResolvedValue({ retval: scvU32(7) });
    expect(await decimals({} as rpc.Server, TOKEN, USER, TESTNET)).toBe(7);
  });

  it("symbol() decodes the string retval", async () => {
    simulateRead.mockResolvedValue({ retval: xdr.ScVal.scvString("USDC") });
    expect(await symbol({} as rpc.Server, TOKEN, USER, TESTNET)).toBe("USDC");
  });

  it("allowance() routes the retval through decodeAllowance (custom-token shape)", async () => {
    simulateRead.mockResolvedValue({
      retval: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: scvSymbol("amount"), val: scvI128(42n) }),
        new xdr.ScMapEntry({ key: scvSymbol("live_until_ledger"), val: scvU32(9) }),
      ]),
    });
    expect(await allowance({} as rpc.Server, TOKEN, USER, SPENDER, USER, TESTNET)).toEqual({
      amount: 42n,
      live_until_ledger: 9,
    });
  });
});

describe("sep41 builders decode to the correct ABI", () => {
  it("buildTransfer builds transfer(from, to, amount)", async () => {
    const tx = await buildTransfer({} as rpc.Server, TOKEN, USER, SPENDER, 900n, TESTNET, sourceAccount());
    const { contract, fn, args } = invokeCall(tx);
    expect(contract).toBe(TOKEN);
    expect(fn).toBe("transfer");
    expect(Address.fromScVal(args[0]!).toString()).toBe(USER);
    expect(Address.fromScVal(args[1]!).toString()).toBe(SPENDER);
    expect(scValToNative(args[2]!)).toBe(900n);
  });

  it("buildApprove builds approve(from, spender, amount, expiration_ledger)", async () => {
    const tx = await buildApprove(
      {} as rpc.Server,
      TOKEN,
      USER,
      SPENDER,
      0n,
      12345,
      TESTNET,
      sourceAccount(),
    );
    const { fn, args } = invokeCall(tx);
    expect(fn).toBe("approve");
    expect(Address.fromScVal(args[0]!).toString()).toBe(USER);
    expect(Address.fromScVal(args[1]!).toString()).toBe(SPENDER);
    expect(scValToNative(args[2]!)).toBe(0n); // revoke = approve(0)
    expect(scValToNative(args[3]!)).toBe(12345);
  });
});
