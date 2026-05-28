/**
 * soroswap LP exit — direct remove_liquidity invocation against the mainnet SoroswapRouter.
 * keeps the LP exit on the same simulate → assemble rails as every other soroban write and
 * sidesteps the SDK's api-key dependency for this leg.
 * the router id is resolved from the allow-list registry (single source of truth).
 */

import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  rpc,
  xdr,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  getAllowlistForNetwork,
  isAllowedContract,
  MAINNET_ALLOWLIST,
  type AllowedContract,
} from "@/lib/config/contracts";
import type { NetworkConfig } from "@/lib/config/networks";
import { address as scvAddress, i128 as scvI128 } from "@/lib/soroban/scval";
import { assembleSubmittable } from "@/lib/soroban/simulate";
import type { AssetIdentifier } from "@/lib/types/account";
import { Asset, nativeToScVal } from "@stellar/stellar-sdk";

const FIVE_MINUTES_SECONDS = 300;

export interface RemoveLiquidityArgs {
  readonly tokenA: AssetIdentifier;
  readonly tokenB: AssetIdentifier;
  // LP-share balance to burn, in smallest units
  readonly liquidity: string;
  readonly amountAMin: string;
  readonly amountBMin: string;
  readonly userAddress: string;
  // unix seconds. soroswap compares against env.ledger().timestamp().
  readonly deadline: number;
  readonly network: NetworkConfig;
}

// inject point for tests; defaults to the memoized RPC + assembleSubmittable
export interface RemoveLiquidityDeps {
  readonly server: rpc.Server;
  readonly sourceAccount: Horizon.AccountResponse;
  readonly assemble?: typeof assembleSubmittable;
}

export async function removeLiquidity(
  args: RemoveLiquidityArgs,
  deps: RemoveLiquidityDeps,
): Promise<Transaction> {
  const tokenAAddress = resolveAssetAddress(args.tokenA, args.network);
  const tokenBAddress = resolveAssetAddress(args.tokenB, args.network);
  return removeLiquidityByContractIds(
    {
      tokenAAddress,
      tokenBAddress,
      liquidity: args.liquidity,
      amountAMin: args.amountAMin,
      amountBMin: args.amountBMin,
      userAddress: args.userAddress,
      deadline: args.deadline,
      network: args.network,
    },
    deps,
  );
}

/**
 * sibling that accepts already-resolved soroban contract IDs for both pair tokens.
 * used by the plan hydrator which only has the pair's contract ids threaded through.
 */
export interface RemoveLiquidityByContractIdsArgs {
  readonly tokenAAddress: string;
  readonly tokenBAddress: string;
  readonly liquidity: string;
  readonly amountAMin: string;
  readonly amountBMin: string;
  readonly userAddress: string;
  readonly deadline: number;
  readonly network: NetworkConfig;
}

export async function removeLiquidityByContractIds(
  args: RemoveLiquidityByContractIdsArgs,
  deps: RemoveLiquidityDeps,
): Promise<Transaction> {
  const routerId = getSoroswapRouterId(args.network);
  // defensive re-check; pinned ID is in the allow-list by construction
  if (!isAllowedContract(routerId, args.network)) {
    throw new Error(
      `SoroswapRouter ${routerId} is not on the ${args.network.id} allow-list — refusing to build remove_liquidity`,
    );
  }

  validateIntegerAmount("liquidity", args.liquidity);
  validateIntegerAmount("amountAMin", args.amountAMin);
  validateIntegerAmount("amountBMin", args.amountBMin);
  validateDeadline(args.deadline);

  const tokenAAddress = args.tokenAAddress;
  const tokenBAddress = args.tokenBAddress;

  const callArgs: xdr.ScVal[] = [
    scvAddress(tokenAAddress),
    scvAddress(tokenBAddress),
    scvI128(BigInt(args.liquidity)),
    scvI128(BigInt(args.amountAMin)),
    scvI128(BigInt(args.amountBMin)),
    scvAddress(args.userAddress),
    nativeToScVal(BigInt(args.deadline), { type: "u64" }),
  ];

  const contract = new Contract(routerId);
  const tx = new TransactionBuilder(deps.sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: args.network.passphrase,
  })
    .addOperation(contract.call("remove_liquidity", ...callArgs))
    .setTimeout(FIVE_MINUTES_SECONDS)
    .build();

  const assemble = deps.assemble ?? assembleSubmittable;
  const prepared = await assemble(deps.server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(
      "removeLiquidity: prepareTransaction returned a FeeBumpTransaction unexpectedly",
    );
  }
  return prepared;
}

// look up the SoroswapRouter contract id from the allow-list. defaults to mainnet.
function getSoroswapRouterId(network?: NetworkConfig): string {
  const list = network === undefined ? MAINNET_ALLOWLIST : getAllowlistForNetwork(network);
  const entry = list.find(
    (c: AllowedContract) => c.protocol === "soroswap" && c.name === "SoroswapRouter",
  );
  if (!entry) {
    const label = network === undefined ? "MAINNET_ALLOWLIST" : `${network.id} allow-list`;
    throw new Error(`SoroswapRouter not found in ${label}`);
  }
  return entry.id;
}

function resolveAssetAddress(asset: AssetIdentifier, network: NetworkConfig): string {
  switch (asset.kind) {
    case "native":
      return Asset.native().contractId(network.passphrase);
    case "credit":
      return new Asset(asset.code, asset.issuer).contractId(network.passphrase);
    case "liquidity_pool_shares":
      throw new TypeError(
        "removeLiquidity: liquidity_pool_shares is not a token; pass the two underlying assets",
      );
  }
}

function validateIntegerAmount(label: string, v: string): void {
  if (!/^\d+$/.test(v)) {
    throw new TypeError(
      `removeLiquidity: ${label} must be a non-negative decimal-integer string; got "${v}"`,
    );
  }
}

function validateDeadline(deadline: number): void {
  if (!Number.isFinite(deadline) || !Number.isInteger(deadline) || deadline <= 0) {
    throw new RangeError(`removeLiquidity: deadline must be a positive integer; got ${deadline}`);
  }
  if (deadline > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`removeLiquidity: deadline exceeds MAX_SAFE_INTEGER; got ${deadline}`);
  }
}
