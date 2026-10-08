import { describe, it, expect, vi } from "vitest";
import {
  Account,
  Address,
  Operation,
  StrKey,
  nativeToScVal,
  xdr,
  type Horizon,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  claimGaugeRewards,
  readGaugeRewards,
  readPositionGaugeRewards,
} from "@/lib/adapters/aquarius/gauges";
import { getAquariusRouterId } from "@/lib/adapters/aquarius/client";
import { MAINNET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TOKEN_A = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN_B = StrKey.encodeContract(Buffer.alloc(32, 2));
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const GAUGED = StrKey.encodeContract(Buffer.alloc(32, 41));
const PLAIN = StrKey.encodeContract(Buffer.alloc(32, 42));
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 43));
const INDEX = "ab".repeat(32);

function storageItem(name: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]), val });
}

const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const sym = (s: string) => xdr.ScVal.scvSymbol(s);

// pool.gauges_get_reward_info(user) as mainnet pool CCNXGPE4... answered it
// on 2026-10-08: { reward token: { expired_at, tps, user_reward } }, all i128
function rewardInfo(rewards: Record<string, bigint>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(rewards).map(
      ([token, reward]) =>
        new xdr.ScMapEntry({
          key: new Address(token).toScVal(),
          val: xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: sym("expired_at"), val: i128(1_791_993_600n) }),
            new xdr.ScMapEntry({ key: sym("tps"), val: i128(1_306_019n) }),
            new xdr.ScMapEntry({ key: sym("user_reward"), val: i128(reward) }),
          ]),
        }),
    ),
  );
}

function instance(contract: string, storage: xdr.ScMapEntry[]): rpc.Api.LedgerEntryResult {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(new Uint8Array(32).fill(1)),
          storage,
        }),
      ),
    }),
  );
  return { key, val, lastModifiedLedgerSeq: 1 };
}

// an rpc with pool instances and contract calls answered by (contract, fn)
function server(
  instances: Record<string, xdr.ScMapEntry[]>,
  answer: (contract: string, fn: string, args: xdr.ScVal[]) => xdr.ScVal,
) {
  const calls: { contract: string; fn: string }[] = [];
  const s = {
    getLedgerEntries: vi.fn(async (...keys: xdr.LedgerKey[]) => ({
      latestLedger: 1,
      entries: keys.flatMap((k) => {
        const id = Address.fromScAddress(
          xdr.expectUnionVariant(k, "contractData").contractData.contract,
        ).toString();
        return id in instances ? [instance(id, instances[id]!)] : [];
      }),
    })),
    simulateTransaction: async (tx: Transaction) => {
      const op = tx.operations[0] as Operation.InvokeHostFunction;
      const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
      const contract = Address.fromScAddress(call.contractAddress).toString();
      const fn = call.functionName.toString();
      calls.push({ contract, fn });
      try {
        const retval = answer(contract, fn, call.args);
        return { latestLedger: 1, minResourceFee: "0", result: { retval, auth: [] }, events: [] };
      } catch (e) {
        return { latestLedger: 1, error: (e as Error).message, events: [] };
      }
    },
  } as unknown as rpc.Server;
  return { server: s, calls };
}

// mainnet stable pool CCNXGPE4... keeps its gauges as { reward token: gauge }
const gauges = (map: Record<string, string>) =>
  storageItem(
    "RewardGaugesMap",
    xdr.ScVal.scvMap(
      Object.entries(map).map(
        ([token, gauge]) =>
          new xdr.ScMapEntry({
            key: new Address(token).toScVal(),
            val: new Address(gauge).toScVal(),
          }),
      ),
    ),
  );

describe("readGaugeRewards", () => {
  it("asks only the pools that have gauges, and keeps what is owed", async () => {
    const { server: s, calls } = server(
      {
        [GAUGED]: [gauges({ [XLM_SAC]: OTHER, [USDC_SAC]: OTHER })],
        [PLAIN]: [storageItem("RewardToken", new Address(TOKEN_A).toScVal())],
      },
      (contract, fn) => {
        if (contract !== GAUGED || fn !== "gauges_get_reward_info") throw new Error("unexpected");
        return rewardInfo({ [XLM_SAC]: 1_126_439_834n, [USDC_SAC]: 0n });
      },
    );
    await expect(readGaugeRewards(s, MAINNET, USER, [GAUGED, PLAIN, GAUGED])).resolves.toEqual([
      { poolAddress: GAUGED, token: XLM_SAC, amount: 1_126_439_834n },
    ]);
    expect(calls).toEqual([{ contract: GAUGED, fn: "gauges_get_reward_info" }]);
  });

  it("reads nothing for an empty pool list", async () => {
    const { server: s } = server({}, () => {
      throw new Error("unexpected");
    });
    await expect(readGaugeRewards(s, MAINNET, USER, [])).resolves.toEqual([]);
  });

  it("fails rather than report no rewards it could not read", async () => {
    await expect(
      readGaugeRewards(server({}, () => xdr.ScVal.scvVoid()).server, MAINNET, USER, [GAUGED]),
    ).rejects.toThrow(/not returned/);
    await expect(
      readGaugeRewards(
        server({ [GAUGED]: [gauges({ [XLM_SAC]: OTHER })] }, () => {
          throw new Error("HostError: Error(Storage, MissingValue)");
        }).server,
        MAINNET,
        USER,
        [GAUGED],
      ),
    ).rejects.toThrow(/MissingValue/);
    await expect(
      readGaugeRewards(
        server({ [GAUGED]: [gauges({ [XLM_SAC]: OTHER })] }, () => xdr.ScVal.scvU32(1)).server,
        MAINNET,
        USER,
        [GAUGED],
      ),
    ).rejects.toThrow(/gauges_get_reward_info/);
  });
});

