// how much of an asset an account can actually hand to a Blend pool. the pool
// pulls the full request amount from the account with a SAC transfer, which
// fails for native XLM below the minimum reserve and for any asset beyond the
// part not locked by open offers (selling liabilities).
import { Asset, type Horizon } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";

// the network base reserve: 0.5 XLM on mainnet and testnet (horizon
// ledgers[].base_reserve_in_stroops, checked 2026-10-02). raising it needs a
// validator vote; if it ever changes, a repay sized off this fails on chain
// (#10, balance below reserve) instead of draining anything.
export const BASE_RESERVE_STROOPS = 5_000_000n;

// minimum native balance: (2 + subentries + sponsoring - sponsored) base reserves
export function nativeMinimumBalance(
  subentryCount: number,
  numSponsoring: number,
  numSponsored: number,
): bigint {
  const units = 2n + BigInt(subentryCount) + BigInt(numSponsoring) - BigInt(numSponsored);
  return units * BASE_RESERVE_STROOPS;
}

// a horizon decimal string ("12.3456789") in stroops
export function decimalToStroops(s: string): bigint {
  const trimmed = s.trim();
  if (!/^-?\d+(\.\d{1,7})?$/u.test(trimmed)) {
    throw new Error(`not a 7-decimal amount: "${s}"`);
  }
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [intPart = "0", fracPart = ""] = abs.split(".");
  const result = BigInt(intPart) * 10_000_000n + BigInt((fracPart + "0000000").slice(0, 7));
  return negative ? -result : result;
}

export interface SpendableLine {
  readonly native: boolean;
  // balance minus selling liabilities, and for XLM minus the minimum reserve.
  // never below zero. transaction fees are not taken off here.
  readonly spendable: bigint;
}

// the classic balance line behind a token contract id, or null when the
// account holds no classic line for it (an untrusted asset, or a token that is
// not a stellar asset contract)
export function spendableFromAccount(
  account: Horizon.AccountResponse,
  tokenContractId: string,
  network: NetworkConfig,
): SpendableLine | null {
  for (const line of account.balances) {
    if (line.asset_type === "native") {
      if (Asset.native().contractId(network.passphrase) !== tokenContractId) continue;
      const free =
        decimalToStroops(line.balance) -
        decimalToStroops(line.selling_liabilities) -
        nativeMinimumBalance(account.subentry_count, account.num_sponsoring, account.num_sponsored);
      return { native: true, spendable: free > 0n ? free : 0n };
    }
    if (line.asset_type === "credit_alphanum4" || line.asset_type === "credit_alphanum12") {
      const id = new Asset(line.asset_code, line.asset_issuer).contractId(network.passphrase);
      if (id !== tokenContractId) continue;
      const free = decimalToStroops(line.balance) - decimalToStroops(line.selling_liabilities);
      return { native: false, spendable: free > 0n ? free : 0n };
    }
  }
  return null;
}
