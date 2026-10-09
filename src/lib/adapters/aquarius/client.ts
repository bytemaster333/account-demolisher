// aquarius client: router calls (withdraw, claim) and direct calls on pinned
// concentrated pools (withdraw_position, claim_all_position_fees)
import {
  Address,
  Contract,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
  type TransactionSource,
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
import { ledgerMaxTime } from "@/lib/stellar/ledger-clock";

// every built tx expires five minutes after the latest ledger's close time
const MAX_TIMEOUT_SECONDS = 300;

const POOL_INDEX_LENGTH_BYTES = 32;

export interface WithdrawArgs {
  readonly user: string;
  readonly tokens: readonly string[];
  readonly poolIndex: Uint8Array;
  readonly shareAmount: bigint;
  readonly minAmounts: readonly bigint[];
  readonly sourceAccount: TransactionSource;
  // close time (unix seconds) of the latest ledger the tx is timed from
  readonly ledgerCloseTime: number;
  readonly network: NetworkConfig;
}

export interface ClaimArgs {
  readonly user: string;
  // the pool's token set, in the router's sorted order. the router resolves a
  // pool by (tokens, pool_index) because a pool_index is only unique within one
  // token set. typed optional because older plan metadata did not carry it; a
  // claim without it is refused rather than sent as a call that can never work.
  readonly tokens?: readonly string[];
  readonly poolIndex: Uint8Array;
  readonly sourceAccount: TransactionSource;
  // close time (unix seconds) of the latest ledger the tx is timed from
  readonly ledgerCloseTime: number;
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
    bytesN32(args.poolIndex),
    u128(args.shareAmount),
    scvVec(args.minAmounts.map((m) => u128(m))),
  ];

  return buildAndAssemble(
    routerId,
    "withdraw",
    callArgs,
    args.sourceAccount,
    args.ledgerCloseTime,
    args.network,
    deps,
  );
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
    bytesN32(args.poolIndex),
  ];

  return buildAndAssemble(
    routerId,
    "claim",
    callArgs,
    args.sourceAccount,
    args.ledgerCloseTime,
    args.network,
    deps,
  );
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
      bytesN32(args.poolIndex),
    ],
    args.user,
    args.network,
  );
  return fromScValU128(retval);
}

// the reward token the router stores (AQUA on mainnet). the router exports a
// setter but no getter, so it is read from the router's instance storage, key
// ["RewardToken"], with no contract code run. the claim itself is paid by the
// pool from its own ["RewardToken"] (readAquariusPoolRewardTokens), which every
// pool on mainnet had equal to this one on 2026-10-08.
export async function readAquariusRewardToken(
  server: rpc.Server,
  network: NetworkConfig,
): Promise<string> {
  const routerId = getAquariusRouterId(network);
  const storage = (await readInstanceStorage(server, [routerId])).get(routerId)!;
  return storedRewardToken(storage, `AquariusAmmRouter ${routerId}`);
}

// the tokens each pool's reward claim can pay: its own ["RewardToken"] first,
// then any other token its ["RewardTokenRegistry"] lists (concentrated pools
// keep one). a router claim on mainnet standard pool CAUCGD... was paid by the
// pool, as a transfer from the pool of the token in its RewardToken (simulated
// 2026-10-08). the protocol source is not public, so a registry entry is taken
// as payable rather than guessed away.
export async function readAquariusPoolRewardTokens(
  server: rpc.Server,
  poolAddresses: readonly string[],
): Promise<Map<string, readonly string[]>> {
  const ids = [...new Set(poolAddresses)];
  const storage = await readInstanceStorage(server, ids);
  const out = new Map<string, readonly string[]>();
  for (const id of ids) {
    const items = storage.get(id)!;
    const label = `Aquarius pool ${id}`;
    const tokens = [storedRewardToken(items, label)];
    const registry = storageValue(items, "RewardTokenRegistry");
    if (registry !== undefined) {
      if (registry.type !== "scvVec" || registry.vec === null) {
        throw new Error(`${label} has a RewardTokenRegistry that is not a list of tokens`);
      }
      for (const v of registry.vec) {
        const token = contractAddress(v);
        if (token === null) {
          throw new Error(`${label} has a RewardTokenRegistry entry that is not a contract`);
        }
        if (!tokens.includes(token)) tokens.push(token);
      }
    }
    out.set(id, tokens);
  }
  return out;
}

