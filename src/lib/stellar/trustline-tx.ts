import {
  Account,
  Operation,
  TransactionBuilder,
  type Asset,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { DEFAULT_TX_VALIDITY_SECONDS } from "@/lib/stellar/ledger-clock";

// the one change_trust a plan step signs on its own (the BLND line ahead of the
// emissions claims, the line a pool exit pays into). the default (maximum)
// limit lets any payout fit. it bids the same per-op fee as the soroban steps
// and the classic batches' signing window. built off a copy of the account so
// the caller's sequence never moves.
export function buildTrustlineTx(
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
  asset: Asset,
): Transaction {
  const source = new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber());
  return new TransactionBuilder(source, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(DEFAULT_TX_VALIDITY_SECONDS)
    .build();
}
