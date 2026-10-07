"use client";

import { useEffect, useMemo, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import type { AccountAudit } from "@/lib/types/account";
import type { PathResultRef } from "@/lib/types/plan";

export type ClaimedCreditQuotes =
  // the close claims no credit balance: the reviewed quotes already cover it
  | { readonly status: "none" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly quotes: ReadonlyMap<string, PathResultRef> }
  | { readonly status: "error"; readonly message: string };

// the reviewed quotes are sized to each balance alone, so a credit asset the
// close also claims more of can't be priced from them. These quotes are sized to
// the balance plus the claims, which is what the close really moves.
export function useClaimedCreditQuotes(args: {
  readonly audit: AccountAudit | null;
  readonly network: NetworkConfig;
  // the claimable balances the built plan claims
  readonly claimedBalanceIds: readonly string[];
  readonly enabled: boolean;
}): ClaimedCreditQuotes {
  const { audit, network, claimedBalanceIds, enabled } = args;
  // only credit claims change what a quote has to cover; the account's own
  // asset is burned by the claim and moves nothing
  const creditClaims = useMemo(() => {
    if (audit === null) return [];
    const claimed = new Set(claimedBalanceIds);
    return audit.claimableBalances
      .filter(
        (cb) =>
          claimed.has(cb.id) && cb.asset.kind === "credit" && cb.asset.issuer !== audit.accountId,
      )
      .map((cb) => cb.id)
      .sort();
  }, [audit, claimedBalanceIds]);
  const key = `${network.id}|${audit?.accountId ?? ""}|${claimedBalanceIds.join(",")}`;
  const active = enabled && audit !== null && creditClaims.length > 0;

  const [entry, setEntry] = useState<{
    readonly key: string;
    readonly audit: AccountAudit;
    readonly result: ClaimedCreditQuotes;
  } | null>(null);
  useEffect(() => {
    if (!active || audit === null) return;
    let cancelled = false;
    resolveCreditPaths(audit, network, { claimedBalanceIds: [...claimedBalanceIds] })
      .then((quotes) => {
        if (!cancelled) setEntry({ key, audit, result: { status: "ready", quotes } });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEntry({ key, audit, result: { status: "error", message: errorMessage(err) } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, audit, network, claimedBalanceIds, key]);

  if (!active) return { status: "none" };
  return entry !== null && entry.key === key && entry.audit === audit
    ? entry.result
    : { status: "loading" };
}
