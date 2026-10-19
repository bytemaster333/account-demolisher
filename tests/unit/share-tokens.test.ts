import { describe, it, expect } from "vitest";
import {
  Address,
  Operation,
  StrKey,
  scValToNative,
  xdr,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import { getAquariusRouterId } from "@/lib/adapters/aquarius/client";
import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";
import { positionShareTokens } from "@/lib/adapters/positions/share-tokens";
import { getSoroswapFactoryId } from "@/lib/adapters/soroswap/discovery";
import { MAINNET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const A = StrKey.encodeContract(Buffer.alloc(32, 1));
const B = StrKey.encodeContract(Buffer.alloc(32, 2));
const AQUA_SHARE = StrKey.encodeContract(Buffer.alloc(32, 31));
const PAIR = StrKey.encodeContract(Buffer.alloc(32, 32));
const IDX = "1".repeat(64);

// answers the router's share_id and the factory's get_pair, recording each call
function server(calls: string[], fail = false): rpc.Server {
  return {
    simulateTransaction: async (tx: Transaction) => {
      const op = tx.operations[0] as Operation.InvokeHostFunction;
      const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
      const contract = Address.fromScAddress(call.contractAddress).toString();
      const fn = call.functionName.toString();
      calls.push(`${contract}.${fn}`);
      if (fail) return { latestLedger: 1, error: "HostError: trapped", events: [] };
      let retval: xdr.ScVal;
      if (fn === "share_id") {
        expect(Buffer.from(scValToNative(call.args[1]!) as Uint8Array).toString("hex")).toBe(IDX);
        retval = new Address(AQUA_SHARE).toScVal();
      } else if (fn === "get_pair") {
        retval = new Address(PAIR).toScVal();
      } else {
        throw new Error(`unexpected ${fn}`);
      }
      return { latestLedger: 1, minResourceFee: "0", result: { retval, auth: [] }, events: [] };
    },
  } as unknown as rpc.Server;
}

const POSITIONS = {
  ...EMPTY_POSITIONS,
  aquarius: [{ poolIndex: IDX, shareBalance: 5n, tokens: [A, B] }],
  soroswap: [{ pair: { tokenA: A, tokenB: B }, shareBalance: 7n }],
};

describe("positionShareTokens", () => {
  it("reads each share id from the aquarius router and the soroswap factory", async () => {
    const calls: string[] = [];
    const ids = await positionShareTokens(server(calls), MAINNET, USER, POSITIONS);
    expect(ids).toEqual(new Set([AQUA_SHARE, PAIR]));
    expect(calls.sort()).toEqual(
      [
        `${getAquariusRouterId(MAINNET)}.share_id`,
        `${getSoroswapFactoryId(MAINNET)}.get_pair`,
      ].sort(),
    );
  });

  it("reads nothing for an account without pool positions", async () => {
    const calls: string[] = [];
    expect(await positionShareTokens(server(calls), MAINNET, USER, EMPTY_POSITIONS)).toEqual(
      new Set(),
    );
    expect(calls).toEqual([]);
  });

  it("throws when a read fails, so no held token is dropped on a guess", async () => {
    await expect(positionShareTokens(server([], true), MAINNET, USER, POSITIONS)).rejects.toThrow();
  });
});
