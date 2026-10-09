// aquarius reward gauges: extra rewards a third party schedules on a pool
// (router pool_gauge_schedule_reward), paid in their own token by a gauge
// contract the pool keeps under ["RewardGaugesMap"] (reward token -> gauge).
//
// the router's claim does not pay them. on mainnet 2026-10-08, GDLOF7... in
// stable pool CCNXGPE4... was owed 1,126,439,834 stroops of XLM by its gauge:
// router claim paid 0 AQUA and no XLM, while pool.gauges_claim(user) paid the
// XLM straight from the gauge. a close that only ran the router claim would
// leave these behind, so the plan claims them with gauges_claim ahead of the
// pool's withdraw. 12 of the 365 mainnet pools had gauges that day, two of them
// still paying. a claim with nothing owed runs and pays 0 (GCUMSNS7... in the
// same pool, same day).
//
// gauges_claim runs every gauge of the pool, and each one transfers what it
// owes, zero included. a zero transfer of a classic asset's SAC into an account
// with no line for it traps the whole claim with Error(Contract, #13), "trustline
// entry is missing" (testnet pool CCSXYUVL... on 2026-10-09: an AQUA gauge owed
// the user, its DAI gauge owed 0 and trapped). so the claim needs a usable line
// for every token the pool keeps a gauge for, owed or not.

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
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { NetworkConfig } from "@/lib/config/networks";
import { mapConcurrent } from "@/lib/soroban/concurrency";
import { address as scvAddress, fromScValAddress, fromScValI128 } from "@/lib/soroban/scval";
import { assembleSubmittable, simulateRead, SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import {
  describeUnfixableGap,
  isUnfixableGap,
  type ExitTrustlineGap,
  type UnfixableExitTrustlineGap,
} from "@/lib/soroban/stellar-asset";
import { stroopsToTrimmedDecimal } from "@/lib/stellar/amount";
import { ledgerMaxTime } from "@/lib/stellar/ledger-clock";
import { shortAddress } from "@/lib/safe-display";

export interface PendingGaugeReward {
  readonly poolAddress: string;
  // the token the gauge pays
  readonly token: string;
  readonly amount: bigint;
}

const GAUGE_READ_CONCURRENCY = 4;
const GAUGE_CLAIM_TIMEOUT_SECONDS = 300;

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
  const pools = await readPoolGauges(server, network, user, poolAddresses);
  return pools.flatMap((p) => p.rewards).filter((r) => r.amount > 0n);
}

interface PoolGauges {
  readonly poolAddress: string;
  // every token the pool keeps a gauge for, in its RewardGaugesMap order
  readonly gaugeTokens: readonly string[];
  // what each of those gauges owes the user, zero included
  readonly rewards: readonly PendingGaugeReward[];
}

// the gauges of each pool that has any, with what each owes the user. the
// reward info must name only tokens the pool keeps a gauge for: gauges_claim
// runs the gauges in RewardGaugesMap, so a reward listed anywhere else is not
// one the claim pays, and the plan is not built on that guess.
async function readPoolGauges(
  server: rpc.Server,
  network: NetworkConfig,
  user: string,
  poolAddresses: readonly string[],
): Promise<PoolGauges[]> {
  const pools = [...new Set(poolAddresses)];
  if (pools.length === 0) return [];
  const storage = await readInstanceStorage(server, pools);
  const gauged = pools.flatMap((pool) => {
    const tokens = gaugeMapTokens(pool, storageValue(storage.get(pool)!, "RewardGaugesMap"));
    return tokens.length > 0 ? [{ pool, tokens }] : [];
  });
  return mapConcurrent(gauged, GAUGE_READ_CONCURRENCY, async ({ pool, tokens }) => {
    const { retval } = await simulateRead(
      server,
      pool,
      "gauges_get_reward_info",
      [scvAddress(user)],
      user,
      network,
    );
    const rewards = decodeRewardInfo(pool, retval);
    const stray = rewards.filter((r) => !tokens.includes(r.token)).map((r) => r.token);
    if (stray.length > 0) {
      throw new TypeError(
        `Aquarius pool ${pool}: gauges_get_reward_info names ${stray.join(", ")}, which the ` +
          "pool keeps no gauge for",
      );
    }
    return { poolAddress: pool, gaugeTokens: tokens, rewards };
  });
}

