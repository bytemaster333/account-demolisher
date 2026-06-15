import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { discoverSoroswapPositions } from "@/lib/adapters/soroswap/discovery";
import { getRpc } from "@/lib/soroban/rpc-client";
import { TESTNET } from "@/lib/config/networks";

// Verifies our Soroswap factory-walk ABI (all_pairs_length / all_pairs / balance)
// against the LIVE testnet SoroswapFactory. A wrong function name or type would
// make simulateRead throw here. A fresh account holds no LP, so the result is [].
describe("integration: Soroswap discovery ABI (testnet)", () => {
  it("enumerates the live factory and finds no LP for a fresh account", async () => {
    const server = getRpc(TESTNET);
    const fresh = Keypair.random().publicKey();
    const positions = await discoverSoroswapPositions(server, TESTNET, fresh);
    expect(Array.isArray(positions)).toBe(true);
    expect(positions).toHaveLength(0);
  });
});
