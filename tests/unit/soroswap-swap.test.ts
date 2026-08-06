import { describe, it, expect } from "vitest";
import {
  Account,
  Address,
  Asset,
  Operation,
  StrKey,
  xdr,
  type Horizon,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import { buildSwapToXLM, type SwapToXLMDeps } from "@/lib/adapters/soroswap/swap";
import { getAllowlistForNetwork } from "@/lib/config/contracts";
import { fromScValAddress, fromScValI128 } from "@/lib/soroban/scval";
import { TESTNET } from "@/lib/config/networks";

// buildSwapToXLM feeds the SoroswapRouter swap_exact_tokens_for_tokens ABI
// directly, converting a held token to XLM. A swapped arg, a wrong path, or a
// dropped allow-list gate would build a signable-but-wrong tx, so we DECODE the
// built op args rather than trust the builder.

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TOKEN_IN = StrKey.encodeContract(Buffer.alloc(32, 7));
const XLM = Asset.native().contractId(TESTNET.passphrase);
const TESTNET_ROUTER = getAllowlistForNetwork(TESTNET).find(
  (c) => c.protocol === "soroswap" && c.name === "SoroswapRouter",
)!.id;

function sourceAccount(): Horizon.AccountResponse {
  return new Account(USER, "1") as unknown as Horizon.AccountResponse;
}

function captureDeps(): { deps: SwapToXLMDeps; captured: () => Transaction } {
  let seen: Transaction | undefined;
  const deps: SwapToXLMDeps = {
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

function invokeCall(tx: Transaction): { contract: string; fn: string; args: readonly xdr.ScVal[] } {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = op.func.invokeContract();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    fn: Buffer.from(call.functionName()).toString(),
    args: call.args(),
  };
}

describe("buildSwapToXLM", () => {
  const baseArgs = {
    assetIn: { kind: "contract" as const, contractId: TOKEN_IN },
    amountIn: "1000000",
    amountOutMin: "950000",
    userAddress: USER,
    deadline: 1_800_000_000,
    network: TESTNET,
  };

  it("builds a router swap_exact_tokens_for_tokens with a [tokenIn, XLM] path", async () => {
    const { deps, captured } = captureDeps();
    await buildSwapToXLM(baseArgs, deps);
    const { contract, fn, args } = invokeCall(captured());

    expect(contract).toBe(TESTNET_ROUTER); // the allow-listed testnet router
    expect(fn).toBe("swap_exact_tokens_for_tokens");
    expect(fromScValI128(args[0]!)).toBe(1_000_000n); // amount_in
    expect(fromScValI128(args[1]!)).toBe(950_000n); // amount_out_min (the floor)
    // path is a vec of exactly [tokenIn, XLM]
    const path = args[2]!.vec()!;
    expect(path.length).toBe(2);
    expect(fromScValAddress(path[0]!)).toBe(TOKEN_IN);
    expect(fromScValAddress(path[1]!)).toBe(XLM);
    expect(fromScValAddress(args[3]!)).toBe(USER); // to
  });

  it("rejects converting XLM to itself", async () => {
    const { deps } = captureDeps();
    await expect(
      buildSwapToXLM({ ...baseArgs, assetIn: { kind: "native" } }, deps),
    ).rejects.toThrow(/already XLM/);
  });

  it("rejects a non-integer amountIn and a zero amountIn", async () => {
    const { deps } = captureDeps();
    await expect(buildSwapToXLM({ ...baseArgs, amountIn: "1.5" }, deps)).rejects.toThrow(
      /decimal-integer/,
    );
    await expect(buildSwapToXLM({ ...baseArgs, amountIn: "0" }, deps)).rejects.toThrow(/> 0/);
  });

  it("rejects an LP-share asset (must remove liquidity first)", async () => {
    const { deps } = captureDeps();
    await expect(
      buildSwapToXLM({ ...baseArgs, assetIn: { kind: "liquidity_pool_shares", poolId: "x" } }, deps),
    ).rejects.toThrow(/remove liquidity first/);
  });
});
