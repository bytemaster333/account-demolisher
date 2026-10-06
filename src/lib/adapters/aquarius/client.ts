// aquarius client: router calls (withdraw, claim, swap_chained) and direct calls on
// pinned concentrated pools (withdraw_position, claim_all_position_fees)
import {
  Contract,
  TransactionBuilder,
  rpc,
  xdr,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  getAllowlistForNetwork,
  isAllowedRootTarget,
  type AllowedContract,
} from "@/lib/config/contracts";
import type { NetworkConfig } from "@/lib/config/networks";
import { findConcentratedPool } from "@/lib/adapters/aquarius/concentrated-pools";
import { address as scvAddress, fromScValU128, u128, vec as scvVec } from "@/lib/soroban/scval";
import { assembleSubmittable, simulateRead, SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";

// five-minute timeout
const MAX_TIMEOUT_SECONDS = 300;

// soroban budget cap on swap_chained hops
export const AQUARIUS_SWAP_CHAINED_MAX_HOPS = 4;

const POOL_INDEX_LENGTH_BYTES = 32;

// thrown when a chain exceeds the 4-hop cap
export class AquariusBudgetError extends Error {
  readonly hops: number;
  readonly limit: number;
  constructor(hops: number) {
    super(
      `Aquarius swap_chained: chain length ${hops} exceeds the ${AQUARIUS_SWAP_CHAINED_MAX_HOPS}-hop Soroban budget cap. ` +
        `Re-route via a shorter chain or skip Aquarius for this leg.`,
    );
    this.name = "AquariusBudgetError";
    this.hops = hops;
    this.limit = AQUARIUS_SWAP_CHAINED_MAX_HOPS;
  }
}

export interface WithdrawArgs {
  readonly user: string;
  readonly tokens: readonly string[];
  readonly poolIndex: Uint8Array;
  readonly shareAmount: bigint;
  readonly minAmounts: readonly bigint[];
  readonly sourceAccount: Horizon.AccountResponse;
  readonly network: NetworkConfig;
}

export interface ClaimArgs {
  readonly user: string;
  // the pool's token set, in the router's sorted order. The router resolves a
  // pool by (tokens, pool_index) because a pool_index is only unique within one
  // token set. Typed optional because older plan metadata did not carry it; a
  // claim without it is refused rather than sent as a call that can never work.
  readonly tokens?: readonly string[];
  readonly poolIndex: Uint8Array;
  readonly sourceAccount: Horizon.AccountResponse;
  readonly network: NetworkConfig;
}

// one hop in swap_chained, matches the router's SwapChainStep struct
export interface SwapChainStep {
  readonly poolIndex: Uint8Array;
  readonly tokens: readonly string[];
  readonly tokenOut: string;
}

export interface SwapChainedArgs {
  readonly user: string;
  readonly swapsChain: readonly SwapChainStep[];
  readonly tokenIn: string;
  readonly inAmount: bigint;
  readonly outMin: bigint;
  readonly sourceAccount: Horizon.AccountResponse;
  readonly network: NetworkConfig;
}

export interface AquariusClientDeps {
  readonly server: rpc.Server;
  readonly assemble?: typeof assembleSubmittable;
}

// build an unsigned withdraw tx
export async function withdraw(args: WithdrawArgs, deps: AquariusClientDeps): Promise<Transaction> {
  const routerId = getAquariusRouterId(args.network);
  if (!isAllowedRootTarget(routerId, args.network)) {
    throw new Error(
      `AquariusAmmRouter ${routerId} is not on the ${args.network.id} allow-list, refusing to build withdraw`,
    );
  }
  validatePoolIndex(args.poolIndex);
  validateNonNegativeU128("shareAmount", args.shareAmount);
  if (args.tokens.length !== args.minAmounts.length) {
    throw new RangeError(
      `Aquarius withdraw: tokens.length (${args.tokens.length}) must equal minAmounts.length (${args.minAmounts.length})`,
    );
  }
  args.minAmounts.forEach((v, i) => validateNonNegativeU128(`minAmounts[${i}]`, v));

  const callArgs: xdr.ScVal[] = [
    scvAddress(args.user),
    scvVec(args.tokens.map((t) => scvAddress(t))),
    u128Bytes(args.poolIndex),
    u128(args.shareAmount),
    scvVec(args.minAmounts.map((m) => u128(m))),
  ];

  return buildAndAssemble(routerId, "withdraw", callArgs, args.sourceAccount, args.network, deps);
}

// build an unsigned claim tx for AQUA rewards
export async function claim(args: ClaimArgs, deps: AquariusClientDeps): Promise<Transaction> {
  const routerId = getAquariusRouterId(args.network);
  if (!isAllowedRootTarget(routerId, args.network)) {
    throw new Error(
      `AquariusAmmRouter ${routerId} is not on the ${args.network.id} allow-list, refusing to build claim`,
    );
  }
  validatePoolIndex(args.poolIndex);
  if (args.tokens === undefined || args.tokens.length === 0) {
    throw new RangeError(
      "Aquarius claim: the pool's token set is required (router claim takes user, tokens, pool_index)",
    );
  }

  // spec: claim(user: Address, tokens: Vec<Address>, pool_index: BytesN<32>) -> u128
  const callArgs: xdr.ScVal[] = [
    scvAddress(args.user),
    scvVec(args.tokens.map((t) => scvAddress(t))),
    u128Bytes(args.poolIndex),
  ];

  return buildAndAssemble(routerId, "claim", callArgs, args.sourceAccount, args.network, deps);
}

// router.get_user_reward(user, tokens, pool_index) -> u128: the AQUA a claim
// would pay right now, for gating a claim step and for the merge-time reprobe
export async function getUserReward(
  server: rpc.Server,
  args: {
    readonly user: string;
    readonly tokens: readonly string[];
    readonly poolIndex: Uint8Array;
    readonly network: NetworkConfig;
  },
): Promise<bigint> {
  validatePoolIndex(args.poolIndex);
  const { retval } = await simulateRead(
    server,
    getAquariusRouterId(args.network),
    "get_user_reward",
    [
      scvAddress(args.user),
      scvVec(args.tokens.map((t) => scvAddress(t))),
      u128Bytes(args.poolIndex),
    ],
    args.user,
    args.network,
  );
  return fromScValU128(retval);
}

export interface WithdrawConcentratedArgs {
  readonly user: string;
  readonly poolAddress: string;
  readonly tickLower: number;
  readonly tickUpper: number;
  // the range's full liquidity (get_position(...).liquidity)
  readonly liquidity: bigint;
  // per-token floors in the pool's token order
  readonly minAmounts: readonly bigint[];
  readonly sourceAccount: Horizon.AccountResponse;
  readonly network: NetworkConfig;
}

// build an unsigned withdraw_position(owner, tick_lower, tick_upper, amount,
// min_amounts) against a pinned concentrated pool. it is called on the pool
// directly: the router's withdraw only knows full-range shares and answers #2118
// (PositionNotFound) for a tick-range position.
export async function withdrawConcentratedPosition(
  args: WithdrawConcentratedArgs,
  deps: AquariusClientDeps,
): Promise<Transaction> {
  const pool = requirePinnedConcentratedPool(args.poolAddress, args.network);
  validateTick("tickLower", args.tickLower);
  validateTick("tickUpper", args.tickUpper);
  if (args.tickLower >= args.tickUpper) {
    throw new RangeError(
      `Aquarius withdraw_position: tickLower (${args.tickLower}) must be below tickUpper (${args.tickUpper})`,
    );
  }
  validateNonNegativeU128("liquidity", args.liquidity);
  if (args.liquidity === 0n) {
    throw new RangeError("Aquarius withdraw_position: liquidity must be > 0");
  }
  if (args.minAmounts.length !== pool.tokens.length) {
    throw new RangeError(
      `Aquarius withdraw_position: minAmounts.length (${args.minAmounts.length}) must equal the pool's token count (${pool.tokens.length})`,
    );
  }
  args.minAmounts.forEach((v, i) => validateNonNegativeU128(`minAmounts[${i}]`, v));

  const callArgs: xdr.ScVal[] = [
    scvAddress(args.user),
    xdr.ScVal.scvI32(args.tickLower),
    xdr.ScVal.scvI32(args.tickUpper),
    u128(args.liquidity),
    scvVec(args.minAmounts.map((m) => u128(m))),
  ];
  return buildAndAssemble(
    pool.address,
    "withdraw_position",
    callArgs,
    args.sourceAccount,
    args.network,
    deps,
  );
}

// build an unsigned claim_all_position_fees(owner): pays the swap fees every
// range of the owner has earned and not yet collected
export async function claimConcentratedFees(
  args: {
    readonly user: string;
    readonly poolAddress: string;
    readonly sourceAccount: Horizon.AccountResponse;
    readonly network: NetworkConfig;
  },
  deps: AquariusClientDeps,
): Promise<Transaction> {
  const pool = requirePinnedConcentratedPool(args.poolAddress, args.network);
  return buildAndAssemble(
    pool.address,
    "claim_all_position_fees",
    [scvAddress(args.user)],
    args.sourceAccount,
    args.network,
    deps,
  );
}

function requirePinnedConcentratedPool(address: string, network: NetworkConfig) {
  const pool = findConcentratedPool(address, network);
  if (pool === undefined || !isAllowedRootTarget(address, network)) {
    throw new Error(
      `Aquarius pool ${address} is not a pinned ${network.id} concentrated pool, refusing to build a call on it`,
    );
  }
  return pool;
}

// build an unsigned swap_chained tx. throws AquariusBudgetError when too many hops
export async function swapChained(
  args: SwapChainedArgs,
  deps: AquariusClientDeps,
): Promise<Transaction> {
  if (args.swapsChain.length === 0) {
    throw new RangeError("Aquarius swap_chained: swapsChain must contain at least one hop");
  }
  if (args.swapsChain.length > AQUARIUS_SWAP_CHAINED_MAX_HOPS) {
    throw new AquariusBudgetError(args.swapsChain.length);
  }

  const routerId = getAquariusRouterId(args.network);
  if (!isAllowedRootTarget(routerId, args.network)) {
    throw new Error(
      `AquariusAmmRouter ${routerId} is not on the ${args.network.id} allow-list, refusing to build swap_chained`,
    );
  }
  args.swapsChain.forEach((step, i) => {
    validatePoolIndex(step.poolIndex, `swapsChain[${i}].poolIndex`);
    if (step.tokens.length === 0) {
      throw new RangeError(`Aquarius swap_chained: swapsChain[${i}].tokens must not be empty`);
    }
  });
  validateNonNegativeU128("inAmount", args.inAmount);
  validateNonNegativeU128("outMin", args.outMin);

  // the deployed router's spec types swaps_chain as
  // Vec<(Vec<Address>, BytesN<32>, Address)>; a tuple encodes as a plain vec in
  // field order, not a symbol-keyed map
  const chainScVal = scvVec(
    args.swapsChain.map((step) =>
      scvVec([
        scvVec(step.tokens.map((t) => scvAddress(t))),
        u128Bytes(step.poolIndex),
        scvAddress(step.tokenOut),
      ]),
    ),
  );

  const callArgs: xdr.ScVal[] = [
    scvAddress(args.user),
    chainScVal,
    scvAddress(args.tokenIn),
    u128(args.inAmount),
    u128(args.outMin),
  ];

  return buildAndAssemble(
    routerId,
    "swap_chained",
    callArgs,
    args.sourceAccount,
    args.network,
    deps,
  );
}

// resolve router id from the network's allow-list
export function getAquariusRouterId(network: NetworkConfig): string {
  const list = getAllowlistForNetwork(network);
  const entry = list.find(
    (c: AllowedContract) => c.protocol === "aquarius" && c.name === "AquariusAmmRouter",
  );
  if (!entry) {
    throw new Error(`AquariusAmmRouter not found in ${network.id} allow-list`);
  }
  return entry.id;
}

async function buildAndAssemble(
  contractId: string,
  fnName: string,
  callArgs: xdr.ScVal[],
  sourceAccount: Horizon.AccountResponse,
  network: NetworkConfig,
  deps: AquariusClientDeps,
): Promise<Transaction> {
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(contract.call(fnName, ...callArgs))
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();

  const assemble = deps.assemble ?? assembleSubmittable;
  const prepared = await assemble(deps.server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(
      `Aquarius ${fnName}: prepareTransaction returned a FeeBumpTransaction unexpectedly`,
    );
  }
  assertTransactionAllowed(prepared, network);
  return prepared;
}

function validatePoolIndex(buf: Uint8Array, label: string = "poolIndex"): void {
  if (!(buf instanceof Uint8Array)) {
    throw new TypeError(`Aquarius ${label}: expected Uint8Array, got ${typeof buf}`);
  }
  if (buf.length !== POOL_INDEX_LENGTH_BYTES) {
    throw new RangeError(
      `Aquarius ${label}: expected ${POOL_INDEX_LENGTH_BYTES}-byte BytesN<32>, got ${buf.length}`,
    );
  }
}

function validateNonNegativeU128(label: string, v: bigint): void {
  if (typeof v !== "bigint") {
    throw new TypeError(`Aquarius ${label}: expected bigint, got ${typeof v}`);
  }
  if (v < 0n) {
    throw new RangeError(`Aquarius ${label}: u128 must be >= 0, got ${v.toString()}`);
  }
}

function validateTick(label: string, v: number): void {
  if (!Number.isInteger(v) || v < -(2 ** 31) || v >= 2 ** 31) {
    throw new RangeError(`Aquarius ${label}: expected an i32 tick, got ${v}`);
  }
}

// encode a BytesN<32> ScVal via buffer for node-side serializer compat
function u128Bytes(buf: Uint8Array): xdr.ScVal {
  const asBuffer = Buffer.from(buf);
  return xdr.ScVal.scvBytes(asBuffer);
}
