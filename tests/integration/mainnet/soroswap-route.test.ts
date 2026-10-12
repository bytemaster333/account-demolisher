import { describe, it, expect } from "vitest";
import { Asset, StrKey } from "@stellar/stellar-sdk";

import { loadSoroswapPairs } from "@/lib/adapters/soroswap/discovery";
import { NoSoroswapRouteError, quoteRouteToXLM } from "@/lib/adapters/soroswap/swap";
import { MAINNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { simulateRead } from "@/lib/soroban/simulate";
import { fromScValAddress } from "@/lib/soroban/scval";

// read-only mainnet checks of the held-token conversion route search
const SOURCE = "GC6K27OC6OAA6XWVE3GGMJ2US5MOVMYZT5OJ326KOWKH4ZVMHXT6A7X4";

describe("integration: soroswap route search on mainnet", () => {
  it("decodes pair tokens from instance storage the same way the pair reports them", async () => {
    const server = getRpc(MAINNET);
    const pairs = await loadSoroswapPairs(server, MAINNET, SOURCE);
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs.slice(0, 3)) {
      const t0 = await simulateRead(server, p.pair, "token_0", [], SOURCE, MAINNET);
      const t1 = await simulateRead(server, p.pair, "token_1", [], SOURCE, MAINNET);
      expect([fromScValAddress(t0.retval), fromScValAddress(t1.retval)]).toEqual([
        p.token0,
        p.token1,
      ]);
    }
  });

  it("finds a one-hop route for a token with no direct XLM pair", async () => {
    const server = getRpc(MAINNET);
    const xlm = Asset.native().contractId(MAINNET.passphrase);
    const pairs = await loadSoroswapPairs(server, MAINNET, SOURCE);
    const live = pairs.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n);
    const xlmPaired = new Set<string>();
    for (const p of live) {
      if (p.token0 === xlm) xlmPaired.add(p.token1);
      if (p.token1 === xlm) xlmPaired.add(p.token0);
    }
    // tokens with a live pair to an XLM-paired token but no live XLM pair of their own
    const needHop = [
      ...new Set(
        live
          .flatMap((p) => [
            [p.token0, p.token1],
            [p.token1, p.token0],
          ])
          .filter(([t, other]) => t !== xlm && !xlmPaired.has(t!) && xlmPaired.has(other!))
          .map(([t]) => t!),
      ),
    ];
    expect(needHop.length, "mainnet has no token that needs a hop").toBeGreaterThan(0);
    // at least one must route through a hop; a token whose candidates all fail
    // gets an error carrying the router's reason for each
    let routed = 0;
    for (const token of needHop.slice(0, 10)) {
      const route = await quoteRouteToXLM(server, {
        assetIn: { kind: "contract", contractId: token },
        amountIn: 10_000_000n,
        network: MAINNET,
        sourcePublicKey: SOURCE,
      }).catch((e: unknown) => e);
      if (route instanceof NoSoroswapRouteError) {
        expect(route.reasons.length).toBeGreaterThan(0);
        continue;
      }
      if (route instanceof Error) throw route;
      expect(route).toMatchObject({ path: [token, expect.any(String), xlm] });
      routed += 1;
    }
    expect(routed).toBeGreaterThan(0);
  });

  it("answers NoSoroswapRouteError for a token soroswap has never paired", async () => {
    const server = getRpc(MAINNET);
    await expect(
      quoteRouteToXLM(server, {
        assetIn: { kind: "contract", contractId: StrKey.encodeContract(Buffer.alloc(32, 77)) },
        amountIn: 1n,
        network: MAINNET,
        sourcePublicKey: SOURCE,
      }),
    ).rejects.toBeInstanceOf(NoSoroswapRouteError);
  });
});
