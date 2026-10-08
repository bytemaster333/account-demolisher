// aquarius reward gauges: extra rewards a third party schedules on a pool
// (router pool_gauge_schedule_reward), paid in their own token by a gauge
// contract the pool keeps under ["RewardGaugesMap"] (reward token -> gauge).
//
// the router's claim does not pay them. on mainnet 2026-10-08, GDLOF7... in
// stable pool CCNXGPE4... was owed 1,126,439,834 stroops of XLM by its gauge:
// router claim paid 0 AQUA and no XLM, while pool.gauges_claim(user) paid the
// XLM straight from the gauge. a close that only runs the router claim leaves
// these behind. 12 of the 365 mainnet pools had gauges that day, two of them
// still paying.

import {
  Contract,
  TransactionBuilder,
  xdr,
  type rpc,
  type Transaction,
  type TransactionSource,
} from "@stellar/stellar-sdk";

import { readInstanceStorage, storageValue } from "@/lib/adapters/aquarius/client";
import { readAquariusPoolAddress } from "@/lib/adapters/aquarius/pools";
import type { NetworkConfig } from "@/lib/config/networks";
import { mapConcurrent } from "@/lib/soroban/concurrency";
import { address as scvAddress, fromScValAddress, fromScValI128 } from "@/lib/soroban/scval";
import { assembleSubmittable, simulateRead, SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";

export interface PendingGaugeReward {
  readonly poolAddress: string;
  // the token the gauge pays
  readonly token: string;
  readonly amount: bigint;
}

const GAUGE_READ_CONCURRENCY = 4;

// what each pool's gauges owe the user right now, for every pool and token with
// a non-zero reward. a pool with no gauges in its instance storage is not
// asked (pool code without gauges can't owe any). any failed read throws: an
// unread reward must not pass as none.
export async function readGaugeRewards(
  server: rpc.Server,
  network: NetworkConfig,
  user: string,
  poolAddresses: readonly string[],
): Promise<PendingGaugeReward[]> {
  const pools = [...new Set(poolAddresses)];
  if (pools.length === 0) return [];
  const storage = await readInstanceStorage(server, pools);
  const gauged = pools.filter((pool) => {
    const map = storageValue(storage.get(pool)!, "RewardGaugesMap");
    return map !== undefined && map.type === "scvMap" && (map.map?.length ?? 0) > 0;
  });
  const owed = await mapConcurrent(gauged, GAUGE_READ_CONCURRENCY, async (pool) => {
    const { retval } = await simulateRead(
      server,
      pool,
      "gauges_get_reward_info",
      [scvAddress(user)],
      user,
      network,
    );
    return decodeRewardInfo(pool, retval);
  });
  return owed.flat().filter((r) => r.amount > 0n);
}

// { reward token: { expired_at, tps, user_reward } }
function decodeRewardInfo(pool: string, v: xdr.ScVal): PendingGaugeReward[] {
  if (v.type !== "scvMap" || v.map === null) {
    throw new TypeError(`Aquarius pool ${pool}: gauges_get_reward_info did not return a map`);
  }
  return v.map.map((entry) => {
    const token = fromScValAddress(entry.key);
    if (entry.val.type !== "scvMap" || entry.val.map === null) {
      throw new TypeError(
        `Aquarius pool ${pool}: gauges_get_reward_info for ${token} is not a map`,
      );
    }
    const reward = entry.val.map.find(
      (e) => e.key.type === "scvSymbol" && e.key.sym.toString() === "user_reward",
    );
    if (reward === undefined) {
      throw new TypeError(
        `Aquarius pool ${pool}: gauges_get_reward_info for ${token} has no user_reward`,
      );
    }
    return { poolAddress: pool, token, amount: fromScValI128(reward.val) };
  });
}

export interface ClaimGaugeRewardsArgs {
  readonly user: string;
  readonly poolAddress: string;
  // the pool's token set and index, as the router keys it
  readonly tokens: readonly string[];
  readonly poolIndex: string;
  readonly sourceAccount: TransactionSource;
  readonly network: NetworkConfig;
}

export interface GaugeClaimDeps {
  readonly server: rpc.Server;
  readonly assemble?: typeof assembleSubmittable;
}

// build an unsigned pool.gauges_claim(user), which pays every gauge reward the
// user has in that pool. pools are permissionless and not on the allow-list,
// so the address is checked against the router's own get_pools before anything
// is built; the call runs on the router's pool or not at all. its simulation
// on mainnet records one source-account auth entry, gauges_claim(user) on the
// pool, with no sub-invocations; the gauge pays from its own balance.
export async function claimGaugeRewards(
  args: ClaimGaugeRewardsArgs,
  deps: GaugeClaimDeps,
): Promise<Transaction> {
  const listed = await readAquariusPoolAddress(
    deps.server,
    args.network,
    args.tokens,
    args.poolIndex,
    args.user,
  );
  if (listed !== args.poolAddress) {
    throw new Error(
      `${args.poolAddress} is not the Aquarius pool the router lists for these tokens ` +
        `(it lists ${listed}), refusing to build gauges_claim on it`,
    );
  }
  const tx = new TransactionBuilder(args.sourceAccount, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: args.network.passphrase,
  })
    .addOperation(new Contract(listed).call("gauges_claim", scvAddress(args.user)))
    .setTimeout(300)
    .build();
  const prepared = await (deps.assemble ?? assembleSubmittable)(deps.server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error("Aquarius gauges_claim: assembling returned a FeeBumpTransaction unexpectedly");
  }
  return prepared;
}
