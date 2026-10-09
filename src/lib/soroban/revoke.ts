// shared revoke primitive: build an approve(amount=0) tx for a SEP-41 allowance,
// show what signing it costs, then sign and submit it, plus a confirmation poller.
//
// building and signing are two steps so the fee is on screen before anything is
// signed: the token's own code sizes a revoke's resources, and a pasted-secret
// connector signs without any prompt of its own.
//
// both callers submit and then wait for confirmRevoke:
//   - the per-row RevokeButton shows "Revoked" only on SUCCESS from the ledger,
//     and a "not confirmed" warning with the tx link otherwise, since a dropped
//     approve(0) leaves the allowance live
//   - bulk revoke confirms each tx before the next one is signed; signing the
//     next revoke before the previous confirmed would reuse a stale sequence and
//     get rejected as tx_bad_seq

import { Account, TransactionBuilder, type Transaction, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { buildRevoke, type AllowanceRecord } from "@/lib/soroban/allowances";
import { assertSorobanFeeWithinCap, type SorobanFeeBreakdown } from "@/lib/soroban/fee-cap";
import { assertSafeRevokeInvocation } from "@/lib/soroban/revoke-guard";
import { getRpc } from "@/lib/soroban/rpc-client";
import { pollSoroban, sendSoroban, SorobanNotQueuedError } from "@/lib/soroban/submit";
import { stroopsToTrimmedDecimal } from "@/lib/stellar/amount";
import { fetchLedgerClock } from "@/lib/stellar/ledger-clock";
import type { Connector } from "@/lib/wallet/connector";

// serialize revokes per source account so the next one is only *signed* after
// the previous one has landed in a ledger. this is the subtle part: submit-only
// acceptance (PENDING) does not advance the account sequence, only ledger
// inclusion does. two rapid per-row revokes for the same source would otherwise
// both go out at sequence N+1 and the second loses to tx_bad_seq /
// TRY_AGAIN_LATER. the per-source gate below only opens once the previous revoke
// is confirmed included by the soroban rpc, and the sequence check before signing
// reads the account from that same rpc, so it sees the advanced sequence (horizon
// ingests separately and can lag the rpc's SUCCESS). RevokeButton's state is
// per-instance (no cross-row lock), so this shared gate is what keeps rapid
// clicks across different rows correct. the bulk sweep is already
// inclusion-serialized by its own loop; the extra confirm here is a fast no-op
// for it.
//
// value = a promise that resolves when it is safe to sign the next revoke for
// that source. a best-effort confirm opens it even on poll failure, and a timer
// opens it if the confirm never settles, so a tx that never lands can't deadlock
// the queue (worst case the next one hits tx_bad_seq and the user retries).
const sourceGate = new Map<string, Promise<void>>();

// longer than a full confirmRevoke poll (60 attempts) on a healthy rpc
export const REVOKE_GATE_RELEASE_MS = 90_000;

// a built, guarded and fee-capped revoke, waiting for the user to accept its fee
export interface PreparedRevoke {
  readonly network: NetworkConfig;
  readonly record: AllowanceRecord;
  readonly userAddress: string;
  readonly tx: Transaction;
  // what signing tx authorizes; the user sees fee.totalFee before signing
  readonly fee: SorobanFeeBreakdown;
}

export interface RevokePreparationFailure {
  readonly record: AllowanceRecord;
  readonly error: unknown;
}

export interface RevokePreparation {
  readonly prepared: readonly PreparedRevoke[];
  readonly failed: readonly RevokePreparationFailure[];
}

export interface PrepareRevokesOptions {
  // called after each record is built or has failed, with how many are done
  readonly onProgress?: (done: number) => void;
  // stops building the remaining records; the call then rejects with the reason
  readonly signal?: AbortSignal;
}

// the reviewed revoke could not be signed as it was (its sequence number or time
// bound went stale), and the rebuilt one costs more than the fee the user
// accepted, so nothing was signed. `current` is the rebuilt revoke to review.
export class RevokeFeeChangedError extends Error {
  readonly reviewed: PreparedRevoke;
  readonly current: PreparedRevoke;
  constructor(reviewed: PreparedRevoke, current: PreparedRevoke) {
    super(
      `The fee for this revoke rose to ${stroopsToTrimmedDecimal(current.fee.totalFee)} XLM ` +
        `from the ${stroopsToTrimmedDecimal(reviewed.fee.totalFee)} XLM you reviewed, so it was not signed.`,
    );
    this.name = "RevokeFeeChangedError";
    this.reviewed = reviewed;
    this.current = current;
  }
}

// guard against the wallet's active account drifting from the one the revoke is
// for. a kit connector signs with whatever account the extension currently
// holds, so a user switching accounts inside the wallet after connecting would
// otherwise sign as the wrong key; SEP-41 requires source == from, so it would
// fail opaquely at submit. a pasted-seed connector's key is fixed, so this is a
// no-op for it.
async function assertSigner(connector: Connector, userAddress: string): Promise<void> {
  const signerKey = await connector.getPublicKey();
  if (signerKey !== userAddress) {
    throw new Error(
      "Your wallet's active account changed. Switch back to the account that owns this address, or reconnect it, to revoke.",
    );
  }
}

async function buildCheckedRevoke(
  server: rpc.Server,
  network: NetworkConfig,
  record: AllowanceRecord,
  userAddress: string,
  sourceAccount: Account,
  currentLedger: number,
  ledgerCloseTime: number,
): Promise<PreparedRevoke> {
  const tx = await buildRevoke(
    server,
    record.contractId,
    userAddress,
    record.spender,
    currentLedger,
    network,
    sourceAccount,
    ledgerCloseTime,
  );
  // the contract id came from an attacker-influenceable event scan and the revoke
  // path is exempt from the DeFi allow-list, so the simulation-supplied auth tree
  // is untrusted. refuse it unless the built tx is exactly approve(0) and its auth
  // authorizes nothing else (blocks auth-entry smuggling by a hostile token).
  assertSafeRevokeInvocation(tx, {
    contractId: record.contractId,
    from: userAddress,
    spender: record.spender,
  });
  // the token's own code sized this tx's resources and fee; refuse one that would
  // charge the user for an oversized write (rent) or an inflated simulation
  const fee = assertSorobanFeeWithinCap(tx, "untrusted-token");
  return { network, record, userAddress, tx, fee };
}

// build revokes for review, nothing is signed. they take consecutive sequence
// numbers in the order given, so a sweep that signs them in that order signs
// each one exactly as reviewed. a record that fails to build (simulation error,
// auth guard, fee cap) is reported and takes no sequence number.
export async function prepareRevokes(
  network: NetworkConfig,
  connector: Connector,
  records: readonly AllowanceRecord[],
  userAddress: string,
  options: PrepareRevokesOptions = {},
): Promise<RevokePreparation> {
  await assertSigner(connector, userAddress);
  // a revoke still waiting for its ledger moves this account's sequence; build
  // after it lands so the reviewed tx is the one that gets signed
  await (sourceGate.get(userAddress) ?? Promise.resolve());

  const server = getRpc(network);
  const { sequence: currentLedger } = await server.getLatestLedger();
  // the tx's time bound counts from the network's clock, not the browser's
  const clock = await fetchLedgerClock(network);
  // read the sequence from the rpc that confirms revokes, not from horizon, which
  // ingests on its own schedule and can still report an old one
  const account = await server.getAccount(userAddress);
  let sequence = BigInt(account.sequenceNumber());

  const prepared: PreparedRevoke[] = [];
  const failed: RevokePreparationFailure[] = [];
  for (const record of records) {
    options.signal?.throwIfAborted();
    try {
      const one = await buildCheckedRevoke(
        server,
        network,
        record,
        userAddress,
        new Account(userAddress, sequence.toString()),
        currentLedger,
        clock.closedAt,
      );
      prepared.push(one);
      sequence += 1n;
    } catch (error: unknown) {
      failed.push({ record, error });
    }
    options.onProgress?.(prepared.length + failed.length);
  }
  return { prepared, failed };
}

// build one revoke for review. rejects with the build, guard or fee-cap error
export async function prepareRevoke(
  network: NetworkConfig,
  connector: Connector,
  record: AllowanceRecord,
  userAddress: string,
): Promise<PreparedRevoke> {
  const { prepared, failed } = await prepareRevokes(network, connector, [record], userAddress);
  const failure = failed[0];
  if (failure !== undefined) throw failure.error;
  return prepared[0]!;
}

// sign and submit a reviewed revoke. resolves with the tx hash once the RPC
// accepts it (PENDING/DUPLICATE). it does not wait for ledger inclusion before
// resolving to the caller, but internally holds the per-source gate closed until
// this tx is included so the next one for the same source is sequence-safe.
export async function submitPreparedRevoke(
  connector: Connector,
  revoke: PreparedRevoke,
): Promise<string> {
  const { network, userAddress } = revoke;
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
    const hash = await signAndSend(connector, revoke);
    // open the gate for the next one only after inclusion; best-effort, and
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

async function signAndSend(connector: Connector, revoke: PreparedRevoke): Promise<string> {
  const { network, record, userAddress } = revoke;
  // the wallet can switch accounts while the fee is on screen
  await assertSigner(connector, userAddress);

  const server = getRpc(network);
  const account = await server.getAccount(userAddress);
  const clock = await fetchLedgerClock(network);

  // another revoke for this account may have landed since this one was built,
  // or its five-minute time bound may have run out while the fee was on screen.
  // either way the reviewed tx can't land, so it is rebuilt, and the rebuilt one
  // is signed only when it costs no more than the fee the user accepted.
  let tx = revoke.tx;
  const maxTime = Number(tx.timeBounds?.maxTime ?? "0");
  const sequenceCurrent = BigInt(tx.sequence) === BigInt(account.sequenceNumber()) + 1n;
  // the next ledger closes after the latest one, so a bound at or before the
  // latest close time can no longer be met
  const timeCurrent = maxTime === 0 || clock.closedAt < maxTime;
  if (!sequenceCurrent || !timeCurrent) {
    const { sequence: currentLedger } = await server.getLatestLedger();
    const rebuilt = await buildCheckedRevoke(
      server,
      network,
      record,
      userAddress,
      account,
      currentLedger,
      clock.closedAt,
    );
    if (rebuilt.fee.totalFee > revoke.fee.totalFee) {
      throw new RevokeFeeChangedError(revoke, rebuilt);
    }
    tx = rebuilt.tx;
  }

  const signed = await connector.signTransaction(tx, network.passphrase);
  const reconstructed = TransactionBuilder.fromXdr(
    signed.signedXdr,
    network.passphrase,
  ) as Transaction;

  // only PENDING/DUPLICATE mean the RPC actually enqueued the tx. anything
  // else did not sequence it, so returning its hash would hand back a phantom:
  // the per-row button would flip to "confirmed" for a still-live allowance, and
  // the bulk poller would wait out its window on a hash that never lands.
  try {
    return await sendSoroban(server, reconstructed);
  } catch (err) {
    if (err instanceof SorobanNotQueuedError) {
      throw new Error(
        `RPC did not enqueue the revoke (${err.resultCode ?? `status: ${err.status}`}).`,
        {
          cause: err,
        },
      );
    }
    throw err;
  }
}

// poll a submitted revoke to ledger inclusion. throws if it fails to confirm.
// distinguishes a real on-chain FAILED (terminal: the tx was included and
// reverted) from an exhausted poll window (NOT_FOUND: the tx may still land),
// so the bulk sweep can report the right thing and not advance its sequence
// view on a tx that never sequenced.
export async function confirmRevoke(network: NetworkConfig, hash: string): Promise<void> {
  const result = await pollSoroban(getRpc(network), hash);
  if (result.status === "SUCCESS") return;
  if (result.status === "FAILED") {
    throw new Error(
      `Revoke transaction failed on-chain${result.reason ? `: ${result.reason}` : ""}`,
    );
  }
  throw new Error("Revoke did not confirm within the polling window; it may still land.");
}
