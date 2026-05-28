/**
 * soroswap aggregator-routed asset conversion.
 * converts a non-XLM soroban balance to XLM via the soroswap multi-protocol aggregator
 * (soroswap, phoenix, aqua). classical conversion uses PATH_PAYMENT_STRICT_SEND elsewhere.
 *
 * flow: resolve assetIn → quote EXACT_IN → re-check slippage threshold against our policy →
 * build XDR → parse → assertTransactionAllowed → return.
 */

import { Asset, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import {
  SlippageGuardTripped,
  applySlippageMin,
  clampSlippage,
  DEFAULT_SLIPPAGE_BPS,
} from "@/lib/safety/slippage";
import type { AssetIdentifier } from "@/lib/types/account";
import {
  soroswapClient,
  type SoroswapClient,
  type SoroswapNetwork,
  type SoroswapQuote,
} from "./client";

// aggregator-routed protocols on the soroban half
const PROTOCOLS: readonly string[] = ["soroswap", "phoenix", "aqua"] as const;

const MAX_HOPS = 2;

export interface ConvertToXLMArgs {
  readonly assetIn: AssetIdentifier;
  // stroop-precise integer amount in smallest units
  readonly amountIn: string;
  readonly userAddress: string;
  readonly network: NetworkConfig;
  readonly slippageBps?: number;
}

export interface ConvertToXLMResult {
  readonly transaction: Transaction;
  readonly quote: SoroswapQuote;
}

// inject point for tests
export interface ConvertToXLMDeps {
  readonly client: SoroswapClient;
}

const defaultDeps: ConvertToXLMDeps = { client: soroswapClient };

export async function convertToXLM(
  args: ConvertToXLMArgs,
  deps: ConvertToXLMDeps = defaultDeps,
): Promise<ConvertToXLMResult> {
  const slippageBps = clampSlippage(args.slippageBps ?? DEFAULT_SLIPPAGE_BPS);

  const assetInAddress = resolveAssetAddress(args.assetIn, args.network);
  const assetOutAddress = Asset.native().contractId(args.network.passphrase);

  if (!/^\d+$/.test(args.amountIn)) {
    throw new TypeError(
      `convertToXLM: amountIn must be a non-negative decimal-integer string; got "${args.amountIn}"`,
    );
  }
  const amountIn = BigInt(args.amountIn);
  if (amountIn <= 0n) {
    throw new RangeError(`convertToXLM: amountIn must be > 0; got ${args.amountIn}`);
  }

  const networkId = mapNetworkId(args.network);

  const quote = await deps.client.quote({
    assetIn: assetInAddress,
    assetOut: assetOutAddress,
    amount: amountIn,
    tradeType: "EXACT_IN",
    protocols: [...PROTOCOLS],
    maxHops: MAX_HOPS,
    slippageBps,
    network: networkId,
  });

  // re-apply our slippage policy and refuse to build if the aggregator's threshold sits below it
  const expected = quote.amountOut.toString();
  const ourMinimum = applySlippageMin(expected, slippageBps);
  const theirMinimum = quote.otherAmountThreshold.toString();
  if (BigInt(theirMinimum) < BigInt(ourMinimum)) {
    throw new SlippageGuardTripped({
      expected,
      minimumAccepted: ourMinimum,
      actual: theirMinimum,
      slippageBps,
    });
  }

  const built = await deps.client.build({
    quote,
    from: args.userAddress,
    to: args.userAddress,
    network: networkId,
  });

  const transaction = parseTransaction(built.xdr, args.network);
  // every contract the user signs for MUST be on the pinned allow-list. re-verify client-side.
  assertTransactionAllowed(transaction, args.network);

  return { transaction, quote };
}

// map our NetworkConfig.id onto the soroswap SDK's network type. futurenet is unsupported.
function mapNetworkId(network: NetworkConfig): SoroswapNetwork {
  if (network.id === "mainnet" || network.id === "testnet") {
    return network.id;
  }
  throw new TypeError(`convertToXLM: Soroswap aggregator does not support network "${network.id}"`);
}

// resolve an AssetIdentifier to its soroban contract address. LP shares are rejected — use removeLiquidity first.
function resolveAssetAddress(asset: AssetIdentifier, network: NetworkConfig): string {
  switch (asset.kind) {
    case "native":
      return Asset.native().contractId(network.passphrase);
    case "credit":
      return new Asset(asset.code, asset.issuer).contractId(network.passphrase);
    case "liquidity_pool_shares":
      throw new TypeError(
        "convertToXLM: liquidity_pool_shares is not a swappable asset; use removeLiquidity first",
      );
  }
}

function parseTransaction(xdrBase64: string, network: NetworkConfig): Transaction {
  const parsed = TransactionBuilder.fromXDR(xdrBase64, network.passphrase);
  // aggregator never returns a fee-bump; surface unexpected case loudly
  if ("innerTransaction" in parsed) {
    throw new TypeError(
      "convertToXLM: Soroswap build returned a fee-bump transaction; expected inner transaction",
    );
  }
  return parsed;
}

export { SlippageGuardTripped };
