// Soroswap Router swap: convert a Soroban token to XLM via a direct
// swap_exact_tokens_for_tokens invocation against the SoroswapRouter.
//
// This is the ALLOW-LIST-SAFE, testnet-capable conversion path. The Soroswap
// Aggregator (multi-protocol) is addressed dynamically by the Soroswap backend
// (SoroswapSDK.getContractAddress) and is not deployed on testnet, so it cannot
// be a statically-pinned allow-list entry the way this app's security model
// requires. The Router IS pinned on both the mainnet and testnet allow-lists, so
// the conversion routes through it (single-protocol Soroswap liquidity). A token
// with no Soroswap route simply can't be quoted and is left in place.
import {
  Asset,
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
  MAINNET_ALLOWLIST,
  type AllowedContract,
} from "@/lib/config/contracts";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import type { NetworkConfig } from "@/lib/config/networks";
import { address as scvAddress, i128 as scvI128, vec as scvVec } from "@/lib/soroban/scval";
import { assembleSubmittable } from "@/lib/soroban/simulate";
import type { AssetIdentifier } from "@/lib/types/account";

const FIVE_MINUTES_SECONDS = 300;

export interface SwapToXLMArgs {
  readonly assetIn: AssetIdentifier;
  // smallest-units integer amount to swap in
  readonly amountIn: string;
  // minimum XLM out (stroops) the swap will accept; below this it reverts on-chain
  readonly amountOutMin: string;
  readonly userAddress: string;
  // unix seconds; the router compares against env.ledger().timestamp()
  readonly deadline: number;
  readonly network: NetworkConfig;
}

export interface SwapToXLMDeps {
  readonly server: rpc.Server;
  readonly sourceAccount: Horizon.AccountResponse;
  readonly assemble?: typeof assembleSubmittable;
}

// build a router swap_exact_tokens_for_tokens converting assetIn -> XLM. The path
// is [assetIn, XLM]; the router walks its own pools. Allow-list-gated on build AND
// after assembly, exactly like the LP-removal builder.
export async function buildSwapToXLM(
  args: SwapToXLMArgs,
  deps: SwapToXLMDeps,
): Promise<Transaction> {
  const routerId = getSoroswapRouterId(args.network);
  if (!isAllowedContract(routerId, args.network)) {
    throw new Error(
      `SoroswapRouter ${routerId} is not on the ${args.network.id} allow-list; refusing to build swap`,
    );
  }

  validateIntegerAmount("amountIn", args.amountIn);
  validateIntegerAmount("amountOutMin", args.amountOutMin);
  validateDeadline(args.deadline);
  if (BigInt(args.amountIn) <= 0n) {
    throw new RangeError(`buildSwapToXLM: amountIn must be > 0; got ${args.amountIn}`);
  }

  const assetInAddress = resolveAssetAddress(args.assetIn, args.network);
  const xlmAddress = Asset.native().contractId(args.network.passphrase);
  if (assetInAddress === xlmAddress) {
    throw new Error("buildSwapToXLM: assetIn is already XLM; nothing to convert");
  }

  const path = scvVec([scvAddress(assetInAddress), scvAddress(xlmAddress)]);
  const callArgs: xdr.ScVal[] = [
    scvI128(BigInt(args.amountIn)),
    scvI128(BigInt(args.amountOutMin)),
    path,
    scvAddress(args.userAddress),
    nativeToScVal(BigInt(args.deadline), { type: "u64" }),
  ];

  const contract = new Contract(routerId);
  const tx = new TransactionBuilder(deps.sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: args.network.passphrase,
  })
    .addOperation(contract.call("swap_exact_tokens_for_tokens", ...callArgs))
    .setTimeout(FIVE_MINUTES_SECONDS)
    .build();

  const assemble = deps.assemble ?? assembleSubmittable;
  const prepared = await assemble(deps.server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error("buildSwapToXLM: prepareTransaction returned a FeeBumpTransaction unexpectedly");
  }
  assertTransactionAllowed(prepared, args.network);
  return prepared;
}

// look up the SoroswapRouter contract id from the allow-list (mainnet default)
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
        "buildSwapToXLM: liquidity_pool_shares is not a swappable token; remove liquidity first",
      );
    case "contract":
      return asset.contractId;
  }
}

function validateIntegerAmount(label: string, v: string): void {
  if (!/^\d+$/.test(v)) {
    throw new TypeError(
      `buildSwapToXLM: ${label} must be a non-negative decimal-integer string; got "${v}"`,
    );
  }
}

function validateDeadline(deadline: number): void {
  if (!Number.isFinite(deadline) || !Number.isInteger(deadline) || deadline <= 0) {
    throw new RangeError(`buildSwapToXLM: deadline must be a positive integer; got ${deadline}`);
  }
  if (deadline > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`buildSwapToXLM: deadline exceeds MAX_SAFE_INTEGER; got ${deadline}`);
  }
}
