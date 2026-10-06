// wrapper around horizon's strict-send path search

import { Asset } from "@stellar/stellar-sdk";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { isFrozenBalance } from "@/lib/stellar/account-audit";
import { decimalToStroops, stroopsToDecimal } from "@/lib/stellar/amount";
import { mapWithConcurrency } from "@/lib/stellar/concurrency";
import { HORIZON_REQUEST_ATTEMPTS, withHorizonRetry } from "@/lib/stellar/horizon-retry";
import { referenceTradeAmount } from "@/lib/plan/price-impact";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";
import { pathKey, type PathResultRef } from "@/lib/types/plan";
import {
  isMarketSellAcceptable,
  resolveConfiguredSlippageBps,
  resolveMinMarketOutStroops,
} from "@/lib/safety/slippage";

export interface PathResult {
  // output amount of native xlm as horizon-decimal string (e.g. "12.3456789")
  readonly destinationAmount: string;
  // intermediate assets; may be empty for direct hops
  readonly path: readonly AssetIdentifier[];
  // echo of the source amount horizon priced against
  readonly sourceAmount: string;
}

// max intermediate hops. horizon caps at 6 (source + 5 hops + dest); we mirror
const MAX_PATH_LENGTH = 5;

export async function findPathToXLM(
  source: AssetIdentifier,
  amount: string,
  network: NetworkConfig,
): Promise<PathResult | null> {
  if (isNative(source)) {
    // xlm -> xlm is degenerate
    return null;
  }

  const server = getHorizon(network);
  const sourceAsset = toSdkAsset(source);

  // constrain the search to xlm-only outputs
  const page = await withHorizonRetry(() =>
    server.strictSendPaths(sourceAsset, amount, [Asset.native()]).call(),
  );

  let best: PathResult | null = null;
  for (const record of page.records) {
    if (record.path.length > MAX_PATH_LENGTH) continue;

    const candidate: PathResult = {
      destinationAmount: record.destination_amount,
      path: record.path.map((p) => assetRecordToIdentifier(p)),
      sourceAmount: record.source_amount,
    };

    if (best === null || compareAmounts(candidate.destinationAmount, best.destinationAmount) > 0) {
      best = candidate;
    }
  }

  return best;
}

// resolve a best xlm-conversion path for every positive credit balance the
// account holds, keyed by pathKey(asset). an asset is absent from the map when it
// has no market path, or when its slippage-adjusted output nets at or below the
// absolute floor (NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS, 0 by default, so by default
// only a path that rounds to nothing after slippage is dropped). the caller treats
// an absent asset as un-routable. a network error propagates rather than being
// read as "no path".
//
// every path also carries a reference quote for a 1/1000 slice of the balance,
// which the batcher measures the full-size price impact against. a slice with no
// path leaves the reference unset, and the conversion then counts as unpriced.
//
// balances frozen by their issuer are skipped: horizon's path search ignores
// whether the source may send the asset, and any payment of it fails with
// op_src_not_authorized (assessMergeability blocks the close on them instead).
export async function resolveCreditPaths(
  audit: AccountAudit,
  network: NetworkConfig,
): Promise<Map<string, PathResultRef>> {
  const credits = audit.balances.filter(
    (b) => b.asset.kind === "credit" && hasPositiveAmount(b.amount) && !isFrozenBalance(b),
  );
  const bps = resolveConfiguredSlippageBps();
  const floor = resolveMinMarketOutStroops();
  const resolved = await mapWithConcurrency(credits, PATH_REQUEST_CONCURRENCY, async (b) => {
    const key = pathKey(b.asset);
    const full = await findPathToXLM(b.asset, b.amount, network);
    // a value-destroying sell is dropped, so the asset falls through to the
    // issuer or destination disposal instead of being sold for nothing
    if (!full || !isMarketSellAcceptable(decimalToStroops(full.destinationAmount), bps, floor)) {
      return { key, path: null };
    }
    const slice = stroopsToDecimal(referenceTradeAmount(decimalToStroops(b.amount)));
    const reference = await findPathToXLM(b.asset, slice, network);
    const path: PathResultRef = reference
      ? {
          ...full,
          reference: {
            sourceAmount: reference.sourceAmount,
            destinationAmount: reference.destinationAmount,
          },
        }
      : full;
    return { key, path };
  });
  const map = new Map<string, PathResultRef>();
  for (const { key, path } of resolved) {
    if (path) map.set(key, path);
  }
  return map;
}

// an account with hundreds of trustlines would otherwise fire hundreds of path
// requests at once and trip public horizon's rate limit
export const PATH_REQUEST_CONCURRENCY = 8;
export const PATH_REQUEST_ATTEMPTS = HORIZON_REQUEST_ATTEMPTS;

function hasPositiveAmount(s: string): boolean {
  for (const ch of s) if (ch >= "1" && ch <= "9") return true;
  return false;
}

function isNative(a: AssetIdentifier): boolean {
  return a.kind === "native";
}

function toSdkAsset(a: AssetIdentifier): Asset {
  switch (a.kind) {
    case "native":
      return Asset.native();
    case "credit":
      return new Asset(a.code, a.issuer);
    case "liquidity_pool_shares":
      throw new Error(
        "path-finder: cannot path-pay a liquidity-pool-share asset. Withdraw the pool position first.",
      );
    case "contract":
      throw new Error(
        "path-finder: cannot path-pay a raw SEP-41 contract token; it has no classic asset form.",
      );
  }
}

function assetRecordToIdentifier(p: {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}): AssetIdentifier {
  if (p.asset_type === "native") return { kind: "native" };
  return {
    kind: "credit",
    code: p.asset_code ?? "",
    issuer: p.asset_issuer ?? "",
  };
}

// exact comparison of horizon decimal amounts: >0 when a > b, <0 when a < b
function compareAmounts(a: string, b: string): number {
  const x = decimalToStroops(a);
  const y = decimalToStroops(b);
  return x === y ? 0 : x > y ? 1 : -1;
}
