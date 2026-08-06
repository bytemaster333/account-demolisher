import { describe, it, expect } from "vitest";
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

import {
  swapChained,
  AquariusBudgetError,
  AQUARIUS_SWAP_CHAINED_MAX_HOPS,
  getAquariusRouterId,
  type SwapChainStep,
  type AquariusClientDeps,
} from "@/lib/adapters/aquarius/client";
import { TESTNET } from "@/lib/config/networks";

// swap_chained is the Aquarius "budget-bounded" multi-hop swap: it enforces a
// 4-hop Soroban budget cap and feeds the router's ABI directly. A dropped cap, a
// swapped arg, or a broken chain-struct encoding would build a signable-but-wrong
// tx, so we exercise the cap AND decode the built op args.

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const ROUTER = getAquariusRouterId(TESTNET);

function contractId(seed: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}
const TOKEN_IN = contractId(1);
const TOKEN_OUT = contractId(2);

function poolIndex(seed: number): Uint8Array {
  return new Uint8Array(Buffer.alloc(32, seed));
}

function sourceAccount(): Horizon.AccountResponse {
  return new Account(USER, "1") as unknown as Horizon.AccountResponse;
}

function captureDeps(): { deps: AquariusClientDeps; captured: () => Transaction } {
  let seen: Transaction | undefined;
  const deps: AquariusClientDeps = {
    server: {} as unknown as rpc.Server,
    assemble: async (_server, tx) => {
      seen = tx as Transaction;
      return tx;
    },
  };
  return {
    deps,
    captured: () => {
      if (!seen) throw new Error("assemble was never called");
      return seen;
    },
  };
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

function oneHop(): SwapChainStep {
  return { poolIndex: poolIndex(9), tokens: [TOKEN_IN, TOKEN_OUT], tokenOut: TOKEN_OUT };
}

function baseArgs(swapsChain: readonly SwapChainStep[]) {
  return {
    user: USER,
    swapsChain,
    tokenIn: TOKEN_IN,
    inAmount: 1_000_000n,
    outMin: 950_000n,
    sourceAccount: sourceAccount(),
    network: TESTNET,
  };
}

describe("aquarius swapChained — budget-bounded swap", () => {
  it("enforces the 4-hop budget cap (AquariusBudgetError), one hop over the limit", async () => {
    const { deps } = captureDeps();
    const tooMany = Array.from({ length: AQUARIUS_SWAP_CHAINED_MAX_HOPS + 1 }, oneHop);
    await expect(swapChained(baseArgs(tooMany), deps)).rejects.toBeInstanceOf(AquariusBudgetError);
    try {
      await swapChained(baseArgs(tooMany), deps);
    } catch (err) {
      expect(err).toBeInstanceOf(AquariusBudgetError);
      expect((err as AquariusBudgetError).hops).toBe(AQUARIUS_SWAP_CHAINED_MAX_HOPS + 1);
      expect((err as AquariusBudgetError).limit).toBe(AQUARIUS_SWAP_CHAINED_MAX_HOPS);
    }
  });

  it("accepts a chain exactly at the cap (builds a tx)", async () => {
    const { deps, captured } = captureDeps();
    const atCap = Array.from({ length: AQUARIUS_SWAP_CHAINED_MAX_HOPS }, oneHop);
    await swapChained(baseArgs(atCap), deps);
    expect(captured().operations.length).toBe(1);
  });

  it("rejects an empty chain", async () => {
    const { deps } = captureDeps();
    await expect(swapChained(baseArgs([]), deps)).rejects.toThrow(/at least one hop/);
  });

  it("builds swap_chained against the allow-listed router with the correct ABI", async () => {
    const { deps, captured } = captureDeps();
    await swapChained(baseArgs([oneHop()]), deps);
    const { contract, fn, args } = invokeCall(captured());

    expect(contract).toBe(ROUTER);
    expect(fn).toBe("swap_chained");
    // args: [user, chain(vec<map>), token_in, in_amount(u128), out_min(u128)]
    expect(Address.fromScVal(args[0]!).toString()).toBe(USER);
    const chain = args[1]!.vec()!;
    expect(chain.length).toBe(1);
    // the hop's token_out decodes back to TOKEN_OUT
    const hopMap = chain[0]!.map()!;
    const tokenOutEntry = hopMap.find(
      (e) => Buffer.from(e.key().sym()).toString() === "token_out",
    )!;
    expect(Address.fromScVal(tokenOutEntry.val()).toString()).toBe(TOKEN_OUT);
    expect(Address.fromScVal(args[2]!).toString()).toBe(TOKEN_IN);
    expect(scValToNative(args[3]!)).toBe(1_000_000n); // in_amount
    expect(scValToNative(args[4]!)).toBe(950_000n); // out_min (the budget floor)
  });

  it("rejects a negative amount and a malformed pool index", async () => {
    const { deps } = captureDeps();
    await expect(swapChained({ ...baseArgs([oneHop()]), inAmount: -1n }, deps)).rejects.toThrow(
      /u128 must be >= 0/,
    );
    const badHop: SwapChainStep = {
      poolIndex: new Uint8Array(4),
      tokens: [TOKEN_IN],
      tokenOut: TOKEN_OUT,
    };
    await expect(swapChained(baseArgs([badHop]), deps)).rejects.toThrow(/32-byte/);
  });
});