// the reward tokens of { reward token: gauge }. no map, or an empty one, is a
// pool without gauges; a value of any other shape throws
function gaugeMapTokens(pool: string, map: xdr.ScVal | undefined): string[] {
  if (map === undefined) return [];
  if (map.type !== "scvMap") {
    throw new TypeError(`Aquarius pool ${pool}: RewardGaugesMap is a ${map.type}, not a map`);
  }
  return (map.map ?? []).map((entry) => fromScValAddress(entry.key));
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

// one pool whose gauges owe the user, keyed the way claimGaugeRewards needs it
export interface PoolGaugeRewards {
  readonly poolAddress: string;
  readonly tokens: readonly string[];
  readonly poolIndex: string;
  readonly rewards: readonly { readonly token: string; readonly amount: bigint }[];
  // every token the pool keeps a gauge for, owed or not. the claim pays each of
  // them (zero included), so each needs a line that can take it
  readonly gaugeTokens: readonly string[];
}

// the gauge rewards owed in every aquarius pool the user has a position in:
// each standard pool with shares (its address resolved through the router) and
// each concentrated position. a pool the user already left is not in the
// positions, so a reward still owed there is not found here.
export async function readPositionGaugeRewards(
  server: rpc.Server,
  network: NetworkConfig,
  user: string,
  positions: Pick<ProtocolPositions, "aquarius" | "aquariusConcentrated">,
): Promise<PoolGaugeRewards[]> {
  const standard = positions.aquarius.filter((p) => p.shareBalance > 0n);
  const addresses = await mapConcurrent(standard, GAUGE_READ_CONCURRENCY, (p) =>
    readAquariusPoolAddress(server, network, p.tokens, p.poolIndex, user),
  );
  const pools = [
    ...standard.map((p, i) => ({
      poolAddress: addresses[i]!,
      tokens: p.tokens,
      poolIndex: p.poolIndex,
    })),
    ...positions.aquariusConcentrated.map((p) => ({
      poolAddress: p.poolAddress,
      tokens: p.tokens,
      poolIndex: p.poolIndex,
    })),
  ];
  const gauges = await readPoolGauges(
    server,
    network,
    user,
    pools.map((p) => p.poolAddress),
  );
  const out: PoolGaugeRewards[] = [];
  for (const pool of pools) {
    if (out.some((o) => o.poolAddress === pool.poolAddress)) continue;
    const read = gauges.find((g) => g.poolAddress === pool.poolAddress);
    if (read === undefined) continue;
    const rewards = read.rewards
      .filter((r) => r.amount > 0n)
      .map((r) => ({ token: r.token, amount: r.amount }));
    if (rewards.length > 0) out.push({ ...pool, rewards, gaugeTokens: read.gaugeTokens });
  }
  return out;
}

// every token the gauges pay, in the order the pools list them
export function gaugeRewardTokens(owed: readonly PoolGaugeRewards[]): readonly string[] {
  const out = new Set<string>();
  for (const pool of owed) {
    for (const reward of pool.rewards) if (reward.amount > 0n) out.add(reward.token);
  }
  return [...out];
}

// every token a claim of these pools transfers, owed or not: the tokens whose
// lines have to be there before the claims run
export function gaugeLineTokens(pools: readonly PoolGaugeRewards[]): readonly string[] {
  const out = new Set<string>();
  for (const pool of pools) {
    for (const token of pool.gaugeTokens) out.add(token);
    for (const reward of pool.rewards) out.add(reward.token);
  }
  return [...out];
}

// a pool whose gauge claim the close leaves out, and the line that keeps it out
export interface ForfeitedGaugeClaim {
  readonly pool: PoolGaugeRewards;
  readonly blockedBy: readonly UnfixableExitTrustlineGap[];
}

// splits the pools to claim from the ones whose claim would trap: a gauge token
// whose line is missing is opened ahead of the claim, but one the account can't
// hold (the issuer authorizes every new line, the issuer is gone, or the line it
// has is not authorized) traps the claim whatever the gauge owes. that claim is
// left out and its rewards are forfeited, so a gauge never blocks the close.
export function settleGaugeClaims(
  pools: readonly PoolGaugeRewards[],
  gaps: readonly ExitTrustlineGap[],
): {
  readonly claimable: readonly PoolGaugeRewards[];
  readonly forfeited: readonly ForfeitedGaugeClaim[];
} {
  const claimable: PoolGaugeRewards[] = [];
  const forfeited: ForfeitedGaugeClaim[] = [];
  for (const pool of pools) {
    const paid = new Set([...pool.gaugeTokens, ...pool.rewards.map((r) => r.token)]);
    const blockedBy = gaps.filter(
      (g): g is UnfixableExitTrustlineGap => paid.has(g.contractId) && isUnfixableGap(g),
    );
    if (blockedBy.length === 0) claimable.push(pool);
    else forfeited.push({ pool, blockedBy });
  }
  return { claimable, forfeited };
}

// what a gauge owes, in words. XLM has 7 decimals; any other token's decimals
// are not read, so its amount is given in base units.
export function gaugeRewardLabel(
  reward: { readonly token: string; readonly amount: bigint },
  xlmSac: string | undefined,
): string {
  if (xlmSac !== undefined && reward.token === xlmSac) {
    return `${stroopsToTrimmedDecimal(reward.amount)} XLM`;
  }
  return `${reward.amount.toString()} base units of token ${shortAddress(reward.token)}`;
}

// the review's note for a gauge claim left out: the pool, what its gauges owe,
// and why the claim can't run
export function gaugeForfeitNotice(
  forfeit: ForfeitedGaugeClaim,
  xlmSac: string | undefined,
): string {
  const owed = forfeit.pool.rewards.map((r) => gaugeRewardLabel(r, xlmSac)).join(" and ");
  const causes = forfeit.blockedBy.map((g) => describeUnfixableGap(g).cause).join(" ");
  return (
    `The reward gauges of Aquarius pool ${shortAddress(forfeit.pool.poolAddress)} owe this ` +
    `account ${owed}. Their claim pays every gauge of the pool, and one of them pays an asset ` +
    `this account can't receive. ${causes} The close leaves that claim out, so closing the ` +
    "account forfeits these rewards."
  );
}

export interface ClaimGaugeRewardsArgs {
  readonly user: string;
  readonly poolAddress: string;
  // the pool's token set and index, as the router keys it
  readonly tokens: readonly string[];
  readonly poolIndex: string;
  readonly sourceAccount: TransactionSource;
  // close time (unix seconds) of the latest ledger; the tx expires five minutes
  // after it
  readonly ledgerCloseTime: number;
  readonly network: NetworkConfig;
}

export interface GaugeClaimDeps {
  readonly server: rpc.Server;
  readonly assemble?: typeof assembleSubmittable;
}

export interface BuiltGaugeClaim {
  readonly transaction: Transaction;
  // the pool the router listed for the tokens and index when this was built
  readonly routerPool: string;
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
): Promise<BuiltGaugeClaim> {
  const maxTime = ledgerMaxTime(args.ledgerCloseTime, GAUGE_CLAIM_TIMEOUT_SECONDS);
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
    .setTimebounds(0, maxTime)
    .build();
  const prepared = await (deps.assemble ?? assembleSubmittable)(deps.server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error("Aquarius gauges_claim: assembling returned a FeeBumpTransaction unexpectedly");
  }
  return { transaction: prepared, routerPool: listed };
}
