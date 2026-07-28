import { describe, it, expect } from "vitest";
import { Keypair, StrKey, type rpc, type xdr } from "@stellar/stellar-sdk";
import { discoverSoroswapPositions, getSoroswapFactoryId } from "@/lib/adapters/soroswap/discovery";
import { address, i128, u32 } from "@/lib/soroban/scval";
import type { simulateRead } from "@/lib/soroban/simulate";
import { TESTNET } from "@/lib/config/networks";

// Verifies the discovery orchestration: bulk enumeration + bulk balance filter
// (both injected here; the real getLedgerEntries key layouts are exercised by the
// live integration test) feed the authoritative simulate confirm of each candidate.

const FACTORY = getSoroswapFactoryId(TESTNET);
const USER = Keypair.random().publicKey();

function contractId(seed: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}

const PAIR0 = contractId(1);
const PAIR1 = contractId(2);
const TOKEN_A = contractId(3);
const TOKEN_B = contractId(4);

const fakeServer = {} as unknown as rpc.Server;

// simulate seam: all_pairs_length (count) + the per-candidate confirm reads.
// all_pairs is only hit on the enumeration fallback, which the injected
// loadPairAddresses below avoids.
function makeRead(pairCount: number): typeof simulateRead {
  return async (
    _server: rpc.Server,
    cId: string,
    fn: string,
    _args: xdr.ScVal[],
  ): Promise<{ retval: xdr.ScVal }> => {
    if (cId === FACTORY && fn === "all_pairs_length") return { retval: u32(pairCount) };
    if (fn === "balance") return { retval: i128(cId === PAIR1 ? 5000n : 0n) };
    if (fn === "token_0") return { retval: address(TOKEN_A) };
    if (fn === "token_1") return { retval: address(TOKEN_B) };
    throw new Error(`unexpected read ${cId}.${fn}`);
  };
}

describe("discoverSoroswapPositions", () => {
  it("returns only pairs where the user holds LP shares, with the pair tokens", async () => {
    const positions = await discoverSoroswapPositions(fakeServer, TESTNET, USER, {
      simulateRead: makeRead(2),
      loadPairAddresses: async () => [PAIR0, PAIR1],
      // bulk balance filter flags PAIR1 (has an entry); PAIR0 has none
      loadHeldPairs: async () => [PAIR1],
    });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual({
      pair: { tokenA: TOKEN_A, tokenB: TOKEN_B },
      shareBalance: 5000n,
    });
  });

  it("drops a candidate the authoritative simulate confirms as zero", async () => {
    // filter flags PAIR0 too, but simulate balance() returns 0 there -> excluded
    const positions = await discoverSoroswapPositions(fakeServer, TESTNET, USER, {
      simulateRead: makeRead(2),
      loadPairAddresses: async () => [PAIR0, PAIR1],
      loadHeldPairs: async () => [PAIR0, PAIR1],
    });
    expect(positions).toHaveLength(1);
    expect(positions[0]!.shareBalance).toBe(5000n);
  });

  it("returns nothing when the factory has no pairs", async () => {
    const positions = await discoverSoroswapPositions(fakeServer, TESTNET, USER, {
      simulateRead: makeRead(0),
      loadPairAddresses: async () => [],
      loadHeldPairs: async () => [],
    });
    expect(positions).toEqual([]);
  });

  it("returns nothing when the user holds no LP anywhere", async () => {
    const positions = await discoverSoroswapPositions(fakeServer, TESTNET, USER, {
      simulateRead: makeRead(2),
      loadPairAddresses: async () => [PAIR0, PAIR1],
      loadHeldPairs: async () => [],
    });
    expect(positions).toEqual([]);
  });

  it("refuses to enumerate a factory larger than the cap", async () => {
    await expect(
      discoverSoroswapPositions(fakeServer, TESTNET, USER, {
        simulateRead: makeRead(50),
        maxPairs: 10,
      }),
    ).rejects.toThrow(/enumeration cap/);
  });
});
