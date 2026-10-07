// wrapper around horizon's strict-send path search

import { Asset } from "@stellar/stellar-sdk";
import { getHorizon } from "@/lib/stellar/horizon-client";
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
//
// with claimedBalanceIds, an asset is quoted at its balance plus the credit
// claims the close lands on it, including an asset collected into a trustline
// the close opens, which has no balance line in this audit yet. sourceAmount on
// each result is the amount quoted.
export async function resolveCreditPaths(
  audit: AccountAudit,
  network: NetworkConfig,
  options: CreditPathOptions = {},
): Promise<Map<string, PathResultRef>> {
  const credits = heldCredits(audit, options.claimedBalanceIds ?? []);
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

export interface CreditPathOptions {
  // ids of the claimable balances the plan claims,
  // planClaimableBalances(audit, selection).claimed, not the user's selection
  readonly claimedBalanceIds?: readonly string[];
}

interface HeldCredit {
  readonly asset: Extract<AssetIdentifier, { kind: "credit" }>;
  readonly amount: string;
}

// what the close sells per credit asset: the positive balance, plus claimed
// credit balances of other issuers. the account's own asset is burned by its
// claim, and a claim into a deauthorized trustline never lands.
function heldCredits(audit: AccountAudit, claimedBalanceIds: readonly string[]): HeldCredit[] {
  const held = new Map<string, { asset: HeldCredit["asset"]; amount: string; claimed: bigint }>();
  const unsendable = new Set<string>();
  for (const b of audit.balances) {
    if (b.asset.kind !== "credit") continue;
    // covers isFrozenBalance, and a zero deauthorized line a claim can't land on
    if (b.isAuthorized === false) {
      unsendable.add(pathKey(b.asset));
      continue;
    }
    if (hasPositiveAmount(b.amount)) {
      held.set(pathKey(b.asset), { asset: b.asset, amount: b.amount, claimed: 0n });
    }
  }
  if (claimedBalanceIds.length > 0) {
    const byId = new Map(audit.claimableBalances.map((cb) => [cb.id, cb]));
    for (const id of claimedBalanceIds) {
      const cb = byId.get(id);
      if (cb === undefined) {
        throw new Error(`resolveCreditPaths: claimed balance ${id} is not in the audit`);
      }
      if (cb.asset.kind !== "credit" || cb.asset.issuer === audit.accountId) continue;
      const key = pathKey(cb.asset);
      if (unsendable.has(key)) continue;
      const entry = held.get(key) ?? { asset: cb.asset, amount: "0", claimed: 0n };
      held.set(key, { ...entry, claimed: entry.claimed + decimalToStroops(cb.amount) });
    }
  }
  return [...held.values()].map(({ asset, amount, claimed }) => ({
    asset,
    // horizon's own string when nothing is added, so the quote echoes it unchanged
    amount: claimed === 0n ? amount : stroopsToDecimal(decimalToStroops(amount) + claimed),
  }));
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
