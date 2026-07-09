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

// serialize revokes per source account so the next one only *builds* after the
// previous one has landed in a ledger. This is the subtle part: submit-only
// acceptance (PENDING) does NOT advance Horizon's account sequence, only ledger
// inclusion does. So merely chaining the builds — as this used to — is not
// enough: two rapid per-row revokes for the same source would both build at the
// same sequence N+1 and the second loses to tx_bad_seq / TRY_AGAIN_LATER. The
// per-source gate below only opens once the previous revoke is confirmed
// included, so the next build reads an advanced sequence. RevokeButton's disabled
// state is per-instance (no cross-row lock), so this shared gate is what keeps
// rapid clicks across different rows correct. The bulk sweep is already
// inclusion-serialized by its own loop; the extra confirm here is a fast no-op
// for it (the tx is already included).
//
// value = a promise that resolves when it is safe to build the NEXT revoke for
// that source. A best-effort confirm opens it even on poll failure, so a tx that
// never lands can't deadlock the queue forever (worst case the next build waits
// out the poll window, still safer than a guaranteed sequence collision).
const sourceGate = new Map<string, Promise<void>>();

// build, sign and submit a revoke. resolves with the tx hash once the RPC
// accepts it (PENDING/DUPLICATE). does NOT wait for ledger inclusion before
// resolving to the caller, but internally holds the per-source gate closed until
// this tx is included so the next build for the same source is sequence-safe.
export async function submitRevoke(
  network: NetworkConfig,
  connector: Connector,
  record: AllowanceRecord,
  userAddress: string,
): Promise<string> {
  const prevGate = sourceGate.get(userAddress) ?? Promise.resolve();
  let openNext!: () => void;
  const nextGate = new Promise<void>((resolve) => {
    openNext = resolve;
  });
  // the next caller for this source waits on `nextGate`, which we only open once
  // this revoke is confirmed included
  sourceGate.set(
    userAddress,
    prevGate.then(
      () => nextGate,
      () => nextGate,
    ),
  );

  // wait our turn: the previous revoke for this source must have landed
  await prevGate.catch(() => {});
  try {
    const hash = await submitRevokeImpl(network, connector, record, userAddress);
    // open the gate for the next build only after inclusion; best-effort so a
    // stuck confirm still eventually releases the queue
    void confirmRevoke(network, hash)
      .catch(() => {})
      .finally(() => openNext());
    return hash;
  } catch (e) {
    // we never submitted (or it errored before enqueue); don't hold up the queue
    openNext();
    throw e;
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
