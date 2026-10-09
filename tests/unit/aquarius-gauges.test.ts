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
  gaugeForfeitNotice,
  gaugeLineTokens,
  readGaugeRewards,
  readPositionGaugeRewards,
  settleGaugeClaims,
  type PoolGaugeRewards,
} from "@/lib/adapters/aquarius/gauges";
import { getAquariusRouterId } from "@/lib/adapters/aquarius/client";
import type { ExitTrustlineGap } from "@/lib/soroban/stellar-asset";
import { MAINNET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
// the network's clock, far from the test machine's, so a bound taken from
// Date.now() fails
const LEDGER_CLOSE = 1_700_000_000;
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
          const set = xdr.expectUnionVariant(args[0]!, "scvVec").vec!;
          const first = Address.fromScVal(set[0]!).toString();
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
        gaugeTokens: [XLM_SAC],
      },
    ]);
    expect(calls.filter((c) => c.fn === "get_pools")).toHaveLength(2);
    expect(calls.filter((c) => c.fn === "gauges_get_reward_info").map((c) => c.contract)).toEqual([
      GAUGED,
      CONCENTRATED,
    ]);
  });
});

// testnet pool CCSXYUVL... on 2026-10-09 kept gauges for AQUA (owed), DAI and a
// contract token (both owed 0), and gauges_claim trapped on the zero DAI
// transfer into an account with no DAI line
describe("a gauge that owes nothing still needs its line", () => {
  const DAI_SAC = StrKey.encodeContract(Buffer.alloc(32, 45));
  const CUSTOM = StrKey.encodeContract(Buffer.alloc(32, 46));

  it("lists every gauge token of a pool that owes something, owed or not", async () => {
    const { server: s } = server(
      { [GAUGED]: [gauges({ [CUSTOM]: OTHER, [XLM_SAC]: OTHER, [DAI_SAC]: OTHER })] },
      (_contract, fn) => {
        if (fn === "get_pools") {
          return xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvBytes(Buffer.from(INDEX, "hex")),
              val: new Address(GAUGED).toScVal(),
            }),
          ]);
        }
        return rewardInfo({ [CUSTOM]: 0n, [XLM_SAC]: 9n, [DAI_SAC]: 0n });
      },
    );
    const got = await readPositionGaugeRewards(s, MAINNET, USER, {
      aquarius: [{ poolIndex: INDEX, shareBalance: 5n, tokens: [TOKEN_A, TOKEN_B] }],
      aquariusConcentrated: [],
    });
    expect(got).toEqual([
      {
        poolAddress: GAUGED,
        tokens: [TOKEN_A, TOKEN_B],
        poolIndex: INDEX,
        rewards: [{ token: XLM_SAC, amount: 9n }],
        gaugeTokens: [CUSTOM, XLM_SAC, DAI_SAC],
      },
    ]);
    expect(gaugeLineTokens(got)).toEqual([CUSTOM, XLM_SAC, DAI_SAC]);
  });

  it("refuses reward info for a token the pool keeps no gauge for", async () => {
    const { server: s } = server({ [GAUGED]: [gauges({ [XLM_SAC]: OTHER })] }, () =>
      rewardInfo({ [XLM_SAC]: 9n, [DAI_SAC]: 0n }),
    );
    await expect(readGaugeRewards(s, MAINNET, USER, [GAUGED])).rejects.toThrow(
      `Aquarius pool ${GAUGED}: gauges_get_reward_info names ${DAI_SAC}, which the pool keeps no gauge for`,
    );
  });

  it("refuses a gauge map that is not a map", async () => {
    const { server: s } = server(
      { [GAUGED]: [storageItem("RewardGaugesMap", xdr.ScVal.scvU32(1))] },
      () => rewardInfo({}),
    );
    await expect(readGaugeRewards(s, MAINNET, USER, [GAUGED])).rejects.toThrow(
      `Aquarius pool ${GAUGED}: RewardGaugesMap is a scvU32, not a map`,
    );
  });

  const pool = (gaugeTokens: string[]): PoolGaugeRewards => ({
    poolAddress: GAUGED,
    tokens: [TOKEN_A, TOKEN_B],
    poolIndex: INDEX,
    rewards: [{ token: XLM_SAC, amount: 1_126_439_834n }],
    gaugeTokens,
  });
  const ISSUER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
  const dai = <R extends ExitTrustlineGap["reason"]>(reason: R) => ({
    contractId: DAI_SAC,
    code: "DAI",
    issuer: ISSUER,
    reason,
  });

  it("claims a pool whose zero-owed gauge token only lacks a line the plan opens", () => {
    const p = pool([XLM_SAC, DAI_SAC]);
    expect(settleGaugeClaims([p], [dai("missing")])).toEqual({ claimable: [p], forfeited: [] });
  });

  it("leaves out the claim of a pool with a gauge token the account can't receive", () => {
    for (const reason of [
      "unauthorized",
      "issuer_requires_authorization",
      "issuer_missing",
    ] as const) {
      const p = pool([XLM_SAC, DAI_SAC]);
      expect(settleGaugeClaims([p], [dai(reason)])).toEqual({
        claimable: [],
        forfeited: [{ pool: p, blockedBy: [dai(reason)] }],
      });
    }
    // a gap of a token the pool has no gauge for leaves its claim alone
    const other = pool([XLM_SAC]);
    expect(settleGaugeClaims([other], [dai("issuer_missing")])).toEqual({
      claimable: [other],
      forfeited: [],
    });
  });

  it("names the pool, what is forfeited and why in the review note", () => {
    const p = pool([XLM_SAC, DAI_SAC]);
    expect(
      gaugeForfeitNotice({ pool: p, blockedBy: [dai("issuer_requires_authorization")] }, XLM_SAC),
    ).toBe(
      `The reward gauges of Aquarius pool ${GAUGED.slice(0, 6)}…${GAUGED.slice(-4)} owe this ` +
        "account 112.6439834 XLM. Their claim pays every gauge of the pool, and one of them pays " +
        "an asset this account can't receive. This account has no DAI:" +
        `${ISSUER} trustline, and its issuer requires authorization, so a line opened now ` +
        "could not receive anything until the issuer authorizes it. The close leaves that claim " +
        "out, so closing the account forfeits these rewards.",
    );
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
    const built = await claimGaugeRewards(
      {
        user: USER,
        poolAddress: GAUGED,
        tokens: [TOKEN_A, TOKEN_B],
        poolIndex: INDEX,
        sourceAccount: sourceAccount(),
        ledgerCloseTime: LEDGER_CLOSE,
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
    // the pool the router listed, which the auth guard and the allow-list accept
    expect(built.routerPool).toBe(GAUGED);
    expect(built.transaction).toBe(seen);
    // the time bound counts from the ledger read, not the browser's clock
    expect(Number(seen!.timeBounds?.minTime)).toBe(0);
    expect(Number(seen!.timeBounds?.maxTime)).toBe(LEDGER_CLOSE + 300);
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
          ledgerCloseTime: LEDGER_CLOSE,
          network: MAINNET,
        },
        { server: server({}, routerAnswer(OTHER)).server, assemble },
      ),
    ).rejects.toThrow(new RegExp(`${GAUGED} is not the Aquarius pool`));
    expect(assemble).not.toHaveBeenCalled();
  });
});
