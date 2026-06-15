// on-chain Soroswap LP discovery — our own position finder, no third-party API.
//
// Soroswap has no per-user position index: every pair is its own LP-token
// contract. So we walk the factory's pair list and probe the user's LP balance
// on each. ABI (verified against docs.soroswap.finance):
//   SoroswapFactory.all_pairs_length() -> u32
//   SoroswapFactory.all_pairs(n: u32)  -> Address
//   SoroswapPair.balance(id: Address)  -> i128   (LP shares)
//   SoroswapPair.token_0() -> Address
//   SoroswapPair.token_1() -> Address

import type { rpc } from "@stellar/stellar-sdk";
import {
  getAllowlistForNetwork,
  MAINNET_ALLOWLIST,
  type AllowedContract,
} from "@/lib/config/contracts";
import type { NetworkConfig } from "@/lib/config/networks";
import { address as scvAddress, u32 as scvU32 } from "@/lib/soroban/scval";
import { fromScValAddress, fromScValI128, fromScValU32 } from "@/lib/soroban/scval";
import { simulateRead } from "@/lib/soroban/simulate";
import type { SoroswapPositionSummary } from "@/lib/adapters/positions/interface";

export interface SoroswapDiscoveryDeps {
  // injectable for testing; defaults to the real read-only simulator
  readonly simulateRead?: typeof simulateRead;
  // runaway guard: refuse to enumerate a factory with more pairs than this
  readonly maxPairs?: number;
  // pair probes issued concurrently per batch
  readonly concurrency?: number;
}

const DEFAULT_MAX_PAIRS = 1000;
const DEFAULT_CONCURRENCY = 10;

export async function discoverSoroswapPositions(
  server: rpc.Server,
  network: NetworkConfig,
  userAddress: string,
  deps: SoroswapDiscoveryDeps = {},
): Promise<readonly SoroswapPositionSummary[]> {
  const read = deps.simulateRead ?? simulateRead;
  const maxPairs = deps.maxPairs ?? DEFAULT_MAX_PAIRS;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const factoryId = getSoroswapFactoryId(network);

  const lenRet = await read(server, factoryId, "all_pairs_length", [], userAddress, network);
  const pairCount = fromScValU32(lenRet.retval);
  if (pairCount > maxPairs) {
    throw new Error(
      `SoroswapFactory reports ${pairCount} pairs, over the ${maxPairs} enumeration cap; ` +
        `refusing to probe every pair. Close Soroswap LP positions manually if needed.`,
    );
  }

  const positions: SoroswapPositionSummary[] = [];
  for (let start = 0; start < pairCount; start += concurrency) {
    const batch: number[] = [];
    for (let i = start; i < Math.min(start + concurrency, pairCount); i += 1) batch.push(i);
    const found = await Promise.all(
      batch.map((index) => probePair(read, server, network, factoryId, userAddress, index)),
    );
    for (const p of found) if (p) positions.push(p);
  }
  return positions;
}

async function probePair(
  read: typeof simulateRead,
  server: rpc.Server,
  network: NetworkConfig,
  factoryId: string,
  userAddress: string,
  index: number,
): Promise<SoroswapPositionSummary | null> {
  const pairRet = await read(server, factoryId, "all_pairs", [scvU32(index)], userAddress, network);
  const pairId = fromScValAddress(pairRet.retval);

  const balRet = await read(
    server,
    pairId,
    "balance",
    [scvAddress(userAddress)],
    userAddress,
    network,
  );
  const shares = fromScValI128(balRet.retval);
  if (shares <= 0n) return null;

  const [t0Ret, t1Ret] = await Promise.all([
    read(server, pairId, "token_0", [], userAddress, network),
    read(server, pairId, "token_1", [], userAddress, network),
  ]);
  return {
    pair: { tokenA: fromScValAddress(t0Ret.retval), tokenB: fromScValAddress(t1Ret.retval) },
    shareBalance: shares,
  };
}

export function getSoroswapFactoryId(network: NetworkConfig): string {
  const list = getAllowlistForNetwork(network) ?? MAINNET_ALLOWLIST;
  const entry = list.find(
    (c: AllowedContract) => c.protocol === "soroswap" && c.name === "SoroswapFactory",
  );
  if (!entry) {
    throw new Error(`SoroswapFactory not found in the ${network.id} allow-list`);
  }
  return entry.id;
}
