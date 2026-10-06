import { afterEach, describe, it, expect, vi } from "vitest";
import {
  BackstopPoolUser,
  BackstopPoolV2,
  BackstopUserEmissions,
  EmissionDataV2,
  EmissionsV2,
  PoolBalance,
  PoolV1,
  PoolV2,
  UserBalance,
} from "@blend-capital/blend-sdk";
import { Asset } from "@stellar/stellar-sdk";

import {
  defaultBlendPoolLoader,
  estimateBackstopEmissions,
  loadBackstopDeposits,
  loadUserPositions,
  loadUserPositionsForPool,
  type BackstopDepositLoader,
  type BlendPoolLoader,
} from "@/lib/adapters/blend/client";
import {
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_TESTNET_ID,
  BLEND_BACKSTOP_V1_MAINNET_ID,
} from "@/lib/adapters/blend/constants";
import { MAINNET, TESTNET } from "@/lib/config/networks";

import { NOW_SECONDS, loaderFor, makePool, supplyEmissions } from "./blend-fixtures";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);
const USDC_SAC = new Asset(
  "USDC",
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
).contractId(TESTNET.passphrase);
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const V2_RATE_1 = 10n ** 12n;

function pool(user: Parameters<typeof makePool>[0]["user"], dRate = V2_RATE_1, bRate = V2_RATE_1) {
  return makePool({
    version: "V2",
    poolId: POOL,
    backstop: BLEND_BACKSTOP_TESTNET_ID,
    reserves: [
      { assetId: XLM_SAC, index: 0, dRate, bRate },
      { assetId: USDC_SAC, index: 1, dRate, bRate },
    ],
    ...(user ? { user } : {}),
  });
}

describe("loadUserPositionsForPool converts to underlying units (M-27)", () => {
  it("reports liabilities as underlying debt, not dTokens", async () => {
    // testnet borrow seen by the auditor: 347,398,171 dTokens at dRate ~2.8786
    const dRate = 2_878_574_550_000n;
    const positions = await loadUserPositionsForPool(
      TESTNET,
      USER,
      POOL,
      loaderFor(pool({ liabilities: [[0, 347_398_171n]] }, dRate)),
    );
    // ceil(347,398,171 * 2.87857455) = 1,000,011,534
    expect(positions.liabilities.get(XLM_SAC)).toBe(1_000_011_534n);
  });

  it("reports collateral and supply as underlying amounts", async () => {
    const bRate = 1_050_000_000_000n; // 1.05
    const positions = await loadUserPositionsForPool(
      TESTNET,
      USER,
      POOL,
      loaderFor(pool({ collateral: [[0, 100n]], supply: [[1, 1_000n]] }, V2_RATE_1, bRate)),
    );
    expect(positions.collateral.get(XLM_SAC)).toBe(105n);
    expect(positions.supply.get(USDC_SAC)).toBe(1_050n);
  });

  it("carries the pool's own backstop from its metadata (C-07)", async () => {
    const v1 = makePool({
      version: "V1",
      poolId: POOL,
      backstop: BLEND_BACKSTOP_V1_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: 10n ** 9n, bRate: 10n ** 9n }],
    });
    const positions = await loadUserPositionsForPool(MAINNET, USER, POOL, loaderFor(v1));
    expect(positions.backstopId).toBe(BLEND_BACKSTOP_V1_MAINNET_ID);
    expect(positions.poolVersion).toBe("V1");
  });

  it("lists only the reserve token ids with accrued emissions (M-26)", async () => {
    const withEmissions = makePool({
      version: "V2",
      poolId: POOL,
      backstop: BLEND_BACKSTOP_TESTNET_ID,
      reserves: [
        {
          assetId: XLM_SAC,
          index: 0,
          dRate: V2_RATE_1,
          bRate: V2_RATE_1,
          supplyEmissions: supplyEmissions(2n * 10n ** 14n),
        },
        { assetId: USDC_SAC, index: 1, dRate: V2_RATE_1, bRate: V2_RATE_1 },
      ],
      // fully withdrawn: no positions left, 3 BLND already accrued on token id 1,
      // and a stale zero entry on token id 3
      user: {
        emissions: [
          [1, 2n * 10n ** 14n, 3_0000000n],
          [3, 0n, 0n],
        ],
      },
    });
    const positions = await loadUserPositionsForPool(TESTNET, USER, POOL, loaderFor(withEmissions));
    expect(positions.claimableEmissionTokenIds).toEqual([1]);
  });
});

