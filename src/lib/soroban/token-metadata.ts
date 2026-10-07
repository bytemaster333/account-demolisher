// symbol() and decimals() for the allowance list, read through one shared queue.
//
// any contract can emit an approve event naming the user, so the number of rows
// (and of tokens to describe) is the attacker's to choose. each row asking for
// its own metadata on mount would fire two simulations per row at once; here
// every row's read waits for one of a few slots, a contract is read once however
// many rows show it, and a row that unmounts before its turn drops its read. a
// read that already has its slot runs to the end and stays shared, so a row that
// comes back picks it up instead of starting another.

import type { rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { createSemaphore } from "./concurrency";
import { decimals as sep41Decimals, symbol as sep41Symbol } from "./sep41";

export interface TokenMetadata {
  // the token's own text, unsanitized: render it through safeDisplay
  readonly symbol: string;
  readonly decimals: number;
}

// simulations in flight at once across every caller (each read runs symbol and
// then decimals in one slot)
export const TOKEN_METADATA_CONCURRENCY = 4;

const slots = createSemaphore(TOKEN_METADATA_CONCURRENCY);

interface Entry {
  readonly promise: Promise<TokenMetadata>;
  // aborts the queued read once every caller waiting on it has gone
  readonly controller: AbortController;
  interested: number;
  // started is set once the read holds a slot; from then on aborting would only
  // waste it
  readonly progress: { started: boolean };
}

const entries = new WeakMap<rpc.Server, Map<string, Entry>>();

export async function readTokenMetadata(
  server: rpc.Server,
  contractId: string,
  sourcePublicKey: string,
  network: NetworkConfig,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<TokenMetadata> {
  const { signal } = opts;
  if (signal?.aborted) throw abortReason(signal);

  const perServer = entries.get(server) ?? new Map<string, Entry>();
  entries.set(server, perServer);
  let entry = perServer.get(contractId);
  if (entry === undefined) {
    const controller = new AbortController();
    const progress = { started: false };
    const promise = slots.run(async () => {
      progress.started = true;
      const symbol = await sep41Symbol(server, contractId, sourcePublicKey, network);
      const decimals = await sep41Decimals(server, contractId, sourcePublicKey, network);
      return { symbol, decimals };
    }, controller.signal);
    const created: Entry = { promise, controller, interested: 0, progress };
    // a failed or dropped read is forgotten, so the next caller tries again
    promise.catch(() => {
      if (perServer.get(contractId) === created) perServer.delete(contractId);
    });
    perServer.set(contractId, created);
    entry = created;
  }

  const shared = entry;
  shared.interested += 1;
  if (signal === undefined) return shared.promise;
  return new Promise<TokenMetadata>((resolve, reject) => {
    const onAbort = (): void => {
      shared.interested -= 1;
      if (shared.interested === 0 && !shared.progress.started) {
        // forget the entry now rather than in its rejection handler a microtask
        // later, so a row that unmounts and mounts again in the same tick gets a
        // fresh read instead of this abandoned one
        if (perServer.get(contractId) === shared) perServer.delete(contractId);
        shared.controller.abort();
      }
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    shared.promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
