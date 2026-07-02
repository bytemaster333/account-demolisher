// shared revoke primitive: build → sign → submit an approve(amount=0) tx for a
// single SEP-41 allowance, plus a confirmation poller.
//
// used by two callers:
//   - the per-row RevokeButton: submitRevoke only (enqueue-and-go, it treats
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

// serialize submits per source account. every revoke is built at Horizon's
// current sequence N and lands at N+1, so two concurrent submits for the same
// source both build at N+1 and one loses to tx_bad_seq. RevokeButton's disabled
// state is per-instance (no cross-row lock), so rapid clicks across rows could
// otherwise race; chaining here guarantees the previous submit has fully
// returned, and thus advanced the local view, before the next one re-reads
// Horizon.
const inFlight = new Map<string, Promise<unknown>>();

// build, sign and submit a revoke. resolves with the tx hash once the RPC
// accepts it (PENDING/DUPLICATE). does NOT wait for ledger inclusion.
export async function submitRevoke(
  network: NetworkConfig,
  connector: Connector,
  record: AllowanceRecord,
  userAddress: string,
): Promise<string> {
  const prev = inFlight.get(userAddress) ?? Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => submitRevokeImpl(network, connector, record, userAddress));
  inFlight.set(userAddress, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(userAddress) === run) inFlight.delete(userAddress);
  }
}

async function submitRevokeImpl(
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
  // only PENDING/DUPLICATE mean the RPC actually enqueued the tx. TRY_AGAIN_LATER
  // (mempool full / rate-limited) and ERROR did NOT sequence it, so returning
  // send.hash would hand back a phantom hash: the per-row button would flip to
  // "confirmed" for a still-live allowance, and the bulk poller would waste 30
  // attempts on a hash that never lands. mirror submitSoroban's allowlist guard.
  if (send.status !== "PENDING" && send.status !== "DUPLICATE") {
    const detail =
      send.status === "ERROR" && send.errorResult
        ? ` (${send.errorResult.result().switch().name})`
        : ` (status: ${send.status})`;
    throw new Error(`RPC did not enqueue the revoke${detail}.`);
  }
  return send.hash;
}

// poll a submitted revoke to ledger inclusion. throws if it fails to confirm.
// distinguishes a real on-chain FAILED (terminal: the tx was included and
// reverted) from an exhausted poll window (NOT_FOUND: the tx may still land),
// so the bulk sweep can report the right thing and not advance its sequence
// view on a tx that never sequenced.
export async function confirmRevoke(network: NetworkConfig, hash: string): Promise<void> {
  const rpc = getRpc(network);
  const result = await rpc.pollTransaction(hash, { attempts: 60 });
  if (result.status === "SUCCESS") return;
  if (result.status === "FAILED") {
    throw new Error("Revoke transaction failed on-chain.");
  }
  throw new Error("Revoke did not confirm within the polling window; it may still land.");
}
