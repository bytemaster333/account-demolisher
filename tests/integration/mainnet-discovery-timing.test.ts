import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { discoverSoroswapPositions, getSoroswapFactoryId } from "@/lib/adapters/soroswap/discovery";
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import { getRpc } from "@/lib/soroban/rpc-client";
import { simulateRead } from "@/lib/soroban/simulate";
import { fromScValU32 } from "@/lib/soroban/scval";
import { MAINNET } from "@/lib/config/networks";

// Guards the discovery path against the LIVE MAINNET contracts, which are larger
// and busier than testnet's — testnet timing alone never caught either bug this
// covers:
//   1. Soroswap enumeration used an O(pairs) simulate walk that blew the 30s
//      discovery timeout once the factory had a few hundred pairs.
//   2. Blend SDK reads bypassed our RPC failover, so mainnet's 429 under the
//      concurrent per-pool load burst surfaced a spurious "DeFi positions" warning.
// The UI aborts discovery at 30s; the whole DeFi scan must finish well inside that.
const DISCOVERY_TIMEOUT_MS = 30_000;

describe("integration: mainnet DeFi discovery (timing + endpoint failover)", () => {
  it("enumerates the live Soroswap factory and runs full DeFi discovery under the 30s budget", async () => {
    const server = getRpc(MAINNET);
    const fresh = Keypair.random().publicKey();

    // the live factory holds hundreds of pairs; the getLedgerEntries bulk path
    // must still resolve them quickly rather than one simulate per pair.
    const factoryId = getSoroswapFactoryId(MAINNET);
    const lenRet = await simulateRead(server, factoryId, "all_pairs_length", [], fresh, MAINNET);
    expect(fromScValU32(lenRet.retval)).toBeGreaterThan(50);

    const t0 = process.hrtime.bigint();
    const soroswap = await discoverSoroswapPositions(server, MAINNET, fresh);
    const soroswapMs = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(soroswap).toHaveLength(0); // fresh account
    expect(soroswapMs).toBeLessThan(DISCOVERY_TIMEOUT_MS);

    // the actual path discoverActor runs for the "DeFi positions" warning: probes
    // blend/aquarius/soroswap/fxdao. With SDK failover, a transient 429 on one
    // endpoint must be absorbed rather than surfaced as a per-protocol error.
    const t1 = process.hrtime.bigint();
    const positions = await new DirectContractProvider().getPositions(fresh, MAINNET);
    const positionsMs = Number(process.hrtime.bigint() - t1) / 1e6;
    expect(positionsMs).toBeLessThan(DISCOVERY_TIMEOUT_MS);
    expect(positions.errors).toEqual([]);
  });
});
