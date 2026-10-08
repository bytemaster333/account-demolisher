import { scValToNative, xdr } from "@stellar/stellar-sdk";

// mainnet tests that need a depositor in a given state pick one at run time: a
// pinned depositor can withdraw or restore at any moment, and the test would
// then fail on someone else's state. the rpc reads storage entries only by key
// and cannot list them, so candidates come from stellar.expert's contract-data
// index. a test never relies on what the index says: it re-reads each
// candidate's state from the chain with the app's own loaders and passes over
// the ones that changed.

const EXPERT = "https://api.stellar.expert";
const PAGE = 200;

export interface IndexedEntry {
  readonly key: unknown;
  readonly value: unknown;
  // the entry's ttl has passed: it is archived until something restores it
  readonly expired: boolean;
}

interface ContractDataPage {
  readonly _links: { readonly next?: { readonly href: string } };
  readonly _embedded: {
    readonly records: readonly {
      readonly key: string;
      readonly value: string;
      readonly expired?: boolean;
    }[];
  };
}

// walk the contract's storage in index order and keep what pick returns, up to max
export async function findInContractData<T>(
  contractId: string,
  pick: (entry: IndexedEntry) => T | undefined,
  max: number,
): Promise<T[]> {
  const found: T[] = [];
  let next: string | undefined = `/explorer/public/contract-data/${contractId}?limit=${PAGE}`;
  while (next !== undefined && found.length < max) {
    const res = await fetch(`${EXPERT}${next}`);
    if (!res.ok) {
      throw new Error(`stellar.expert contract-data listing for ${contractId}: ${res.status}`);
    }
    const page = (await res.json()) as ContractDataPage;
    const records = page._embedded.records;
    for (const rec of records) {
      const hit = pick({
        key: scValToNative(xdr.ScVal.fromXdr(rec.key, "base64")) as unknown,
        value: scValToNative(xdr.ScVal.fromXdr(rec.value, "base64")) as unknown,
        expired: rec.expired === true,
      });
      if (hit !== undefined) found.push(hit);
      if (found.length >= max) break;
    }
    // the next link carries the default page size, not the one asked for
    next =
      records.length < PAGE
        ? undefined
        : page._links.next?.href.replace(/limit=\d+/, `limit=${PAGE}`);
  }
  return found;
}

export interface IndexedBackstopBalance {
  readonly pool: string;
  readonly user: string;
  readonly shares: bigint;
  readonly q4w: readonly { readonly amount: bigint; readonly exp: bigint }[];
  readonly archived: boolean;
}

// a ("UserBalance", { pool, user }) entry of a backstop, for a classic account
// (a contract holder has no account to source a transaction from). archived
// entries count: on 2026-10-08 every v1 balance with shares was archived, and
// the loaders and builders read and restore them like live ones.
export function backstopBalance(entry: IndexedEntry): IndexedBackstopBalance | undefined {
  if (!Array.isArray(entry.key) || entry.key[0] !== "UserBalance") return undefined;
  const id = entry.key[1] as { pool?: unknown; user?: unknown };
  if (typeof id.pool !== "string" || typeof id.user !== "string") return undefined;
  if (!id.user.startsWith("G")) return undefined;
  const value = entry.value as { shares: bigint; q4w: IndexedBackstopBalance["q4w"] };
  return {
    pool: id.pool,
    user: id.user,
    shares: value.shares,
    q4w: value.q4w,
    archived: entry.expired,
  };
}
