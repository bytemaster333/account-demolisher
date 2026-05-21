// wrapper around horizon's strict-send path search.
//
// used to convert non-xlm classical balances to xlm before issuing
// CHANGE_TRUST(limit=0), which requires the balance to be zero. returns null
// only when no path of length <= 5 exists; network errors propagate.

import { Asset } from "@stellar/stellar-sdk";
import { getHorizon } from "@/lib/stellar/horizon-client";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AssetIdentifier } from "@/lib/types/account";

export interface PathResult {
  // output amount of native xlm as horizon-decimal string (e.g. "12.3456789").
  readonly destinationAmount: string;
  // intermediate assets; may be empty for direct hops.
  readonly path: readonly AssetIdentifier[];
  // echo of the source amount horizon priced against.
  readonly sourceAmount: string;
}

// max intermediate hops. horizon caps at 6 (source + 5 hops + dest); we mirror.
const MAX_PATH_LENGTH = 5;

export async function findPathToXLM(
  source: AssetIdentifier,
  amount: string,
  network: NetworkConfig,
): Promise<PathResult | null> {
  if (isNative(source)) {
    // xlm -> xlm is degenerate.
    return null;
  }

  const server = getHorizon(network);
  const sourceAsset = toSdkAsset(source);

  // constrain the search to xlm-only outputs.
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

// compare horizon decimal amount strings without fp loss.
// returns >0 when a > b, <0 when a < b, 0 when equal.
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
