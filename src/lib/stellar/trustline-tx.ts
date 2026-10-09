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
import { DEFAULT_TX_VALIDITY_SECONDS, ledgerMaxTime } from "@/lib/stellar/ledger-clock";

// the one change_trust a plan step signs on its own (the BLND line ahead of the
// emissions claims, the line a pool exit pays into). the default (maximum)
// limit lets any payout fit. it bids the same per-op fee as the soroban steps
// and the classic batches' signing window, counted from the latest ledger's
// close time (unix seconds). built off a copy of the account so the caller's
// sequence never moves.
export function buildTrustlineTx(
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
  asset: Asset,
  ledgerCloseTime: number,
): Transaction {
  const maxTime = ledgerMaxTime(ledgerCloseTime, DEFAULT_TX_VALIDITY_SECONDS);
  const source = new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber());
  return new TransactionBuilder(source, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimebounds(0, maxTime)
    .build();
}