describe("readPositionGaugeRewards", () => {
  const CONCENTRATED = StrKey.encodeContract(Buffer.alloc(32, 44));

  it("finds the gauge rewards of every pool the user is in, keyed for the claim", async () => {
    const { server: s, calls } = server(
      {
        [GAUGED]: [gauges({ [XLM_SAC]: OTHER })],
        [CONCENTRATED]: [gauges({ [USDC_SAC]: OTHER })],
        [PLAIN]: [],
      },
      (contract, fn, args) => {
        if (fn === "get_pools") {
          // the token set decides which standard pool the router answers with
          const first = Address.fromScVal(args[0]!.vec![0]!).toString();
          return xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvBytes(Buffer.from(INDEX, "hex")),
              val: new Address(first === TOKEN_A ? GAUGED : PLAIN).toScVal(),
            }),
          ]);
        }
        if (fn !== "gauges_get_reward_info") throw new Error(`unexpected ${fn}`);
        return contract === GAUGED
          ? rewardInfo({ [XLM_SAC]: 77n })
          : rewardInfo({ [USDC_SAC]: 0n });
      },
    );
    const got = await readPositionGaugeRewards(s, MAINNET, USER, {
      aquarius: [
        { poolIndex: INDEX, shareBalance: 5n, tokens: [TOKEN_A, TOKEN_B] },
        { poolIndex: INDEX, shareBalance: 5n, tokens: [TOKEN_B, USDC_SAC] },
        // no shares: no withdraw is planned and nothing is asked
        { poolIndex: INDEX, shareBalance: 0n, tokens: [USDC_SAC, XLM_SAC] },
      ],
      aquariusConcentrated: [
        {
          poolAddress: CONCENTRATED,
          poolIndex: INDEX,
          tokens: [XLM_SAC, USDC_SAC],
          ranges: [],
          pendingFees: [0n, 0n],
          pendingReward: 0n,
        },
      ],
    });
    expect(got).toEqual([
      {
        poolAddress: GAUGED,
        tokens: [TOKEN_A, TOKEN_B],
        poolIndex: INDEX,
        rewards: [{ token: XLM_SAC, amount: 77n }],
      },
    ]);
    expect(calls.filter((c) => c.fn === "get_pools")).toHaveLength(2);
    expect(calls.filter((c) => c.fn === "gauges_get_reward_info").map((c) => c.contract)).toEqual([
      GAUGED,
      CONCENTRATED,
    ]);
  });
});

describe("claimGaugeRewards", () => {
  function sourceAccount(): Horizon.AccountResponse {
    return new Account(USER, "41") as unknown as Horizon.AccountResponse;
  }

  // the router's get_pools(tokens) for the pool's token set
  function routerAnswer(pool: string) {
    return (contract: string, fn: string): xdr.ScVal => {
      if (contract !== getAquariusRouterId(MAINNET) || fn !== "get_pools") {
        throw new Error(`unexpected ${contract}.${fn}`);
      }
      return xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvBytes(Buffer.from(INDEX, "hex")),
          val: new Address(pool).toScVal(),
        }),
      ]);
    };
  }

  // mainnet 2026-10-08: pool.gauges_claim(user) for GDLOF7... on CCNXGPE4...
  // simulated with one source-account auth entry, root gauges_claim(user) and no
  // sub-invocations, and paid the gauge's XLM straight from the gauge contract
  it("builds gauges_claim(user) on the pool the router lists for those tokens", async () => {
    let seen: Transaction | undefined;
    await claimGaugeRewards(
      {
        user: USER,
        poolAddress: GAUGED,
        tokens: [TOKEN_A, TOKEN_B],
        poolIndex: INDEX,
        sourceAccount: sourceAccount(),
        network: MAINNET,
      },
      {
        server: server({}, routerAnswer(GAUGED)).server,
        assemble: async (_s, tx) => {
          seen = tx as Transaction;
          return tx;
        },
      },
    );
    expect(seen!.operations).toHaveLength(1);
    const op = seen!.operations[0] as Operation.InvokeHostFunction;
    const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
    expect(Address.fromScAddress(call.contractAddress).toString()).toBe(GAUGED);
    expect(call.functionName.toString()).toBe("gauges_claim");
    expect(call.args).toHaveLength(1);
    expect(Address.fromScVal(call.args[0]!).toString()).toBe(USER);
  });

  // a pool contract is permissionless, so the address must come from the router
  it("refuses a pool address the router does not list for those tokens", async () => {
    const assemble = vi.fn();
    await expect(
      claimGaugeRewards(
        {
          user: USER,
          poolAddress: GAUGED,
          tokens: [TOKEN_A, TOKEN_B],
          poolIndex: INDEX,
          sourceAccount: sourceAccount(),
          network: MAINNET,
        },
        { server: server({}, routerAnswer(OTHER)).server, assemble },
      ),
    ).rejects.toThrow(new RegExp(`${GAUGED} is not the Aquarius pool`));
    expect(assemble).not.toHaveBeenCalled();
  });
});
