// the network's own clock: the latest closed ledger. used instead of the
// browser's wall clock wherever validity depends on time (claimable-balance
// predicates, transaction time bounds, the merge sequence ceiling), so a skewed
// client clock cannot produce a transaction that is doomed on submit.

import { getHorizon } from "@/lib/stellar/horizon-client";
import type { NetworkConfig } from "@/lib/config/networks";

export interface LedgerClock {
  // sequence number of the latest closed ledger
  readonly sequence: number;
  // its close time, unix seconds
  readonly closedAt: number;
}

// how long a classic transaction built for the live close stays valid. the
// execute path signs and submits within minutes; a multisig signing request
// passes its own, much longer window.
export const DEFAULT_TX_VALIDITY_SECONDS = 300;

export async function fetchLedgerClock(network: NetworkConfig): Promise<LedgerClock> {
  const page = await getHorizon(network).ledgers().order("desc").limit(1).call();
  const record = page.records[0];
  if (record === undefined) {
    throw new Error(`fetchLedgerClock: ${network.horizon} returned no ledgers`);
  }
  const ms = Date.parse(record.closed_at);
  if (!Number.isFinite(ms) || !Number.isSafeInteger(record.sequence) || record.sequence <= 0) {
    throw new Error(
      `fetchLedgerClock: unreadable latest ledger (sequence ${String(record.sequence)}, ` +
        `closed_at ${String(record.closed_at)})`,
    );
  }
  return { sequence: record.sequence, closedAt: Math.floor(ms / 1000) };
}
