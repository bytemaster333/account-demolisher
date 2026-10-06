// wrapper around horizon's strict-send path search

import { Asset, BadRequestError, NetworkError, NotFoundError } from "@stellar/stellar-sdk";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { isFrozenBalance } from "@/lib/stellar/account-audit";
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
  const page = await withRateLimitRetry(() =>
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

// resolve a best XLM-conversion path for every positive credit balance the
// account holds, keyed by pathKey(asset). Assets with no market path, or whose
// best path is value-destroying (its slippage-adjusted output nets ≤ the absolute
// floor, e.g. an illiquid asset routing its whole balance to dust), are absent
// from the map, so the caller treats them as un-routable and disposes of them via
// issuer-return / send-to-destination instead of selling them for a pittance. A
// network error propagates rather than being silently treated as "no path".
// Balances frozen by their issuer are skipped: horizon's path search ignores
// whether the source may send the asset, and any payment of it fails with
// op_src_not_authorized (assessMergeability blocks the close on them instead).
export async function resolveCreditPaths(
  audit: AccountAudit,
  network: NetworkConfig,
): Promise<Map<string, PathResultRef>> {
  const credits = audit.balances.filter(
    (b) => b.asset.kind === "credit" && hasPositiveAmount(b.amount) && !isFrozenBalance(b),
  );
  const resolved = await mapWithConcurrency(credits, PATH_REQUEST_CONCURRENCY, async (b) => ({
    key: pathKey(b.asset),
    res: await findPathToXLM(b.asset, b.amount, network),
  }));
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

// an account with hundreds of trustlines would otherwise fire hundreds of path
// requests at once and trip public horizon's rate limit
export const PATH_REQUEST_CONCURRENCY = 8;
export const PATH_REQUEST_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// 429, 5xx and connection failures are transient; anything else (a 400 on a
// malformed asset, a 404) is a real answer and is thrown at once. the last
// error is surfaced as is once the attempts run out.
async function withRateLimitRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= PATH_REQUEST_ATTEMPTS || !isTransientHorizonError(err)) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
}

function isTransientHorizonError(err: unknown): boolean {
  if (err instanceof NotFoundError || err instanceof BadRequestError) return false;
  if (err instanceof NetworkError) {
    // the sdk stores the response body here; horizon problem documents carry the
    // status, a proxy error page does not
    const body = err.getResponse() as unknown;
    const status =
      typeof body === "object" && body !== null ? (body as { status?: unknown }).status : undefined;
    if (typeof status !== "number") return true;
    return status === 429 || status >= 500;
  }
  // no response at all: the request never reached horizon
  return err instanceof Error;
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
