// wrapper around horizon's strict-send path search

import { Asset } from "@stellar/stellar-sdk";
import { getHorizon } from "@/lib/stellar/horizon-client";
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
  const page = await server.strictSendPaths(sourceAsset, amount, [Asset.native()]).call();

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

// resolve a best XLM-conversion path for every positive credit balance the
// account holds, keyed by pathKey(asset). Assets with no market path — OR whose
// best path is value-destroying (its slippage-adjusted output nets ≤ the absolute
// floor, e.g. an illiquid asset routing its whole balance to dust) — are absent
// from the map, so the caller treats them as un-routable and disposes of them via
// issuer-return / send-to-destination instead of selling them for a pittance. A
// network error propagates rather than being silently treated as "no path".
export async function resolveCreditPaths(
  audit: AccountAudit,
  network: NetworkConfig,
): Promise<Map<string, PathResultRef>> {
  const credits = audit.balances.filter(
    (b) => b.asset.kind === "credit" && hasPositiveAmount(b.amount),
  );
  const resolved = await Promise.all(
    credits.map(async (b) => ({
      key: pathKey(b.asset),
      res: await findPathToXLM(b.asset, b.amount, network),
    })),
  );
  const bps = resolveConfiguredSlippageBps();
  const floor = resolveMinMarketOutStroops();
  const map = new Map<string, PathResultRef>();
  for (const { key, res } of resolved) {
    if (!res) continue;
    // refuse a value-destroying sell: a path whose slippage-adjusted output nets
    // at or below the floor is dropped, so the asset falls through to the
    // issuer/destination disposal rather than being sold for ~nothing.
    if (!isMarketSellAcceptable(xlmDecimalToStroops(res.destinationAmount), bps, floor)) {
      continue;
    }
    map.set(key, res);
  }
  return map;
}

// convert an XLM horizon-decimal string ("12.3456789") to integer stroops.
// non-numeric / malformed input yields 0n (treated as value-destroying).
function xlmDecimalToStroops(s: string): bigint {
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
  const [intPart = "0", fracPart = ""] = trimmed.split(".");
  const frac = (fracPart + "0000000").slice(0, 7);
  return BigInt(intPart) * 10_000_000n + BigInt(frac);
}

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

// compare horizon decimal amount strings without fp loss
// returns >0 when a > b, <0 when a < b, 0 when equal
function compareAmounts(a: string, b: string): number {
  const [aiRaw = "0", afRaw = ""] = a.split(".");
  const [biRaw = "0", bfRaw = ""] = b.split(".");
  const ai = BigInt(aiRaw);
  const bi = BigInt(biRaw);
  if (ai !== bi) return ai > bi ? 1 : -1;
  const af = padRight(afRaw, 7);
  const bf = padRight(bfRaw, 7);
  const afn = BigInt(af);
  const bfn = BigInt(bf);
  if (afn === bfn) return 0;
  return afn > bfn ? 1 : -1;
}

function padRight(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + "0".repeat(n - s.length);
}
