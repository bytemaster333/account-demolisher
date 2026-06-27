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
  removeLiquidity,
  removeLiquidityByContractIds,
  type RemoveLiquidityByContractIdsArgs,
  type RemoveLiquidityDeps,
} from "@/lib/adapters/soroswap/lp";
import { getAllowlistForNetwork } from "@/lib/config/contracts";
import { fromScValAddress, fromScValI128 } from "@/lib/soroban/scval";
import { TESTNET } from "@/lib/config/networks";

// removeLiquidityByContractIds moves real LP-share balances off-chain: the 7 ScVal
// args feed the SoroswapRouter remove_liquidity ABI directly, and amountAMin/amountBMin
// are the on-chain slippage floors. A swapped arg, a dropped guard, or a widened
// validateIntegerAmount regex would build a signable-but-wrong tx. So we DECODE the
// built op args rather than trusting the builder, and assert every guard rejection.

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function contractId(seed: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}

const TOKEN_A = contractId(1);
const TOKEN_B = contractId(2);

const TESTNET_ROUTER = getAllowlistForNetwork(TESTNET).find(
  (c) => c.protocol === "soroswap" && c.name === "SoroswapRouter",
)!.id;

// TransactionBuilder only reads accountId()/sequenceNumber() off the source, so a
// plain Account stands in for the Horizon.AccountResponse the signature wants.
function sourceAccount(): Horizon.AccountResponse {
  return new Account(USER, "1") as unknown as Horizon.AccountResponse;
}

// capture the assembled tx and return it unchanged; the built op already targets the
// allow-listed router, so the assertTransactionAllowed check downstream still passes.
function captureDeps(): { deps: RemoveLiquidityDeps; captured: () => Transaction } {
  let seen: Transaction | undefined;
  const deps: RemoveLiquidityDeps = {
    server: {} as unknown as rpc.Server,
    sourceAccount: sourceAccount(),
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

// pull the contract id, call name, and args out of a built single-op invoke tx
function invokeCall(tx: Transaction): {
  contract: string;
  fn: string;
  args: readonly xdr.ScVal[];
} {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = op.func.invokeContract();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    fn: Buffer.from(call.functionName()).toString(),
    args: call.args(),
  };
}

function baseArgs(
  overrides: Partial<RemoveLiquidityByContractIdsArgs> = {},
): RemoveLiquidityByContractIdsArgs {
  return {
    tokenAAddress: TOKEN_A,
    tokenBAddress: TOKEN_B,
    liquidity: "5000",
    amountAMin: "111",
    amountBMin: "222",
    userAddress: USER,
    deadline: 1_800_000_000,
    network: TESTNET,
    ...overrides,
  };
}

describe("removeLiquidityByContractIds encoding", () => {
  it("invokes remove_liquidity on the allow-listed router with 7 args in ABI order", async () => {
    const { deps, captured } = captureDeps();
    await removeLiquidityByContractIds(baseArgs(), deps);

    const { contract, fn, args } = invokeCall(captured());
    expect(contract).toBe(TESTNET_ROUTER);
    expect(fn).toBe("remove_liquidity");
    // remove_liquidity(token_a, token_b, liquidity, amount_a_min, amount_b_min, to, deadline)
    expect(args).toHaveLength(7);
    expect(fromScValAddress(args[0]!)).toBe(TOKEN_A);
    expect(fromScValAddress(args[1]!)).toBe(TOKEN_B);
    expect(fromScValI128(args[2]!)).toBe(5000n);
    // the two slippage floors must keep their distinct values and order, not be swapped
    expect(fromScValI128(args[3]!)).toBe(111n);
    expect(fromScValI128(args[4]!)).toBe(222n);
    expect(fromScValAddress(args[5]!)).toBe(USER);
    expect(scValToNative(args[6]!)).toBe(1_800_000_000n);
  });

  it("encodes a zero amountMin verbatim (no injected slippage floor)", async () => {
    const { deps, captured } = captureDeps();
    await removeLiquidityByContractIds(baseArgs({ amountAMin: "0", amountBMin: "0" }), deps);

    const { args } = invokeCall(captured());
    expect(fromScValI128(args[3]!)).toBe(0n);
    expect(fromScValI128(args[4]!)).toBe(0n);
  });
});

describe("removeLiquidityByContractIds guards", () => {
  it("rejects a negative liquidity with TypeError before assembling", async () => {
    const { deps } = captureDeps();
    await expect(
      removeLiquidityByContractIds(baseArgs({ liquidity: "-1" }), deps),
    ).rejects.toThrow(TypeError);
  });

  it("rejects a decimal amountAMin with TypeError", async () => {
    const { deps } = captureDeps();
    await expect(
      removeLiquidityByContractIds(baseArgs({ amountAMin: "1.5" }), deps),
    ).rejects.toThrow(TypeError);
  });

  it("rejects a non-integer / NaN amountBMin with TypeError", async () => {
    const { deps } = captureDeps();
    await expect(
      removeLiquidityByContractIds(baseArgs({ amountBMin: "abc" }), deps),
    ).rejects.toThrow(TypeError);
  });

  it("rejects deadline=0 with RangeError", async () => {
    const { deps } = captureDeps();
    await expect(
      removeLiquidityByContractIds(baseArgs({ deadline: 0 }), deps),
    ).rejects.toThrow(RangeError);
  });

  it("rejects a negative deadline with RangeError", async () => {
    const { deps } = captureDeps();
    await expect(
      removeLiquidityByContractIds(baseArgs({ deadline: -1 }), deps),
    ).rejects.toThrow(RangeError);
  });

  it("rejects a non-integer deadline with RangeError", async () => {
    const { deps } = captureDeps();
    await expect(
      removeLiquidityByContractIds(baseArgs({ deadline: 1.5 }), deps),
    ).rejects.toThrow(RangeError);
  });
});

describe("removeLiquidity asset resolution", () => {
  it("refuses liquidity_pool_shares as a token (must pass the two underlying assets)", async () => {
    const { deps } = captureDeps();
    await expect(
      removeLiquidity(
        {
          tokenA: { kind: "liquidity_pool_shares", poolId: "abc" },
          tokenB: { kind: "native" },
          liquidity: "5000",
          amountAMin: "0",
          amountBMin: "0",
          userAddress: USER,
          deadline: 1_800_000_000,
          network: TESTNET,
        },
        deps,
      ),
    ).rejects.toThrow(TypeError);
  });
});
