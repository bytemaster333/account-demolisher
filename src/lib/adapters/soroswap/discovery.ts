// on-chain Soroswap LP discovery: our own position finder, no third-party API.
//
// Soroswap has no per-user position index: every pair is its own LP-token
// contract, so in principle you must inspect the user's balance on every pair.
// Naively that is two `simulateTransaction` round-trips per pair (all_pairs(i) to
// resolve the address, then balance(user)), which is O(pairs) heavy RPC calls and
// blows the discovery timeout once a factory has a few hundred pairs.
//
// Instead we read the same storage directly with `getLedgerEntries`, which fetches
// up to ~200 ledger keys per call. Both key layouts below were validated against
// the contracts' OWN simulation footprints (the keys balance()/all_pairs() read):
//   factory  persistent  Vec[Symbol("PairAddressesNIndexed"), U32(index)] -> Address(pair)
//   pair     persistent  Vec[Symbol("Balance"), Address(user)]            -> i128 shares
// So the whole factory enumerates + filters in a handful of batched reads, and we
// fall back to the authoritative simulate for anything the bulk read can't resolve.
// Reading the exact key balance() reads means identical completeness (an evicted
// entry reads absent either way), so no position is silently missed.
//
// Pair-token ABI (verified against docs.soroswap.finance):
//   SoroswapFactory.all_pairs_length() -> u32
//   SoroswapFactory.all_pairs(n: u32)  -> Address
//   SoroswapPair.balance(id: Address)  -> i128   (LP shares)
//   SoroswapPair.token_0() -> Address
//   SoroswapPair.token_1() -> Address

import { Address, xdr, type rpc } from "@stellar/stellar-sdk";
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
  // ledger keys per getLedgerEntries call (RPC caps this near 200)
  readonly batchSize?: number;
  // test seams for the two bulk reads; default to the getLedgerEntries impls below
  readonly loadPairAddresses?: (
    server: rpc.Server,
    factoryId: string,
    pairCount: number,
  ) => Promise<readonly string[]>;
  readonly loadHeldPairs?: (
    server: rpc.Server,
    pairAddresses: readonly string[],
    userAddress: string,
  ) => Promise<readonly string[]>;
}

// The bulk read is cheap per pair, so the cap only exists to bound a pathological
// factory; keep it generous.
const DEFAULT_MAX_PAIRS = 10_000;
const DEFAULT_BATCH_SIZE = 190;

// storage-key symbols, validated against the contracts' simulation footprints
const PAIR_INDEX_SYMBOL = "PairAddressesNIndexed";
const BALANCE_SYMBOL = "Balance";

export async function discoverSoroswapPositions(
  server: rpc.Server,
  network: NetworkConfig,
  userAddress: string,
  deps: SoroswapDiscoveryDeps = {},
): Promise<readonly SoroswapPositionSummary[]> {
  const read = deps.simulateRead ?? simulateRead;
  const maxPairs = deps.maxPairs ?? DEFAULT_MAX_PAIRS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const factoryId = getSoroswapFactoryId(network);

  const lenRet = await read(server, factoryId, "all_pairs_length", [], userAddress, network);
  const pairCount = fromScValU32(lenRet.retval);
  if (pairCount === 0) return [];
  if (pairCount > maxPairs) {
    throw new Error(
      `SoroswapFactory reports ${pairCount} pairs, over the ${maxPairs} enumeration cap; ` +
        `refusing to probe every pair. Close Soroswap LP positions manually if needed.`,
    );
  }

  const loadPairAddresses =
    deps.loadPairAddresses ??
    ((s: rpc.Server, fId: string, count: number) =>
      resolvePairAddresses(s, network, fId, count, batchSize, read, userAddress));
  const loadHeldPairs =
    deps.loadHeldPairs ??
    ((s: rpc.Server, addrs: readonly string[], user: string) =>
      filterPairsWithBalance(s, addrs, user, batchSize));

  // 1) resolve every pair address from factory storage in bulk
  const pairAddresses = await loadPairAddresses(server, factoryId, pairCount);

  // 2) bulk-filter to the pairs where the user actually has an LP balance entry
  const candidates = await loadHeldPairs(server, pairAddresses, userAddress);

  // 3) authoritatively confirm each candidate (there are usually 0-3) and read its
  //    tokens. simulate is the source of truth for the share amount here.
  const positions: SoroswapPositionSummary[] = [];
  for (const pairId of candidates) {
    const balRet = await read(server, pairId, "balance", [scvAddress(userAddress)], userAddress, network);
    const shares = fromScValI128(balRet.retval);
    if (shares <= 0n) continue;
    const [t0Ret, t1Ret] = await Promise.all([
      read(server, pairId, "token_0", [], userAddress, network),
      read(server, pairId, "token_1", [], userAddress, network),
    ]);
    positions.push({
      pair: { tokenA: fromScValAddress(t0Ret.retval), tokenB: fromScValAddress(t1Ret.retval) },
      shareBalance: shares,
    });
  }
  return positions;
}

