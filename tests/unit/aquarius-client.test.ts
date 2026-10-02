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
  claim,
  getAquariusRouterId,
  type AquariusClientDeps,
} from "@/lib/adapters/aquarius/client";
import { MAINNET, TESTNET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TOKEN_A = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN_B = StrKey.encodeContract(Buffer.alloc(32, 2));
const POOL_INDEX = new Uint8Array(Buffer.alloc(32, 7));

function sourceAccount(): Horizon.AccountResponse {
  return new Account(USER, "41") as unknown as Horizon.AccountResponse;
}

function captureDeps(): { deps: AquariusClientDeps; captured: () => Transaction } {
  let seen: Transaction | undefined;
  return {
    deps: {
      server: {} as unknown as rpc.Server,
      assemble: async (_server, tx) => {
        seen = tx as Transaction;
        return tx;
      },
    },
    captured: () => {
      if (!seen) throw new Error("assemble was never called");
      return seen;
    },
  };
}

function invokeCall(tx: Transaction) {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
  return {
    contract: Address.fromScAddress(call.contractAddress).toString(),
    fn: call.functionName.toString(),
    args: call.args,
  };
}

describe("aquarius claim", () => {
  // the deployed router (mainnet CBQDHNBF..., testnet CBCFTQSP...) exports
  // claim(user: Address, tokens: Vec<Address>, pool_index: BytesN<32>) -> u128;
  // a 2-arg call traps with Error(WasmVm, UnexpectedSize)
  it("encodes claim(user, tokens, pool_index) in the router's spec order", async () => {
    const { deps, captured } = captureDeps();
    await claim(
      {
        user: USER,
        tokens: [TOKEN_A, TOKEN_B],
        poolIndex: POOL_INDEX,
        sourceAccount: sourceAccount(),
        network: TESTNET,
      },
      deps,
    );
    const { contract, fn, args } = invokeCall(captured());
    expect(contract).toBe(getAquariusRouterId(TESTNET));
    expect(fn).toBe("claim");
    expect(args).toHaveLength(3);
    expect(args[0]!.type).toBe("scvAddress");
    expect(Address.fromScVal(args[0]!).toString()).toBe(USER);
    expect(args[1]!.type).toBe("scvVec");
    expect(
      xdr.expectUnionVariant(args[1]!, "scvVec").vec!.map((t) => Address.fromScVal(t).toString()),
    ).toEqual([TOKEN_A, TOKEN_B]);
    expect(args[2]!.type).toBe("scvBytes");
    expect(Buffer.from(scValToNative(args[2]!) as Uint8Array)).toEqual(Buffer.from(POOL_INDEX));
  });

  it("refuses to build a claim without the pool's token set", async () => {
    const { deps } = captureDeps();
    await expect(
      claim(
        {
          user: USER,
          tokens: [],
          poolIndex: POOL_INDEX,
          sourceAccount: sourceAccount(),
          network: MAINNET,
        },
        deps,
      ),
    ).rejects.toThrow(/token set/);
  });
});
