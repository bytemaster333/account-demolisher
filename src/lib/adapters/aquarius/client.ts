// aquarius router client. hand-rolled contract.call against the router id
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  getAllowlistForNetwork,
  isAllowedContract,
  type AllowedContract,
} from "@/lib/config/contracts";
import type { NetworkConfig } from "@/lib/config/networks";
import { address as scvAddress, vec as scvVec } from "@/lib/soroban/scval";
import { assembleSubmittable } from "@/lib/soroban/simulate";
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
  if (!isAllowedContract(routerId, args.network)) {
    throw new Error(
      `AquariusAmmRouter ${routerId} is not on the ${args.network.id} allow-list — refusing to build withdraw`,
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
  if (!isAllowedContract(routerId, args.network)) {
    throw new Error(
      `AquariusAmmRouter ${routerId} is not on the ${args.network.id} allow-list — refusing to build claim`,
    );
  }
  validatePoolIndex(args.poolIndex);

  const callArgs: xdr.ScVal[] = [scvAddress(args.user), u128Bytes(args.poolIndex)];

  return buildAndAssemble(routerId, "claim", callArgs, args.sourceAccount, args.network, deps);
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
  if (!isAllowedContract(routerId, args.network)) {
    throw new Error(
      `AquariusAmmRouter ${routerId} is not on the ${args.network.id} allow-list — refusing to build swap_chained`,
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

  const chainScVal = scvVec(
    args.swapsChain.map((step) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: nativeToScVal("pool_index", { type: "symbol" }),
          val: u128Bytes(step.poolIndex),
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("token_out", { type: "symbol" }),
          val: scvAddress(step.tokenOut),
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("tokens", { type: "symbol" }),
          val: scvVec(step.tokens.map((t) => scvAddress(t))),
        }),
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
    fee: BASE_FEE,
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

// encode a u128 ScVal
function u128(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u128" });
}

// encode a BytesN<32> ScVal via buffer for node-side serializer compat
function u128Bytes(buf: Uint8Array): xdr.ScVal {
  const asBuffer = Buffer.from(buf);
  return xdr.ScVal.scvBytes(asBuffer);
}