// Reads Address(pair) for indices 0..pairCount-1 from the factory's persistent
// storage via getLedgerEntries. Any index the bulk read doesn't return (unexpected,
// but possible if an entry were archived) falls back to the authoritative
// all_pairs(i) simulate so enumeration is never silently short.
async function resolvePairAddresses(
  server: rpc.Server,
  network: NetworkConfig,
  factoryId: string,
  pairCount: number,
  batchSize: number,
  read: typeof simulateRead,
  userAddress: string,
): Promise<readonly string[]> {
  const factoryScAddress = new Address(factoryId).toScAddress();
  const keys: xdr.LedgerKey[] = [];
  for (let i = 0; i < pairCount; i += 1) {
    keys.push(
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: factoryScAddress,
          key: xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol(PAIR_INDEX_SYMBOL),
            xdr.ScVal.scvU32(i),
          ]),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      ),
    );
  }

  const byIndex = new Map<number, string>();
  const batches = await Promise.all(
    chunk(keys, batchSize).map((c) => server.getLedgerEntries(...c)),
  );
  for (const resp of batches) {
    for (const entry of resp.entries) {
      const cd = entry.key.contractData();
      const keyVec = cd.key().vec();
      if (!keyVec || keyVec.length !== 2 || keyVec[1]!.switch().name !== "scvU32") continue;
      const index = keyVec[1]!.u32();
      byIndex.set(index, fromScValAddress(entry.val.contractData().val()));
    }
  }

  const addresses: string[] = [];
  for (let i = 0; i < pairCount; i += 1) {
    const found = byIndex.get(i);
    if (found !== undefined) {
      addresses.push(found);
    } else {
      // bulk read missed this index; fall back to the authoritative resolver
      const ret = await read(server, factoryId, "all_pairs", [scvU32(i)], userAddress, network);
      addresses.push(fromScValAddress(ret.retval));
    }
  }
  return addresses;
}

// Returns the subset of pairs for which the user has a persistent Balance entry.
// getLedgerEntries returns only entries that exist, so a returned entry means a
// (possibly non-zero) balance; absence means definitively zero. The exact amount
// is confirmed by simulate in the caller.
async function filterPairsWithBalance(
  server: rpc.Server,
  pairAddresses: readonly string[],
  userAddress: string,
  batchSize: number,
): Promise<readonly string[]> {
  const userScVal = new Address(userAddress).toScVal();
  const keys = pairAddresses.map((pairId) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(pairId).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(BALANCE_SYMBOL), userScVal]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ),
  );

  const held: string[] = [];
  const batches = await Promise.all(
    chunk(keys, batchSize).map((c) => server.getLedgerEntries(...c)),
  );
  for (const resp of batches) {
    for (const entry of resp.entries) {
      held.push(Address.fromScAddress(entry.key.contractData().contract()).toString());
    }
  }
  return held;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
