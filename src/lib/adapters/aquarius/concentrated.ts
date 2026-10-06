// on-chain discovery of aquarius concentrated-liquidity positions.
//
// a concentrated position is a set of tick ranges held in the pool contract
// itself, not a share-token balance, so the router's share_id/balance path and
// the router event scan never see it (deposit_position goes straight to the
// pool). instead we read the pool's own per-user storage across every pinned
// concentrated pool in one batched getLedgerEntries call, then confirm each hit
// with the pool's read functions. the key layouts were taken from the simulation
// footprints of get_user_position_snapshot and get_user_reward on mainnet pool
// CBBMQBNH...:
//   pool  persistent  Vec[Symbol("User"), Address(user)]            position ranges
//   pool  persistent  Vec[Symbol("UserRewardData"), Address(user)]  reward accrual
// getLedgerEntries omits only keys that do not exist (stellar-rpc
// internal/ledgerentries skips LedgerEntryStateNotFound and returns archived
// entries with liveUntilLedgerSeq 0), so a missing key means no position.

import { Address, xdr, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import {
  address as scvAddress,
  fromScValI32,
  fromScValU128,
  u128 as scvU128,
} from "@/lib/soroban/scval";
import { simulateRead } from "@/lib/soroban/simulate";
import {
  getConcentratedPools,
  type AquariusConcentratedPool,
} from "@/lib/adapters/aquarius/concentrated-pools";

export interface AquariusConcentratedRange {
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
}

export interface AquariusConcentratedPosition {
  readonly poolAddress: string;
  readonly poolIndex: string;
  readonly tokens: readonly string[];
  // ranges with non-zero liquidity, each needs one withdraw_position
  readonly ranges: readonly AquariusConcentratedRange[];
  // uncollected swap fees per token (claim_all_position_fees pays them)
  readonly pendingFees: readonly bigint[];
  // accrued AQUA rewards (router.claim with the pool's tokens and index pays them)
  readonly pendingReward: bigint;
}

export interface ConcentratedDiscoveryDeps {
  readonly simulateRead?: typeof simulateRead;
  // ledger keys per getLedgerEntries call (the rpc accepts at most 200)
  readonly batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 190;
const USER_KEY_SYMBOL = "User";
const USER_REWARD_KEY_SYMBOL = "UserRewardData";

export function concentratedUserKey(pool: string, user: string, symbol: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(pool).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(symbol), new Address(user).toScVal()]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

// returns every pinned concentrated pool where the user holds liquidity, unpaid
// fees or unclaimed rewards. throws (listing each pool) if any read fails, so a
// caller never mistakes an unreadable pool for "no position".
export async function discoverConcentratedPositions(
  server: rpc.Server,
  network: NetworkConfig,
  userAddress: string,
  deps: ConcentratedDiscoveryDeps = {},
): Promise<AquariusConcentratedPosition[]> {
  const pools = getConcentratedPools(network);
  if (pools.length === 0) return [];
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  const keys: xdr.LedgerKey[] = [];
  for (const pool of pools) {
    keys.push(concentratedUserKey(pool.address, userAddress, USER_KEY_SYMBOL));
    keys.push(concentratedUserKey(pool.address, userAddress, USER_REWARD_KEY_SYMBOL));
  }
  const touched = new Set<string>();
  for (let i = 0; i < keys.length; i += batchSize) {
    const resp = await server.getLedgerEntries(...keys.slice(i, i + batchSize));
    for (const entry of resp.entries) {
      const cd = xdr.expectUnionVariant(entry.key, "contractData").contractData;
      touched.add(Address.fromScAddress(cd.contract).toString());
    }
  }

  const positions: AquariusConcentratedPosition[] = [];
  const failures: string[] = [];
  for (const pool of pools) {
    if (!touched.has(pool.address)) continue;
    try {
      const position = await readConcentratedPosition(server, network, pool, userAddress, deps);
      if (
        position.ranges.length > 0 ||
        position.pendingReward > 0n ||
        position.pendingFees.some((f) => f > 0n)
      ) {
        positions.push(position);
      }
    } catch (e) {
      failures.push(`${pool.address}: ${errorMessage(e)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Aquarius concentrated pools could not be read, so a position there cannot be ruled out (${failures.join("; ")})`,
    );
  }
  return positions;
}

// reads one pool's position for the user: the tick ranges from the snapshot,
// each range's live liquidity, unpaid fees and accrued rewards
export async function readConcentratedPosition(
  server: rpc.Server,
  network: NetworkConfig,
  pool: AquariusConcentratedPool,
  userAddress: string,
  deps: ConcentratedDiscoveryDeps = {},
): Promise<AquariusConcentratedPosition> {
  const read = deps.simulateRead ?? simulateRead;
  const user = scvAddress(userAddress);
  const call = (fn: string, args: xdr.ScVal[]) =>
    read(server, pool.address, fn, args, userAddress, network).then((r) => r.retval);

  const snapshot = await call("get_user_position_snapshot", [user]);
  const ranges: AquariusConcentratedRange[] = [];
  for (const r of decodeSnapshotRanges(snapshot)) {
    const position = await call("get_position", [
      user,
      xdr.ScVal.scvI32(r.tickLower),
      xdr.ScVal.scvI32(r.tickUpper),
    ]);
    const liquidity = decodeStructU128(position, "liquidity", "get_position");
    if (liquidity > 0n) ranges.push({ ...r, liquidity });
  }
  const pendingFees = decodeU128Vec(
    await call("get_all_position_fees", [user]),
    "get_all_position_fees",
  );
  const pendingReward = fromScValU128(await call("get_user_reward", [user]));
  return {
    poolAddress: pool.address,
    poolIndex: pool.poolIndex,
    tokens: pool.tokens,
    ranges,
    pendingFees,
    pendingReward,
  };
}

// estimate_withdraw_position(owner, tick_lower, tick_upper, amount) -> Vec<u128>,
// the per-token amounts a withdraw of `liquidity` pays out at current state
export async function estimateConcentratedWithdraw(
  server: rpc.Server,
  network: NetworkConfig,
  args: {
    readonly poolAddress: string;
    readonly user: string;
    readonly tickLower: number;
    readonly tickUpper: number;
    readonly liquidity: bigint;
  },
  deps: ConcentratedDiscoveryDeps = {},
): Promise<bigint[]> {
  const read = deps.simulateRead ?? simulateRead;
  const { retval } = await read(
    server,
    args.poolAddress,
    "estimate_withdraw_position",
    [
      scvAddress(args.user),
      xdr.ScVal.scvI32(args.tickLower),
      xdr.ScVal.scvI32(args.tickUpper),
      scvU128(args.liquidity),
    ],
    args.user,
    network,
  );
  return decodeU128Vec(retval, "estimate_withdraw_position");
}

function decodeSnapshotRanges(v: xdr.ScVal): { tickLower: number; tickUpper: number }[] {
  const ranges = structField(v, "ranges", "get_user_position_snapshot");
  if (ranges.type !== "scvVec" || ranges.vec === null) {
    throw new TypeError("get_user_position_snapshot: ranges is not a vec");
  }
  return ranges.vec.map((r) => ({
    tickLower: fromScValI32(structField(r, "tick_lower", "PositionRange")),
    tickUpper: fromScValI32(structField(r, "tick_upper", "PositionRange")),
  }));
}

function decodeStructU128(v: xdr.ScVal, field: string, where: string): bigint {
  return fromScValU128(structField(v, field, where));
}

function structField(v: xdr.ScVal, field: string, where: string): xdr.ScVal {
  if (v.type !== "scvMap" || v.map === null) {
    throw new TypeError(`${where}: expected a struct (scvMap), got ${v.type}`);
  }
  for (const entry of v.map) {
    if (entry.key.type === "scvSymbol" && entry.key.sym.toString() === field) return entry.val;
  }
  throw new TypeError(`${where}: struct has no field ${field}`);
}

function decodeU128Vec(v: xdr.ScVal, where: string): bigint[] {
  if (v.type !== "scvVec" || v.vec === null) {
    throw new TypeError(`${where}: expected a vec of u128, got ${v.type}`);
  }
  return v.vec.map((x) => fromScValU128(x));
}
