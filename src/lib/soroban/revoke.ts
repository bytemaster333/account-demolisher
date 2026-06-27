// shared revoke primitive: build → sign → submit an approve(amount=0) tx for a
// single SEP-41 allowance, plus a confirmation poller.
//
// used by two callers:
//   - the per-row RevokeButton: submitRevoke only (enqueue-and-go — it treats
//     RPC acceptance as success and lets the user reload for finality)
//   - bulk revoke: submitRevoke + confirmRevoke, so each tx lands in a ledger
//     before the next reloads the source account's sequence number. submitting
//     the next revoke before the previous confirmed would reuse a stale sequence
//     and get rejected as tx_bad_seq.

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { buildRevoke, type AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
import { getHorizon } from "@/lib/stellar/horizon-client";
import type { Connector } from "@/lib/wallet/connector";

// build, sign and submit a revoke. resolves with the tx hash once the RPC
// accepts it (PENDING/DUPLICATE). does NOT wait for ledger inclusion.
export async function submitRevoke(
  network: NetworkConfig,
  connector: Connector,
  record: AllowanceRecord,
  userAddress: string,
): Promise<string> {
  const rpc = getRpc(network);
  const { sequence: currentLedger } = await rpc.getLatestLedger();

  const horizon = getHorizon(network);
  const sourceAccount = await horizon.loadAccount(userAddress);

  const tx: Transaction = await buildRevoke(
    rpc,
    record.contractId,
    userAddress,
    record.spender,
    currentLedger,
    network,
    sourceAccount,
  );

  const signed = await connector.signTransaction(tx, network.passphrase);
  const reconstructed = TransactionBuilder.fromXDR(
    signed.signedXdr,
    network.passphrase,
  ) as Transaction;

  const send = await rpc.sendTransaction(reconstructed);
  if (send.status === "ERROR") {
    const detail = send.errorResult ? ` (${send.errorResult.result().switch().name})` : "";
    throw new Error(`RPC rejected transaction${detail}.`);
  }
  return send.hash;
}

// poll a submitted revoke to ledger inclusion. throws if it fails to confirm.
export async function confirmRevoke(network: NetworkConfig, hash: string): Promise<void> {
  const rpc = getRpc(network);
  const result = await rpc.pollTransaction(hash, { attempts: 30 });
  if (result.status !== "SUCCESS") {
    throw new Error(`Revoke did not confirm on-chain (status: ${result.status}).`);
  }
}
