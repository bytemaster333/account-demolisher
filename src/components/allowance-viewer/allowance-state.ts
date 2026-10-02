// how the allowance viewer reads a record. the event amount can be stale or
// fabricated by a hostile token, so whenever the token's own allowance() was
// read, that value decides; the event amount only stands in when it wasn't.

import type { NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl, explorerContractUrl } from "@/lib/explorer";
import type { AllowanceRecord } from "@/lib/soroban/allowances";

export type Confirmation = "confirmed" | "unconfirmed";

export function confirmationOf(r: AllowanceRecord): Confirmation {
  return typeof r.onChainAmount === "bigint" ? "confirmed" : "unconfirmed";
}

// the amount to show and act on
export function effectiveAmount(r: AllowanceRecord): bigint {
  return typeof r.onChainAmount === "bigint" ? r.onChainAmount : r.amount;
}

// still revocable: not expired, and the spender can still move something
export function isActive(r: AllowanceRecord): boolean {
  return !r.expired && effectiveAmount(r) > 0n;
}

// stellar.expert link for a stellar address: contract (C...) or account (G...)
export function addressExplorerUrl(network: NetworkConfig, addr: string): string {
  return addr.startsWith("C")
    ? explorerContractUrl(network, addr)
    : explorerAccountUrl(network, addr);
}
