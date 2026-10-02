import { describe, it, expect } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import type { BlendPoolSnapshot } from "@/lib/adapters/blend/client";
import {
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_V1_MAINNET_ID,
} from "@/lib/adapters/blend/constants";
import { MAINNET, TESTNET, type NetworkConfig } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

const TOKEN_XLM = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN_USDC = StrKey.encodeContract(Buffer.alloc(32, 2));
const TOKEN_AQUA = StrKey.encodeContract(Buffer.alloc(32, 3));
const SHARED_INDEX = "24f9c991".padEnd(64, "0");

// mainnet pool ids from the registry: one v2 (FixedV2) and one v1 (Fixed)
const POOL_V2 = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const POOL_V1 = "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";

function snapshot(overrides: Partial<BlendPoolSnapshot> & { poolId: string }): BlendPoolSnapshot {
  return {
    poolName: "pool",
    poolVersion: "V2",
    liabilities: new Map(),
    collateral: new Map(),
    supply: new Map(),
    emissions: new Map(),
    backstopId: BLEND_BACKSTOP_MAINNET_ID,
    claimableEmissionTokenIds: [],
    ...overrides,
  };
}

type Deps = ConstructorParameters<typeof DirectContractProvider>[0];

function provider(overrides: Deps = {}): DirectContractProvider {
  return new DirectContractProvider({
    serverFactory: () => ({}) as never,
    aquariusFactory: (() => ({
      primary: { getUserPools: async () => [] },
      fallback: { getUserPools: async () => [] },
    })) as never,
    blendPoolIds: [],
    blendLoadUserPositions: async () => ({ positions: [], errors: [] }),
    blendLoadBackstopDeposits: async () => ({ deposits: [], errors: [] }),
    fxdaoGetUserVaults: async () => [],
    soroswapDiscover: async () => [],
    ...overrides,
  });
}

function aquarius(primary: () => unknown, fallback: () => unknown): Deps {
  return {
    aquariusFactory: (() => ({
      primary: { getUserPools: async () => primary() },
      fallback: { getUserPools: async () => fallback() },
    })) as never,
  };
}

const restDown = () => {
  throw new Error("Failed to fetch");
};

describe("Aquarius discovery when the REST source fails (C-06)", () => {
  it("records an aquarius error when REST rejects and the 7-day scan finds nothing", async () => {
    const positions = await provider(aquarius(restDown, () => [])).getPositions(USER, MAINNET);
    expect(positions.aquarius).toEqual([]);
    const err = positions.errors.find((e) => e.protocol === "aquarius");
    expect(err?.message).toMatch(/REST/);
    expect(err?.message).toMatch(/7 days/);
  });

  it("returns the scanned pool AND records an aquarius error when REST rejects", async () => {
    const pool = {
      poolIndex: SHARED_INDEX,
      poolType: "constant_product",
      tokens: [TOKEN_XLM, TOKEN_USDC],
      shareBalance: 5n,
    };
    const positions = await provider(aquarius(restDown, () => [pool])).getPositions(USER, MAINNET);
    expect(positions.aquarius.map((p) => p.shareBalance)).toEqual([5n]);
    expect(positions.errors.some((e) => e.protocol === "aquarius")).toBe(true);
  });
});

describe("Aquarius union keyed by token set and pool index (H-21)", () => {
  it("keeps two pools that share a pool_index but hold different tokens", async () => {
    const xlmUsdc = {
      poolIndex: SHARED_INDEX,
      poolType: "constant_product",
      tokens: [TOKEN_XLM, TOKEN_USDC],
      shareBalance: 10n,
    };
    const xlmAqua = {
      poolIndex: SHARED_INDEX,
      poolType: "constant_product",
      tokens: [TOKEN_XLM, TOKEN_AQUA],
      shareBalance: 20n,
    };
    const positions = await provider(
      aquarius(
        () => [xlmUsdc, xlmAqua],
        () => [xlmAqua],
      ),
    ).getPositions(USER, MAINNET);
    expect(positions.errors).toEqual([]);
    expect(positions.aquarius).toHaveLength(2);
    expect(new Set(positions.aquarius.map((p) => p.tokens.join(",")))).toEqual(
      new Set([`${TOKEN_XLM},${TOKEN_USDC}`, `${TOKEN_XLM},${TOKEN_AQUA}`]),
    );
  });

  it("still dedups the same pool reported by both sources with tokens in a different order", async () => {
    const a = {
      poolIndex: SHARED_INDEX,
      poolType: "constant_product",
      tokens: [TOKEN_XLM, TOKEN_USDC],
      shareBalance: 10n,
    };
    const b = { ...a, tokens: [TOKEN_USDC, TOKEN_XLM] };
    const positions = await provider(
      aquarius(
        () => [a],
        () => [b],
      ),
    ).getPositions(USER, MAINNET);
    expect(positions.aquarius).toHaveLength(1);
  });
});

