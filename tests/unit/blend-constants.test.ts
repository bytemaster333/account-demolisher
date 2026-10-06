import { describe, it, expect } from "vitest";
import { Asset } from "@stellar/stellar-sdk";

import {
  BACKSTOP_QUEUE_DURATION_SECONDS,
  BACKSTOP_V1_QUEUE_DURATION_SECONDS,
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_TESTNET_ID,
  BLEND_BACKSTOP_V1_MAINNET_ID,
  blendBackstopsForNetwork,
  blndTokenForNetwork,
  resolveKnownBackstop,
} from "@/lib/adapters/blend/constants";
import {
  BLEND_MAINNET_POOLS,
  BLEND_MAINNET_POOL_IDS,
  BLEND_TESTNET_POOL_IDS,
  blendPoolIdsForNetwork,
} from "@/lib/adapters/blend/pools";
import { isAllowedContract } from "@/lib/config/contracts";
import { MAINNET, TESTNET } from "@/lib/config/networks";
import type { NetworkConfig } from "@/lib/config/networks";

const FUTURENET = { id: "futurenet" } as unknown as NetworkConfig;

describe("Blend backstops per network (C-07)", () => {
  it("knows both mainnet backstops with their own queue locks", () => {
    expect(blendBackstopsForNetwork(MAINNET)).toEqual([
      { id: BLEND_BACKSTOP_V1_MAINNET_ID, version: "V1", queueDurationSeconds: 21 * 86_400 },
      { id: BLEND_BACKSTOP_MAINNET_ID, version: "V2", queueDurationSeconds: 17 * 86_400 },
    ]);
    expect(BACKSTOP_V1_QUEUE_DURATION_SECONDS).toBe(21 * 86_400);
    expect(BACKSTOP_QUEUE_DURATION_SECONDS).toBe(17 * 86_400);
  });

  it("knows the testnet v2 backstop", () => {
    expect(blendBackstopsForNetwork(TESTNET)).toEqual([
      { id: BLEND_BACKSTOP_TESTNET_ID, version: "V2", queueDurationSeconds: 17 * 86_400 },
    ]);
    expect(BLEND_BACKSTOP_TESTNET_ID).toBe(
      "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA",
    );
  });

  it("keeps every backstop the close can call on the allow-list", () => {
    for (const network of [MAINNET, TESTNET]) {
      for (const b of blendBackstopsForNetwork(network)) {
        expect(isAllowedContract(b.id, network)).toBe(true);
      }
    }
  });

  it("refuses an id that is not a pinned backstop of that network", () => {
    expect(() => resolveKnownBackstop(MAINNET, BLEND_BACKSTOP_TESTNET_ID)).toThrow(
      /not a known Blend backstop/,
    );
    expect(resolveKnownBackstop(MAINNET, BLEND_BACKSTOP_V1_MAINNET_ID).version).toBe("V1");
  });

  it("has no backstop on an unsupported network", () => {
    expect(() => blendBackstopsForNetwork(FUTURENET)).toThrow(/no supported deployment/);
  });
});

describe("BLND token (M-26)", () => {
  it("is the stellar asset contract of the pinned BLND classic asset on each network", () => {
    for (const network of [MAINNET, TESTNET]) {
      const blnd = blndTokenForNetwork(network);
      expect(new Asset(blnd.code, blnd.issuer).contractId(network.passphrase)).toBe(
        blnd.contractId,
      );
    }
    expect(blndTokenForNetwork(MAINNET).contractId).toBe(
      "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY",
    );
  });
});

describe("Blend pool registry (H-24, L-34)", () => {
  it("includes the v1 reward-zone pools missing from blend-utils", () => {
    for (const id of [
      "CAQF5KNOFIGRI24NQRRGUPD46Q45MGMXZMRTQFXS25Y4NZVNPT34GM6S", // ReflectorFusion
      "CDE65QK2ROZ32V2LVLBOKYPX47TYMYO37Z6ASQTBRTBNK53C7C6QF4Y7", // FxDAO
      "CBVOPI6QC6OWVCOEZDCFELAGQNAOHUS4CWOKAVADKQZXVSWR2R5IAKO7", // ClickPesa DebtFund
    ]) {
      expect(BLEND_MAINNET_POOL_IDS).toContain(id);
      expect(isAllowedContract(id, MAINNET)).toBe(true);
      expect(BLEND_MAINNET_POOLS.find((p) => p.pool_id === id)?.version).toBe("V1");
    }
  });

  it("selects pools explicitly per network", () => {
    expect(blendPoolIdsForNetwork(MAINNET)).toBe(BLEND_MAINNET_POOL_IDS);
    expect(blendPoolIdsForNetwork(TESTNET)).toBe(BLEND_TESTNET_POOL_IDS);
    expect(() => blendPoolIdsForNetwork(FUTURENET)).toThrow(/no supported pools/);
  });
});
