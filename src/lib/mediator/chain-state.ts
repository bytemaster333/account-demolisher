// what horizon says happened to a mediator account. Both the in-session forward
// and the recovery banner decide from this, never from local state alone.

import { Horizon, NotFoundError } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";

// an account_merge of the closed account into the mediator
export interface MergeIntoMediator {
  readonly txHash: string;
  readonly ledger: number;
  readonly from: string;
}

// the forward's own account_merge, which deletes the mediator
export interface MediatorMergedOut {
  readonly txHash: string;
  readonly ledger: number;
  readonly into: string;
}

export interface MediatorHistory {
  // false when horizon has no record of the account at all
  readonly known: boolean;
  readonly mergeIn: MergeIntoMediator | null;
  readonly mergedOut: MediatorMergedOut | null;
}

// a mediator sees a funding, one merge in and the forward. anyone can still send
// it payments, so read a few pages before concluding a merge is not there.
const HISTORY_PAGE_SIZE = 200;
const HISTORY_MAX_PAGES = 5;

export function horizonFor(network: NetworkConfig): Horizon.Server {
  return new Horizon.Server(network.horizon, { allowHttp: false });
}

// newest-first scan of the mediator's successful operations. `from` narrows the
// merge-in to the account being closed, so a stranger merging some other
// account into a visible mediator can't stand in for the user's merge.
export async function readMediatorHistory(
  server: Horizon.Server,
  mediatorPublicKey: string,
  from?: string,
): Promise<MediatorHistory> {
  let page: Awaited<ReturnType<ReturnType<Horizon.Server["operations"]>["call"]>>;
  try {
    page = await server
      .operations()
      .forAccount(mediatorPublicKey)
      .order("desc")
      .limit(HISTORY_PAGE_SIZE)
      .call();
  } catch (err) {
    if (err instanceof NotFoundError) return { known: false, mergeIn: null, mergedOut: null };
    throw err;
  }

  let mergeIn: MergeIntoMediator | null = null;
  let mergedOut: MediatorMergedOut | null = null;
  for (let pageIndex = 0; pageIndex < HISTORY_MAX_PAGES; pageIndex++) {
    for (const op of page.records) {
      if (op.type !== "account_merge" || !op.transaction_successful) continue;
      const merge = op as Horizon.ServerApi.AccountMergeOperationRecord;
      if (merge.source_account === mediatorPublicKey && mergedOut === null) {
        mergedOut = { txHash: merge.transaction_hash, ledger: ledgerOf(merge), into: merge.into };
      } else if (
        merge.into === mediatorPublicKey &&
        mergeIn === null &&
        (from === undefined || merge.source_account === from)
      ) {
        mergeIn = {
          txHash: merge.transaction_hash,
          ledger: ledgerOf(merge),
          from: merge.source_account,
        };
      }
    }
    if ((mergeIn !== null && mergedOut !== null) || page.records.length < HISTORY_PAGE_SIZE) break;
    page = await page.next();
  }
  return { known: true, mergeIn, mergedOut };
}

// horizon operation ids are toids: the ledger sequence sits in the high 32 bits.
// reading it here avoids a second lookup that a lagging node might not answer.
function ledgerOf(op: { readonly id: string }): number {
  return Number(BigInt(op.id) >> 32n);
}

// the mediator account, or null once it no longer exists
export async function loadMediatorAccount(
  server: Horizon.Server,
  mediatorPublicKey: string,
): Promise<Horizon.AccountResponse | null> {
  try {
    return await server.loadAccount(mediatorPublicKey);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export function nativeBalance(account: Horizon.AccountResponse): string | null {
  const line = account.balances.find((b) => b.asset_type === "native");
  return line === undefined ? null : line.balance;
}