describe("Blend backstop is read from each pool's own backstop (C-07)", () => {
  it("queries v1 pools against the v1 backstop and v2 pools against the v2 backstop", async () => {
    const seen: { poolId: string; backstopId: string }[] = [];
    const positions = await provider({
      blendPoolIds: [POOL_V2, POOL_V1],
      blendLoadUserPositions: async () => ({
        positions: [
          snapshot({ poolId: POOL_V2, backstopId: BLEND_BACKSTOP_MAINNET_ID }),
          snapshot({
            poolId: POOL_V1,
            poolVersion: "V1",
            backstopId: BLEND_BACKSTOP_V1_MAINNET_ID,
          }),
        ],
        errors: [],
      }),
      blendLoadBackstopDeposits: async (_network, _user, pools) => {
        seen.push(...pools);
        return {
          deposits: [
            {
              poolId: POOL_V1,
              backstopId: BLEND_BACKSTOP_V1_MAINNET_ID,
              backstopVersion: "V1",
              shares: 1_087_724_047_769n,
              queuedForWithdrawal: 0n,
              unlockedQueuedForWithdrawal: 0n,
              accruedEmissions: 0n,
              queueDurationSeconds: 21 * 24 * 60 * 60,
            },
          ],
          errors: [],
        };
      },
    }).getPositions(USER, MAINNET);

    expect(seen).toEqual([
      { poolId: POOL_V2, backstopId: BLEND_BACKSTOP_MAINNET_ID },
      { poolId: POOL_V1, backstopId: BLEND_BACKSTOP_V1_MAINNET_ID },
    ]);
    expect(positions.errors).toEqual([]);
    // the v1 deposit is reported, so the merge-time reprobe counts it and blocks
    expect(positions.backstop).toHaveLength(1);
    expect(positions.backstop[0]).toMatchObject({
      poolId: POOL_V1,
      backstopId: BLEND_BACKSTOP_V1_MAINNET_ID,
      shares: 1_087_724_047_769n,
      queueDurationSeconds: 21 * 24 * 60 * 60,
    });
  });

  it("keeps a backstop entry whose only content is accrued emissions (L-49)", async () => {
    const positions = await provider({
      blendPoolIds: [POOL_V2],
      blendLoadUserPositions: async () => ({
        positions: [snapshot({ poolId: POOL_V2 })],
        errors: [],
      }),
      blendLoadBackstopDeposits: async () => ({
        deposits: [
          {
            poolId: POOL_V2,
            backstopId: BLEND_BACKSTOP_MAINNET_ID,
            backstopVersion: "V2",
            shares: 0n,
            queuedForWithdrawal: 0n,
            unlockedQueuedForWithdrawal: 0n,
            accruedEmissions: 12_345n,
            queueDurationSeconds: 17 * 24 * 60 * 60,
          },
        ],
        errors: [],
      }),
    }).getPositions(USER, MAINNET);
    expect(positions.backstop).toHaveLength(1);
    expect(positions.backstop[0]?.accruedEmissions).toBe(12_345n);
  });
});

describe("Blend pools holding only accrued emissions (M-26)", () => {
  it("returns an emissions-only pool with its claimable reserve token ids", async () => {
    const positions = await provider({
      blendPoolIds: [POOL_V2],
      blendLoadUserPositions: async () => ({
        positions: [snapshot({ poolId: POOL_V2, claimableEmissionTokenIds: [3, 1] })],
        errors: [],
      }),
    }).getPositions(USER, MAINNET);
    expect(positions.errors).toEqual([]);
    expect(positions.blend).toHaveLength(1);
    expect(positions.blend[0]?.emissionReserveTokenIds).toEqual([1, 3]);
  });

  it("still drops a pool with no balances and nothing claimable", async () => {
    const positions = await provider({
      blendPoolIds: [POOL_V2],
      blendLoadUserPositions: async () => ({
        positions: [snapshot({ poolId: POOL_V2 })],
        errors: [],
      }),
    }).getPositions(USER, MAINNET);
    expect(positions.blend).toEqual([]);
  });
});

describe("Blend pool selection per network (L-34)", () => {
  it("scans the testnet registry on testnet and the mainnet registry on mainnet", async () => {
    const scanned: (readonly string[])[] = [];
    const p = new DirectContractProvider({
      serverFactory: () => ({}) as never,
      aquariusFactory: (() => ({
        primary: { getUserPools: async () => [] },
        fallback: { getUserPools: async () => [] },
      })) as never,
      blendLoadUserPositions: async (_n, _u, poolIds) => {
        scanned.push(poolIds);
        return { positions: [], errors: [] };
      },
      blendLoadBackstopDeposits: async () => ({ deposits: [], errors: [] }),
      fxdaoGetUserVaults: async () => [],
      soroswapDiscover: async () => [],
    });
    await p.getPositions(USER, TESTNET);
    await p.getPositions(USER, MAINNET);
    expect(scanned[0]).toContain("CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF");
    expect(scanned[1]).toContain(POOL_V2);
    expect(scanned[1]).not.toContain("CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF");
  });

  it("refuses an unsupported network instead of scanning mainnet ids against it", async () => {
    let called = false;
    const positions = await new DirectContractProvider({
      serverFactory: () => ({}) as never,
      aquariusFactory: (() => ({
        primary: { getUserPools: async () => [] },
        fallback: { getUserPools: async () => [] },
      })) as never,
      blendLoadUserPositions: async () => {
        called = true;
        return { positions: [], errors: [] };
      },
      blendLoadBackstopDeposits: async () => ({ deposits: [], errors: [] }),
      fxdaoGetUserVaults: async () => [],
      soroswapDiscover: async () => [],
    }).getPositions(USER, { ...TESTNET, id: "futurenet" } as unknown as NetworkConfig);
    expect(called).toBe(false);
    expect(positions.errors.find((e) => e.protocol === "blend")?.message).toMatch(
      /no supported pools/,
    );
  });
});