describe("reindexByAssetId (via loadUserPositionsForPool)", () => {
  it("throws instead of silently dropping a position at an unmapped reserve index", async () => {
    await expect(
      loadUserPositionsForPool(TESTNET, USER, POOL, loaderFor(pool({ liabilities: [[5, 999n]] }))),
    ).rejects.toThrow(/reserve index 5/);
  });
});

describe("loadUserPositions surfaces per-pool failures via errors[]", () => {
  it("reports the pool as an error instead of a false-clean position", async () => {
    const result = await loadUserPositions(
      TESTNET,
      USER,
      [POOL],
      loaderFor(pool({ collateral: [[7, 500n]] })),
    );
    expect(result.positions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.poolId).toBe(POOL);
    expect(result.errors[0]?.message).toMatch(/reserve index 7/);
  });

  it("labels a failed pool load as the pool stage and a failed user read as the user stage", async () => {
    const userFails = pool(undefined);
    userFails.loadUser = async () => {
      throw new Error("ledger entries unavailable");
    };
    const poolFails: BlendPoolLoader = {
      async load() {
        throw new Error("contract missing");
      },
    };
    const a = await loadUserPositions(TESTNET, USER, [POOL], loaderFor(userFails));
    const b = await loadUserPositions(TESTNET, USER, [POOL], poolFails);
    expect(a.errors[0]?.stage).toBe("user");
    expect(b.errors[0]?.stage).toBe("pool");
  });

  // the soroban rpc client rejects with plain { code, message } objects (L-15)
  it("keeps the message of a plain-object rpc rejection instead of [object Object]", async () => {
    const rpcReject: BlendPoolLoader = {
      async load() {
        throw { code: -32600, message: "startLedger must be within the ledger range" };
      },
    };
    const res = await loadUserPositions(TESTNET, USER, [POOL], rpcReject);
    expect(res.errors[0]?.message).toContain("startLedger must be within the ledger range");
    expect(res.errors[0]?.message).not.toContain("[object Object]");
  });
});

describe("defaultBlendPoolLoader names both version attempts (L-15)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports plain-object rejections from both loads by their message", async () => {
    vi.spyOn(PoolV2, "load").mockRejectedValue({ code: 1, message: "v2 reserve layout" });
    vi.spyOn(PoolV1, "load").mockRejectedValue({ code: 2, message: "v1 reserve layout" });
    const err: unknown = await defaultBlendPoolLoader
      .load({ rpc: TESTNET.rpc, passphrase: TESTNET.passphrase }, POOL)
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain("V2 attempt=v2 reserve layout");
    expect((err as Error).message).toContain("V1 attempt=v1 reserve layout");
  });
});

function stateLoader(
  byPool: Record<string, Partial<Awaited<ReturnType<BackstopDepositLoader["loadUser"]>>>>,
  seen?: string[],
): BackstopDepositLoader {
  return {
    async loadUser(_network, backstop, poolId) {
      seen?.push(`${poolId}@${backstop.id}`);
      return {
        shares: 0n,
        totalQ4W: 0n,
        unlockedQ4W: 0n,
        accruedEmissions: 0n,
        ...byPool[poolId],
      };
    },
  };
}

