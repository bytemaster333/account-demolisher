import { describe, it, expect } from "vitest";
import { BackstopConfig, PoolMetadata } from "@blend-capital/blend-sdk";

import { defaultBlendPoolLoader, withBlendFailover } from "@/lib/adapters/blend/client";
import { blendBackstopsForNetwork, resolveKnownBackstop } from "@/lib/adapters/blend/constants";
import { BLEND_MAINNET_POOLS, BLEND_MAINNET_POOL_IDS } from "@/lib/adapters/blend/pools";
import { MAINNET } from "@/lib/config/networks";

// read-only mainnet checks that the pinned blend registry still matches chain:
// a pool missing from the registry is never scanned, and a pool read against
// the wrong backstop reads as "no deposit"
describe("integration: Blend mainnet registry against on-chain state", () => {
  it("covers every pool in both backstops' reward zones", async () => {
    for (const backstop of blendBackstopsForNetwork(MAINNET)) {
      const config = await withBlendFailover(MAINNET, (n) => BackstopConfig.load(n, backstop.id));
      for (const poolId of config.rewardZone) {
        expect(BLEND_MAINNET_POOL_IDS, `${backstop.version} reward zone pool`).toContain(poolId);
      }
    }
  });

  it("names a pinned backstop of the pool's own version for every registered pool", async () => {
    for (const entry of BLEND_MAINNET_POOLS) {
      const metadata = await withBlendFailover(MAINNET, (n) => PoolMetadata.load(n, entry.pool_id));
      const backstop = resolveKnownBackstop(MAINNET, metadata.backstop);
      expect(backstop.version, entry.name).toBe(entry.version);

      const pool = await withBlendFailover(MAINNET, (n) =>
        defaultBlendPoolLoader.load(n, entry.pool_id),
      );
      expect(pool.version, entry.name).toBe(entry.version);
    }
  });
});
