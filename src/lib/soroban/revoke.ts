// shared revoke primitive: build, sign and submit an approve(amount=0) tx for a
// single SEP-41 allowance, plus a confirmation poller.
//
// both callers submit and then wait for confirmRevoke:
//   - the per-row RevokeButton shows "Revoked" only on SUCCESS from the ledger,
//     and a "not confirmed" warning with the tx link otherwise, since a dropped
//     approve(0) leaves the allowance live
//   - bulk revoke confirms each tx before the next one reloads the source
//     account's sequence number; submitting the next revoke before the previous
//     confirmed would reuse a stale sequence and get rejected as tx_bad_seq

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { buildRevoke, type AllowanceRecord } from "@/lib/soroban/allowances";
import { describeSorobanFailure } from "@/lib/soroban/diagnostics";
import { assertSorobanFeeWithinCap } from "@/lib/soroban/fee-cap";
import { assertSafeRevokeInvocation } from "@/lib/soroban/revoke-guard";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { Connector } from "@/lib/wallet/connector";

// serialize revokes per source account so the next one only *builds* after the
// previous one has landed in a ledger. This is the subtle part: submit-only
// acceptance (PENDING) does NOT advance the account sequence, only ledger
// inclusion does. So merely chaining the builds, as this used to, is not
// enough: two rapid per-row revokes for the same source would both build at the
// same sequence N+1 and the second loses to tx_bad_seq / TRY_AGAIN_LATER. The
// per-source gate below only opens once the previous revoke is confirmed
// included by the soroban rpc, and the next build reads the account from that
// same rpc, so it sees the advanced sequence (horizon ingests separately and can
// lag the rpc's SUCCESS). RevokeButton's disabled state is per-instance (no
// cross-row lock), so this shared gate is what keeps rapid clicks across
// different rows correct. The bulk sweep is already inclusion-serialized by its
// own loop; the extra confirm here is a fast no-op for it.
//
// value = a promise that resolves when it is safe to build the NEXT revoke for
// that source. A best-effort confirm opens it even on poll failure, and a timer
// opens it if the confirm never settles, so a tx that never lands can't deadlock
// the queue (worst case the next build hits tx_bad_seq and the user retries).
const sourceGate = new Map<string, Promise<void>>();

// longer than a full confirmRevoke poll (60 attempts) on a healthy rpc
export const REVOKE_GATE_RELEASE_MS = 90_000;

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
    // open the gate for the next build only after inclusion; best-effort, and
    // bounded by a timer so a confirm that never settles still releases the queue
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      confirmRevoke(network, hash).catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REVOKE_GATE_RELEASE_MS);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      openNext();
    });
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
  // guard against the wallet's active account drifting from the one this revoke
  // is built for. A kit connector signs with whatever account the extension
  // currently holds, so a user switching accounts inside the wallet after
  // connecting would otherwise sign as the wrong key; SEP-41 requires
  // source == from, so it would fail opaquely at submit. Assert up front and
  // refuse with a clear message. (A pasted-seed connector's key is fixed, so
  // this is a no-op for it.)
  const signerKey = await connector.getPublicKey();
  if (signerKey !== userAddress) {
    throw new Error(
      "Your wallet's active account changed. Switch back to the account that owns this address, or reconnect it, to revoke.",
    );
  }

  const rpc = getRpc(network);
  const { sequence: currentLedger } = await rpc.getLatestLedger();

  // read the sequence from the rpc that confirmed the previous revoke, not from
  // horizon, which ingests on its own schedule and can still report the old one
  const sourceAccount = await rpc.getAccount(userAddress);

  const tx: Transaction = await buildRevoke(
    rpc,
    record.contractId,
    userAddress,
    record.spender,
    currentLedger,
    network,
    sourceAccount,
  );

  // The contract id came from an attacker-influenceable event scan and the revoke
  // path is exempt from the DeFi allow-list, so the simulation-supplied auth tree
  // is untrusted. Refuse to sign unless the built tx is exactly approve(0) and its
  // auth authorizes nothing else (blocks auth-entry smuggling by a hostile token).
  assertSafeRevokeInvocation(tx, {
    contractId: record.contractId,
    from: userAddress,
    spender: record.spender,
  });
  // the token's own code sized this tx's resources and fee; refuse one that would
  // charge the user for an oversized write (rent) or an inflated simulation
  assertSorobanFeeWithinCap(tx, "untrusted-token");

  const signed = await connector.signTransaction(tx, network.passphrase);
  const reconstructed = TransactionBuilder.fromXdr(
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
        ? ` (${send.errorResult.result.type})`
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
    const reason = describeSorobanFailure(result.diagnosticEventsXdr);
    throw new Error(`Revoke transaction failed on-chain${reason ? `: ${reason}` : ""}`);
  }
  throw new Error("Revoke did not confirm within the polling window; it may still land.");
}