describe("loadBackstopDeposits", () => {
  const POOL_A = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
  const POOL_B = "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";
  const POOL_C = "CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB";

  it("reads each pool against its own backstop and reports the version's lock (C-07)", async () => {
    const seen: string[] = [];
    const res = await loadBackstopDeposits(
      MAINNET,
      USER,
      [
        { poolId: POOL_A, backstopId: BLEND_BACKSTOP_MAINNET_ID },
        { poolId: POOL_B, backstopId: BLEND_BACKSTOP_V1_MAINNET_ID },
      ],
      stateLoader({ [POOL_B]: { shares: 1_087_724_047_769n } }, seen),
    );
    expect(seen).toEqual([
      `${POOL_A}@${BLEND_BACKSTOP_MAINNET_ID}`,
      `${POOL_B}@${BLEND_BACKSTOP_V1_MAINNET_ID}`,
    ]);
    expect(res.errors).toEqual([]);
    expect(res.deposits).toEqual([
      {
        poolId: POOL_B,
        backstopId: BLEND_BACKSTOP_V1_MAINNET_ID,
        backstopVersion: "V1",
        shares: 1_087_724_047_769n,
        queuedForWithdrawal: 0n,
        unlockedQueuedForWithdrawal: 0n,
        accruedEmissions: 0n,
        queueDurationSeconds: 21 * 24 * 60 * 60,
      },
    ]);
  });

  it("blocks on shares or a queue, and lists emissions-only leftovers apart (L-49)", async () => {
    // queue_withdrawal stores accrued emissions, so every in-app close ends with
    // some accrual once the queue is withdrawn. claiming it would mint new shares
    // and restart the lock, so it must not keep the merge blocked.
    const res = await loadBackstopDeposits(
      MAINNET,
      USER,
      [
        { poolId: POOL_A, backstopId: BLEND_BACKSTOP_MAINNET_ID },
        { poolId: POOL_B, backstopId: BLEND_BACKSTOP_V1_MAINNET_ID },
        { poolId: POOL_C, backstopId: BLEND_BACKSTOP_V1_MAINNET_ID },
      ],
      stateLoader({
        [POOL_A]: { accruedEmissions: 18_611_659n },
        [POOL_B]: { shares: 5n, accruedEmissions: 9n },
      }),
    );
    expect(res.errors).toEqual([]);
    expect(res.deposits.map((d) => [d.poolId, d.shares, d.accruedEmissions])).toEqual([
      [POOL_B, 5n, 9n],
    ]);
    expect(res.unclaimedEmissions).toEqual([
      { poolId: POOL_A, backstopId: BLEND_BACKSTOP_MAINNET_ID, accruedEmissions: 18_611_659n },
    ]);
  });

  it("reports active, queued and unlocked deposits with their accrual (L-49, M-25)", async () => {
    const res = await loadBackstopDeposits(
      MAINNET,
      USER,
      [
        { poolId: POOL_A, backstopId: BLEND_BACKSTOP_MAINNET_ID },
        { poolId: POOL_B, backstopId: BLEND_BACKSTOP_V1_MAINNET_ID },
        { poolId: POOL_C, backstopId: BLEND_BACKSTOP_V1_MAINNET_ID },
      ],
      stateLoader({
        [POOL_A]: { shares: 3n, accruedEmissions: 4_2000000n },
        [POOL_B]: { totalQ4W: 100n, unlockedQ4W: 100n, accruedEmissions: 1n },
      }),
    );
    expect(
      res.deposits.map((d) => [d.poolId, d.accruedEmissions, d.unlockedQueuedForWithdrawal]),
    ).toEqual([
      [POOL_A, 4_2000000n, 0n],
      [POOL_B, 1n, 100n],
    ]);
    expect(res.unclaimedEmissions).toEqual([]);
  });

  it("refuses a backstop that is not a pinned Blend backstop for the network", async () => {
    const res = await loadBackstopDeposits(
      MAINNET,
      USER,
      [{ poolId: POOL_A, backstopId: BLEND_BACKSTOP_TESTNET_ID }],
      stateLoader({}),
    );
    expect(res.deposits).toEqual([]);
    expect(res.errors[0]).toMatch(/not a known Blend backstop/);
  });

  it("surfaces a read failure instead of treating it as 'no backstop position'", async () => {
    const loader: BackstopDepositLoader = {
      async loadUser() {
        throw new Error("rpc down");
      },
    };
    const res = await loadBackstopDeposits(
      MAINNET,
      USER,
      [{ poolId: POOL_A, backstopId: BLEND_BACKSTOP_MAINNET_ID }],
      loader,
    );
    expect(res.deposits).toHaveLength(0);
    expect(res.errors[0]).toContain("backstop read failed");
  });

  it("keeps the message of a plain-object rpc rejection (L-15)", async () => {
    const loader: BackstopDepositLoader = {
      async loadUser() {
        throw { code: -32600, message: "ledger entry archived" };
      },
    };
    const res = await loadBackstopDeposits(
      MAINNET,
      USER,
      [{ poolId: POOL_A, backstopId: BLEND_BACKSTOP_MAINNET_ID }],
      loader,
    );
    expect(res.errors[0]).toContain("ledger entry archived");
    expect(res.errors[0]).not.toContain("[object Object]");
  });
});

