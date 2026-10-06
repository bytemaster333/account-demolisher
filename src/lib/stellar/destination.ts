// up-front read of the merge destination: it must exist (account_merge into a
// missing account fails only at the last, irreversible step), and its SEP-29
// flag decides whether the close needs a memo and the mediator

import { NotFoundError } from "@stellar/stellar-sdk";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { isSep29MemoRequired } from "@/lib/safety/cex-registry";
import type { NetworkConfig } from "@/lib/config/networks";

export type DestinationCheck =
  { readonly state: "exists"; readonly sep29MemoRequired: boolean } | { readonly state: "missing" };

// any failure other than a 404 is thrown: an unreadable destination is neither
// confirmed missing nor confirmed free of a memo requirement
export async function checkDestination(
  address: string,
  network: NetworkConfig,
): Promise<DestinationCheck> {
  try {
    const account = await getHorizon(network).loadAccount(address);
    return { state: "exists", sep29MemoRequired: isSep29MemoRequired(account.data_attr) };
  } catch (err) {
    if (err instanceof NotFoundError) return { state: "missing" };
    throw err;
  }
}
