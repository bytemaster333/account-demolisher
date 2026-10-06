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
  claimConcentratedFees,
  withdrawConcentratedPosition,
  type AquariusClientDeps,
} from "@/lib/adapters/aquarius/client";
import {
  concentratedUserKey,
  discoverConcentratedPositions,
} from "@/lib/adapters/aquarius/concentrated";
import { MAINNET_CONCENTRATED_POOLS } from "@/lib/adapters/aquarius/concentrated-pools";
import { MAINNET } from "@/lib/config/networks";
import { fromScValI32, u128 } from "@/lib/soroban/scval";
import type { simulateRead } from "@/lib/soroban/simulate";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const POOL_A = MAINNET_CONCENTRATED_POOLS[0]!;
const POOL_B = MAINNET_CONCENTRATED_POOLS[1]!;

function sym(s: string) {
  return xdr.ScVal.scvSymbol(s);
}
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k]! })),
  );
}
function range(lo: number, hi: number) {
  return struct({ tick_lower: xdr.ScVal.scvI32(lo), tick_upper: xdr.ScVal.scvI32(hi) });
}
function u128Vec(...v: bigint[]) {
  return xdr.ScVal.scvVec(v.map((x) => u128(x)));
}

// a getLedgerEntries stub that answers like stellar-rpc: only keys that exist
function ledgerWith(existing: readonly xdr.LedgerKey[]) {
  const present = new Set(existing.map((k) => k.toXdr("base64")));
  const calls: number[] = [];
  const server = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      calls.push(keys.length);
      return {
        latestLedger: 1,
        entries: keys
          .filter((k) => present.has(k.toXdr("base64")))
          .map((key) => ({ key, val: {} as never, lastModifiedLedgerSeq: 1 })),
      };
    },
  } as unknown as rpc.Server;
  return { server, calls };
}

type Reads = Record<string, Record<string, xdr.ScVal | Error>>;
function reader(reads: Reads): typeof simulateRead {
  return (async (_s: unknown, contractId: string, fn: string, args: xdr.ScVal[]) => {
    const perPool = reads[contractId];
    let key = fn;
    if (fn === "get_position") key = `${fn}:${fromScValI32(args[1]!)}:${fromScValI32(args[2]!)}`;
    const v = perPool?.[key];
    if (v === undefined) throw new Error(`unexpected read ${contractId}.${key}`);
    if (v instanceof Error) throw v;
    return { retval: v };
  }) as unknown as typeof simulateRead;
}

describe("discoverConcentratedPositions", () => {
  it("finds a tick-range position from the pool's own storage, with fees and rewards", async () => {
    const { server, calls } = ledgerWith([concentratedUserKey(POOL_A.address, USER, "User")]);
    const positions = await discoverConcentratedPositions(server, MAINNET, USER, {
      simulateRead: reader({
        [POOL_A.address]: {
          get_user_position_snapshot: struct({
            ranges: xdr.ScVal.scvVec([range(-15240, -14880), range(-100, 100)]),
            raw_liquidity: u128(20_805_200_856_410n),
            weighted_liquidity: u128(20_805_200_856_410n),
          }),
          "get_position:-15240:-14880": struct({ liquidity: u128(20_805_200_856_410n) }),
          // an emptied range stays in the snapshot but needs no withdraw
          "get_position:-100:100": struct({ liquidity: u128(0n) }),
          get_all_position_fees: u128Vec(112_253_443n, 20_438_425n),
          get_user_reward: u128(10_277_267_356n),
        },
      }),
    });
    // one batched read covers every pinned pool (two keys each)
    expect(calls).toEqual([MAINNET_CONCENTRATED_POOLS.length * 2]);
    expect(positions).toEqual([
      {
        poolAddress: POOL_A.address,
        poolIndex: POOL_A.poolIndex,
        tokens: POOL_A.tokens,
        ranges: [{ tickLower: -15240, tickUpper: -14880, liquidity: 20_805_200_856_410n }],
        pendingFees: [112_253_443n, 20_438_425n],
        pendingReward: 10_277_267_356n,
      },
    ]);
  });

  it("keeps a pool whose only residue is unclaimed rewards", async () => {
    const { server } = ledgerWith([concentratedUserKey(POOL_B.address, USER, "UserRewardData")]);
    const positions = await discoverConcentratedPositions(server, MAINNET, USER, {
      simulateRead: reader({
        [POOL_B.address]: {
          get_user_position_snapshot: struct({
            ranges: xdr.ScVal.scvVec([]),
            raw_liquidity: u128(0n),
            weighted_liquidity: u128(0n),
          }),
          get_all_position_fees: u128Vec(0n, 0n),
          get_user_reward: u128(5n),
        },
      }),
    });
    expect(positions.map((p) => [p.poolAddress, p.ranges.length, p.pendingReward])).toEqual([
      [POOL_B.address, 0, 5n],
    ]);
  });

  it("drops a pool that is fully exited", async () => {
    const { server } = ledgerWith([concentratedUserKey(POOL_A.address, USER, "User")]);
    const positions = await discoverConcentratedPositions(server, MAINNET, USER, {
      simulateRead: reader({
        [POOL_A.address]: {
          get_user_position_snapshot: struct({
            ranges: xdr.ScVal.scvVec([]),
            raw_liquidity: u128(0n),
            weighted_liquidity: u128(0n),
          }),
          get_all_position_fees: u128Vec(0n, 0n),
          get_user_reward: u128(0n),
        },
      }),
    });
    expect(positions).toEqual([]);
  });

  it("throws, naming the pool, when a touched pool cannot be read", async () => {
    const { server } = ledgerWith([concentratedUserKey(POOL_A.address, USER, "User")]);
    await expect(
      discoverConcentratedPositions(server, MAINNET, USER, {
        simulateRead: reader({
          [POOL_A.address]: { get_user_position_snapshot: new Error("rpc 503") },
        }),
      }),
    ).rejects.toThrow(new RegExp(`${POOL_A.address}: rpc 503`));
  });

  it("keeps the text of a plain-object rpc rejection in the pool failure", async () => {
    const { server } = ledgerWith([concentratedUserKey(POOL_A.address, USER, "User")]);
    const throwsPlain = (async () => {
      throw { code: -32001, message: "request exceeded processing limit threshold" };
    }) as unknown as typeof simulateRead;
    await expect(
      discoverConcentratedPositions(server, MAINNET, USER, { simulateRead: throwsPlain }),
    ).rejects.toThrow(new RegExp(`${POOL_A.address}: request exceeded processing limit threshold`));
  });

  it("makes no contract reads when no pool holds state for the user", async () => {
    const { server } = ledgerWith([]);
    const positions = await discoverConcentratedPositions(server, MAINNET, USER, {
      simulateRead: reader({}),
    });
    expect(positions).toEqual([]);
  });
});