describe("estimateBackstopEmissions (L-49)", () => {
  const pool = (index: bigint) =>
    new BackstopPoolV2(
      new PoolBalance(1_000_0000000n, 1_000_0000000n, 0n),
      new EmissionsV2(new EmissionDataV2(NOW_SECONDS + 86_400, 0n, index, NOW_SECONDS), 1),
      1,
    );

  it("counts the stored accrual when the user holds no shares", () => {
    const user = new BackstopPoolUser(
      USER,
      "CPOOL",
      new UserBalance(0n, [], 0n, 0n),
      new BackstopUserEmissions(5n * 10n ** 14n, 12_3456789n),
    );
    expect(estimateBackstopEmissions(user, pool(9n * 10n ** 14n))).toBe(12_3456789n);
  });

  it("adds the accrual since the user's last index on active shares", () => {
    const user = new BackstopPoolUser(
      USER,
      "CPOOL",
      new UserBalance(10_0000000n, [], 0n, 0n),
      new BackstopUserEmissions(1n * 10n ** 14n, 1n),
    );
    // 10 shares * (3e14 - 1e14) / 1e14 = 20 (in 7-decimal units) + 1 stored
    expect(estimateBackstopEmissions(user, pool(3n * 10n ** 14n))).toBe(20_0000001n);
  });

  it("accrues from zero when emissions started after the deposit", () => {
    const user = new BackstopPoolUser(
      USER,
      "CPOOL",
      new UserBalance(10_0000000n, [], 0n, 0n),
      undefined,
    );
    expect(estimateBackstopEmissions(user, pool(1n * 10n ** 14n))).toBe(10_0000000n);
  });

  it("is zero with no shares and no stored emissions", () => {
    const user = new BackstopPoolUser(USER, "CPOOL", new UserBalance(0n, [], 0n, 0n), undefined);
    expect(estimateBackstopEmissions(user, pool(1n * 10n ** 14n))).toBe(0n);
  });
});

// The Blend SDK builds its own RPC Server from the single {rpc} we hand it, so it
// bypasses the failover Proxy getRpc() gives our direct reads. These assert the
// SDK reads retry against the next configured endpoint, exactly like our reads.
describe("Blend SDK reads fail over across endpoints", () => {
  const FALLBACK = TESTNET.rpcFallbacks![0]!;

  it("retries a pool load on the fallback endpoint when the primary rate-limits (429)", async () => {
    const seenRpc: string[] = [];
    const fixture = pool({ supply: [[0, 7n]] });
    const loader: BlendPoolLoader = {
      async load(network) {
        seenRpc.push(network.rpc);
        if (network.rpc === TESTNET.rpc) throw new Error("Request failed with status code 429");
        return fixture;
      },
    };

    const positions = await loadUserPositionsForPool(TESTNET, USER, POOL, loader);

    expect(positions.supply.get(XLM_SAC)).toBe(7n);
    expect(seenRpc).toEqual([TESTNET.rpc, FALLBACK]);
  });

  it("does NOT fail over on a deterministic (non-transport) error", async () => {
    const seenRpc: string[] = [];
    const loader: BlendPoolLoader = {
      async load(network) {
        seenRpc.push(network.rpc);
        throw new Error("Pool.load failed: contract not found");
      },
    };

    await expect(loadUserPositionsForPool(TESTNET, USER, POOL, loader)).rejects.toThrow(
      /contract not found/,
    );
    expect(seenRpc).toEqual([TESTNET.rpc]);
  });

  it("absorbs a per-pool backstop 429 via the fallback, so no warning is surfaced", async () => {
    const seenRpc: string[] = [];
    const loader: BackstopDepositLoader = {
      async loadUser(network) {
        seenRpc.push(network.rpc);
        if (network.rpc === TESTNET.rpc) throw new Error("Request failed with status code 429");
        return { shares: 3_000n, totalQ4W: 0n, unlockedQ4W: 0n, accruedEmissions: 0n };
      },
    };

    const res = await loadBackstopDeposits(
      TESTNET,
      USER,
      [{ poolId: POOL, backstopId: BLEND_BACKSTOP_TESTNET_ID }],
      loader,
    );

    expect(res.errors).toHaveLength(0);
    expect(res.deposits[0]?.shares).toBe(3_000n);
    expect(seenRpc).toEqual([TESTNET.rpc, FALLBACK]);
  });
});