// instance storage of each contract, read in one getLedgerEntries call (the
// rpc takes up to 200 keys; a close touches a handful of pools)
export async function readInstanceStorage(
  server: rpc.Server,
  contractIds: readonly string[],
): Promise<Map<string, readonly xdr.ScMapEntry[]>> {
  const out = new Map<string, readonly xdr.ScMapEntry[]>();
  if (contractIds.length === 0) return out;
  const resp = await server.getLedgerEntries(
    ...contractIds.map((id) =>
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(id).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent,
        }),
      ),
    ),
  );
  for (const entry of resp.entries) {
    const cd = xdr.expectUnionVariant(entry.val, "contractData").contractData;
    const instance = xdr.expectUnionVariant(cd.val, "scvContractInstance").instance;
    out.set(Address.fromScAddress(cd.contract).toString(), instance.storage ?? []);
  }
  const missing = contractIds.filter((id) => !out.has(id));
  if (missing.length > 0) {
    throw new Error(`contract instances not returned by the rpc: ${missing.join(", ")}`);
  }
  return out;
}

// the value stored under the one-symbol key [name]
export function storageValue(
  items: readonly xdr.ScMapEntry[],
  name: string,
): xdr.ScVal | undefined {
  for (const item of items) {
    const key = item.key.type === "scvVec" ? item.key.vec : null;
    if (key?.length === 1 && key[0]!.type === "scvSymbol" && key[0]!.sym.toString() === name) {
      return item.val;
    }
  }
  return undefined;
}

function contractAddress(v: xdr.ScVal): string | null {
  if (v.type !== "scvAddress") return null;
  const id = Address.fromScVal(v).toString();
  return id.startsWith("C") ? id : null;
}

function storedRewardToken(items: readonly xdr.ScMapEntry[], label: string): string {
  const v = storageValue(items, "RewardToken");
  const token = v === undefined ? null : contractAddress(v);
  if (token === null) {
    throw new Error(
      `${label} has no contract address under RewardToken, so the token a reward claim pays is unknown`,
    );
  }
  return token;
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
  readonly sourceAccount: TransactionSource;
  // close time (unix seconds) of the latest ledger the tx is timed from
  readonly ledgerCloseTime: number;
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
    args.ledgerCloseTime,
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
    readonly sourceAccount: TransactionSource;
    readonly ledgerCloseTime: number;
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
    args.ledgerCloseTime,
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
  sourceAccount: TransactionSource,
  ledgerCloseTime: number,
  network: NetworkConfig,
  deps: AquariusClientDeps,
): Promise<Transaction> {
  const maxTime = ledgerMaxTime(ledgerCloseTime, MAX_TIMEOUT_SECONDS);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(contract.call(fnName, ...callArgs))
    .setTimebounds(0, maxTime)
    .build();

  const assemble = deps.assemble ?? assembleSubmittable;
  const prepared = await assemble(deps.server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(
      `Aquarius ${fnName}: assembling the simulation returned a FeeBumpTransaction unexpectedly`,
    );
  }
  assertTransactionAllowed(prepared, network);
  return prepared;
}

function validatePoolIndex(buf: Uint8Array): void {
  if (!(buf instanceof Uint8Array)) {
    throw new TypeError(`Aquarius poolIndex: expected Uint8Array, got ${typeof buf}`);
  }
  if (buf.length !== POOL_INDEX_LENGTH_BYTES) {
    throw new RangeError(
      `Aquarius poolIndex: expected ${POOL_INDEX_LENGTH_BYTES}-byte BytesN<32>, got ${buf.length}`,
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

// a BytesN<32> argument is an ScBytes value; callers check the length first
function bytesN32(buf: Uint8Array): xdr.ScVal {
  const asBuffer = Buffer.from(buf);
  return xdr.ScVal.scvBytes(asBuffer);
}