function sourceAccount(): Horizon.AccountResponse {
  return new Account(USER, "9") as unknown as Horizon.AccountResponse;
}
function captureDeps(): { deps: AquariusClientDeps; captured: () => Transaction } {
  let seen: Transaction | undefined;
  return {
    deps: {
      server: {} as unknown as rpc.Server,
      assemble: async (_s, tx) => {
        seen = tx as Transaction;
        return tx;
      },
    },
    captured: () => seen!,
  };
}
function invokeCall(tx: Transaction) {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
  return {
    contract: Address.fromScAddress(call.contractAddress).toString(),
    fn: call.functionName.toString(),
    args: call.args.map((a) => scValToNative(a) as unknown),
    types: call.args.map((a) => a.type),
  };
}

describe("concentrated exit builders", () => {
  it("encodes withdraw_position(owner, tick_lower, tick_upper, amount, min_amounts) on the pool", async () => {
    const { deps, captured } = captureDeps();
    await withdrawConcentratedPosition(
      {
        user: USER,
        poolAddress: POOL_A.address,
        tickLower: -15240,
        tickUpper: -14880,
        liquidity: 20_805_200_856_410n,
        minAmounts: [437_000_000_000n, 76_800_000_000n],
        sourceAccount: sourceAccount(),
        network: MAINNET,
      },
      deps,
    );
    const call = invokeCall(captured());
    expect(call.contract).toBe(POOL_A.address);
    expect(call.fn).toBe("withdraw_position");
    expect(call.types).toEqual(["scvAddress", "scvI32", "scvI32", "scvU128", "scvVec"]);
    expect(call.args).toEqual([
      USER,
      -15240,
      -14880,
      20_805_200_856_410n,
      [437_000_000_000n, 76_800_000_000n],
    ]);
  });

  it("encodes claim_all_position_fees(owner) on the pool", async () => {
    const { deps, captured } = captureDeps();
    await claimConcentratedFees(
      { user: USER, poolAddress: POOL_A.address, sourceAccount: sourceAccount(), network: MAINNET },
      deps,
    );
    const call = invokeCall(captured());
    expect([call.contract, call.fn, call.args]).toEqual([
      POOL_A.address,
      "claim_all_position_fees",
      [USER],
    ]);
  });

  it("refuses a pool that is not pinned, an inverted range and a wrong floor count", async () => {
    const { deps } = captureDeps();
    const base = {
      user: USER,
      poolAddress: POOL_A.address,
      tickLower: -10,
      tickUpper: 10,
      liquidity: 1n,
      minAmounts: [0n, 0n],
      sourceAccount: sourceAccount(),
      network: MAINNET,
    };
    const stranger = StrKey.encodeContract(Buffer.alloc(32, 9));
    await expect(
      withdrawConcentratedPosition({ ...base, poolAddress: stranger }, deps),
    ).rejects.toThrow(/not a pinned mainnet concentrated pool/);
    await expect(claimConcentratedFees({ ...base, poolAddress: stranger }, deps)).rejects.toThrow(
      /not a pinned/,
    );
    await expect(
      withdrawConcentratedPosition({ ...base, tickLower: 10, tickUpper: -10 }, deps),
    ).rejects.toThrow(/must be below/);
    await expect(withdrawConcentratedPosition({ ...base, minAmounts: [0n] }, deps)).rejects.toThrow(
      /token count/,
    );
    await expect(withdrawConcentratedPosition({ ...base, liquidity: 0n }, deps)).rejects.toThrow(
      /liquidity must be > 0/,
    );
  });
});
