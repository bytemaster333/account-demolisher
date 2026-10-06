// in-memory relay for multisig signing requests.
//
// a shared-account close is one transaction that several people must sign. this
// relay lets the initiator publish that transaction (never a secret key), gives
// it a short id, and lets authorized co-signers add their signatures from their
// own devices. the initiator's page subscribes and sees each signature as it
// lands. nothing here is secret: only the transaction envelope, a public
// artifact, is stored or served.
//
// state lives in process, like the shared rate limiter in rate-limit.ts: correct
// for a single self-hosted instance, lost on restart, not shared across
// instances. plans expire with their transaction (at most 72h) and a background
// sweep releases them, so memory stays bounded.
//
// security posture:
//  - the id is the transaction hash, so a co-signer can check the fetched
//    transaction matches the link they were given (no server-side swap).
//  - a signature is only accepted if it belongs to a signer of the account
//    (read from Horizon at publish time) and was made over this transaction;
//    mergeSignatures enforces both.
//  - only classic account-close transactions are accepted, with a bounded expiry
//    and the account's next sequence number, so a slot can't be parked for days
//    with a transaction that could never be submitted.
//  - capacity is split per network and capped per closing account, so free
//    testnet accounts can't fill the slots mainnet users need.

import { Keypair, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { resolveNetwork, type StellarNetwork } from "@/lib/config/networks";
import {
  TooManySignaturesError,
  canonicalizeSignatures,
  mergeSignatures,
} from "@/lib/multisig/partial-xdr";
import { getHorizon } from "@/lib/stellar/horizon-client";

const SIGNING_WINDOW_MS = 72 * 60 * 60 * 1000;
// stop serving a plan slightly before its transaction's own maxTime, so a
// signature collected right at the edge still has time to reach Horizon.
const EXPIRY_GRACE_MS = 60 * 1000;
// clock skew tolerated between the initiator's device and this server
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// a request has to stay open at least this long to be worth publishing
const MIN_COLLECT_MS = 10 * 60 * 1000;
// a bundle of 100 operations with 20 signatures is about 20,100 base64 chars in
// the worst case (credit/credit offer cancels); see MAX_PLAN_BODY_BYTES.
const MAX_XDR_CHARS = 24_576;
// active plans per network. mainnet gets most of the room; testnet accounts are
// free to create, so they get a smaller budget of their own.
const NETWORK_BUDGET: Readonly<Record<string, number>> = { mainnet: 400, testnet: 100 };
const MAX_PLANS_PER_ACCOUNT = 3;
const MAX_SUBSCRIBERS = 50;
const MAX_SUBSCRIBERS_PER_CLIENT = 3;
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface PlanSigner {
  readonly key: string;
  readonly weight: number;
}

export interface PlanThresholds {
  readonly low: number;
  readonly med: number;
  readonly high: number;
}

export interface PlanPublic {
  readonly network: StellarNetwork;
  readonly xdr: string;
  // the account being closed and its signer set as read from Horizon at
  // publish. /sign and the initiator's view render this set, and the submit
  // path compares it against the live account before submitting.
  readonly account: string;
  readonly signers: readonly PlanSigner[];
  readonly thresholds: PlanThresholds;
  readonly expiresAt: number;
}

// a live listener on a plan: `update` fires on each accepted signature; `close`
// is invoked when the plan is swept so its SSE stream is torn down proactively.
interface Subscriber {
  readonly update: (plan: PlanPublic) => void;
  readonly close: () => void;
  readonly clientKey: string;
}

interface PlanRecord {
  readonly network: StellarNetwork;
  xdr: string;
  readonly account: string;
  readonly signers: readonly PlanSigner[];
  readonly thresholds: PlanThresholds;
  // when the plan stops being served, in epoch ms (see computeExpiry)
  readonly expiresAt: number;
  readonly subscribers: Set<Subscriber>;
}

const plans = new Map<string, PlanRecord>();
let sweeper: ReturnType<typeof setInterval> | null = null;

export type CreateResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export type SignResult =
  | { readonly ok: true; readonly plan: PlanPublic }
  | { readonly ok: false; readonly code: string; readonly reason: string };

const REJECTED = {
  ok: false,
  code: "REJECTED",
  reason: "That signature isn't valid for this transaction or isn't from an authorized signer.",
} as const;

function toPublic(rec: PlanRecord): PlanPublic {
  return {
    network: rec.network,
    xdr: rec.xdr,
    account: rec.account,
    signers: rec.signers,
    thresholds: rec.thresholds,
    expiresAt: rec.expiresAt,
  };
}

function signerKeysOf(rec: PlanRecord): readonly string[] {
  return rec.signers.map((s) => s.key);
}

// tear down a plan's live streams before dropping it, so no SSE heartbeat or
// subscriber closure outlives the record it references.
function terminate(rec: PlanRecord): void {
  for (const s of rec.subscribers) {
    try {
      s.close();
    } catch (e) {
      // a broken close hook must not stop the others
      console.error("signing relay: subscriber close hook threw", e);
    }
  }
  rec.subscribers.clear();
}

function sweepExpired(now: number): void {
  for (const [id, rec] of plans) {
    if (now >= rec.expiresAt) {
      terminate(rec);
      plans.delete(id);
    }
  }
}

// expired plans (and their open streams) are released even when no request
// arrives; unref'd so the timer never keeps the process alive on its own
function ensureSweeper(): void {
  if (sweeper !== null) return;
  sweeper = setInterval(() => sweepExpired(Date.now()), SWEEP_INTERVAL_MS);
  const t = sweeper as { unref?: () => void };
  t.unref?.();
}

// the transaction's own upper timebound in epoch ms, or null when it has none
// (maxTime 0 means "no upper bound" in Stellar, so it is treated as absent).
function txMaxTimeMs(tx: Transaction): number | null {
  const tb = tx.timeBounds;
  if (tb === undefined) return null;
  const secs = Number(tb.maxTime);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return secs * 1000;
}

function txMinTimeMs(tx: Transaction): number {
  const tb = tx.timeBounds;
  if (tb === undefined) return 0;
  const secs = Number(tb.minTime);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
}

// when a plan stops being served: the earlier of the publish window (72h from
// publish) and the transaction's own maxTime minus a small grace, so a fully
// collected bundle is never handed out after Horizon would reject it as
// tx_too_late.
function computeExpiry(tx: Transaction, createdAt: number): number {
  const windowExpiry = createdAt + SIGNING_WINDOW_MS;
  const max = txMaxTimeMs(tx);
  return max === null ? windowExpiry : Math.min(windowExpiry, max - EXPIRY_GRACE_MS);
}

function isClassicTransaction(tx: Transaction | { innerTransaction?: unknown }): tx is Transaction {
  const candidate = tx as { feeSource?: unknown; innerTransaction?: unknown };
  return candidate.feeSource === undefined && candidate.innerTransaction === undefined;
}

// number of decorated signatures on an envelope; -1 if it can't be parsed. used
// to only wake SSE subscribers when a signature was actually added.
function signatureCount(xdr: string, passphrase: string): number {
  try {
    const tx = TransactionBuilder.fromXdr(xdr, passphrase) as Transaction;
    return Array.isArray(tx.signatures) ? tx.signatures.length : -1;
  } catch {
    return -1;
  }
}

// which of the given signer keys have actually signed this transaction (full
// signature verification over the tx hash, hint-agnostic).
function signersOf(tx: Transaction, signerKeys: readonly string[]): string[] {
  if (typeof tx.hash !== "function" || !Array.isArray(tx.signatures)) return [];
  const hash = tx.hash();
  const out: string[] = [];
  for (const key of signerKeys) {
    let kp: Keypair;
    try {
      kp = Keypair.fromPublicKey(key);
    } catch {
      continue;
    }
    if (tx.signatures.some((ds) => kp.verify(hash, ds.signature.toBytes()))) out.push(key);
  }
  return out;
}

// decode a close and identify the account it actually closes. the account is the
// accountMerge operation's effective source (op.source ?? tx.source), not blindly
// tx.source, and every operation must share that same effective source, so an
// attacker can't fetch the signer set of an account they control while merging a
// victim account. muxed / non-ed25519 sources are rejected.
function decodeClose(xdr: string, passphrase: string): { tx: Transaction; source: string } | null {
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXdr(xdr, passphrase) as Transaction;
  } catch {
    return null;
  }
  if (!isClassicTransaction(tx) || !Array.isArray(tx.operations) || tx.operations.length === 0) {
    return null;
  }
  const mergeOp = tx.operations.find((op) => op.type === "accountMerge");
  if (mergeOp === undefined) return null;
  const closing = mergeOp.source ?? tx.source;
  if (!StrKey.isValidEd25519PublicKey(closing)) return null;
  // every op must operate on the account being closed, not a mix of accounts
  for (const op of tx.operations) {
    if ((op.source ?? tx.source) !== closing) return null;
  }
  // the sequence number is checked against the source account, which must be
  // the account being closed for that check to mean anything
  if (tx.source !== closing) return null;
  return { tx, source: closing };
}

// merge an incoming envelope's signatures into an existing record
function mergeInto(rec: PlanRecord, incomingXdr: string): SignResult {
  const passphrase = resolveNetwork(rec.network).passphrase;
  const before = signatureCount(rec.xdr, passphrase);
  let merged: string;
  try {
    merged = mergeSignatures(rec.xdr, [incomingXdr], passphrase, {
      expectedSigners: signerKeysOf(rec),
    });
  } catch (e) {
    if (e instanceof TooManySignaturesError) {
      return { ok: false, code: "TOO_MANY_SIGNATURES", reason: e.message };
    }
    return REJECTED;
  }
  rec.xdr = merged;
  // only broadcast when a new signature landed (a re-submitted duplicate must
  // not wake every SSE listener)
  if (signatureCount(merged, passphrase) > before) notify(rec);
  return { ok: true, plan: toPublic(rec) };
}

function countPlans(pred: (rec: PlanRecord) => boolean): number {
  let n = 0;
  for (const rec of plans.values()) if (pred(rec)) n += 1;
  return n;
}

// publish a close transaction. returns its id (the transaction hash). the account
// is read from Horizon to learn its authorized signers, which bound the merge.
export async function createPlan(network: string, xdr: string): Promise<CreateResult> {
  const now = Date.now();
  sweepExpired(now);
  ensureSweeper();

  if (typeof xdr !== "string" || xdr.length === 0 || xdr.length > MAX_XDR_CHARS) {
    return { ok: false, code: "BAD_XDR", reason: "Missing or oversized transaction." };
  }
  const budget = NETWORK_BUDGET[network];
  const net = resolveNetwork(network);
  if (budget === undefined || net.id !== network) {
    return { ok: false, code: "BAD_NETWORK", reason: "Unknown network." };
  }

  const decoded = decodeClose(xdr, net.passphrase);
  if (decoded === null) {
    return {
      ok: false,
      code: "NOT_A_CLOSE",
      reason:
        "Transaction must be a classic account-close (contains an account-merge) whose every operation and source is the account being closed.",
    };
  }

  const maxTime = txMaxTimeMs(decoded.tx);
  if (maxTime === null) {
    return {
      ok: false,
      code: "NO_EXPIRY",
      reason: "The transaction must expire within 72 hours (it has no upper time bound).",
    };
  }
  if (maxTime > now + SIGNING_WINDOW_MS + CLOCK_SKEW_MS) {
    return {
      ok: false,
      code: "EXPIRY_TOO_FAR",
      reason: "The transaction must expire within 72 hours.",
    };
  }
  if (txMinTimeMs(decoded.tx) > now + EXPIRY_GRACE_MS) {
    return {
      ok: false,
      code: "NOT_YET_VALID",
      reason: "The transaction isn't valid yet (its start time is in the future).",
    };
  }
  const expiresAt = computeExpiry(decoded.tx, now);
  if (expiresAt <= now + MIN_COLLECT_MS) {
    return {
      ok: false,
      code: "EXPIRED",
      reason: "This transaction expires too soon to collect signatures.",
    };
  }

  const id = Buffer.from(decoded.tx.hash()).toString("hex");
  const existing = plans.get(id);
  if (existing !== undefined) {
    // same transaction re-published: merge in any new signatures. a malformed
    // re-publish is rejected rather than silently reporting success.
    const merged = mergeInto(existing, xdr);
    return merged.ok ? { ok: true, id } : merged;
  }

  let signers: PlanSigner[];
  let thresholds: PlanThresholds;
  let accountSequence: string;
  try {
    const acct = await getHorizon(net).loadAccount(decoded.source);
    signers = acct.signers
      .filter((s) => s.type === "ed25519_public_key" && s.weight > 0)
      .map((s) => ({ key: s.key, weight: s.weight }));
    thresholds = {
      low: acct.thresholds.low_threshold,
      med: acct.thresholds.med_threshold,
      high: acct.thresholds.high_threshold,
    };
    accountSequence = acct.sequence;
  } catch {
    return {
      ok: false,
      code: "ACCOUNT_UNREACHABLE",
      reason: "Couldn't read the account being closed from the network.",
    };
  }

  if (BigInt(decoded.tx.sequence) !== BigInt(accountSequence) + 1n) {
    return {
      ok: false,
      code: "STALE_SEQUENCE",
      reason:
        "This transaction doesn't use the account's next sequence number, so it could never be submitted. Rebuild the request.",
    };
  }

  const signerKeys = signers.map((s) => s.key);
  // proof of control: only an account's own authorized signer may open a request
  // to close it. this binds a slot to a real signer, so nobody can fill the store
  // with unsigned closes for accounts they don't control.
  if (signersOf(decoded.tx, signerKeys).length === 0) {
    return {
      ok: false,
      code: "UNSIGNED",
      reason: "Publish a transaction already signed by an authorized signer of the account.",
    };
  }

  // a concurrent publish of the same transaction may have created the record
  // while the Horizon lookup was in flight: merge into it rather than replace
  // it, which would drop collected signatures and orphan its subscribers.
  const raced = plans.get(id);
  if (raced !== undefined) {
    const merged = mergeInto(raced, xdr);
    return merged.ok ? { ok: true, id } : merged;
  }

  // capacity is checked after the awaited lookup, since concurrent publishes
  // could each have passed an earlier check while all were in flight
  if (countPlans((r) => r.network === net.id) >= budget) {
    return { ok: false, code: "CAPACITY", reason: "Too many active signing requests; try later." };
  }
  if (
    countPlans((r) => r.network === net.id && r.account === decoded.source) >= MAX_PLANS_PER_ACCOUNT
  ) {
    return {
      ok: false,
      code: "ACCOUNT_LIMIT",
      reason: `This account already has ${MAX_PLANS_PER_ACCOUNT} open signing requests. Let one expire or finish it first.`,
    };
  }

  // keep only verified signatures from the account's signers, one per key, so
  // junk or padding in the published envelope can't block later co-signers
  let canonicalXdr: string;
  try {
    canonicalXdr = canonicalizeSignatures(xdr, net.passphrase, signerKeys);
  } catch (e) {
    if (e instanceof TooManySignaturesError) {
      return { ok: false, code: "TOO_MANY_SIGNATURES", reason: e.message };
    }
    throw e;
  }

  plans.set(id, {
    network: net.id,
    xdr: canonicalXdr,
    account: decoded.source,
    signers,
    thresholds,
    expiresAt,
    subscribers: new Set(),
  });
  return { ok: true, id };
}

export function getPlan(id: string): PlanPublic | null {
  sweepExpired(Date.now());
  const rec = plans.get(id);
  return rec === undefined ? null : toPublic(rec);
}

// add a co-signer's signatures. only signatures that (a) are over exactly this
// transaction and (b) come from an authorized signer are kept; everything else
// is rejected by mergeSignatures.
export function addSignature(id: string, partialXdr: string): SignResult {
  sweepExpired(Date.now());
  const rec = plans.get(id);
  if (rec === undefined) {
    return { ok: false, code: "NOT_FOUND", reason: "This signing request no longer exists." };
  }
  if (
    typeof partialXdr !== "string" ||
    partialXdr.length === 0 ||
    partialXdr.length > MAX_XDR_CHARS
  ) {
    return { ok: false, code: "BAD_XDR", reason: "Missing or oversized signature payload." };
  }
  return mergeInto(rec, partialXdr);
}

// subscriber-slot status for a plan and one client, so the SSE route can answer
// 404 (gone) or 503 (no free slot) before opening a stream
export function subscriberStatus(
  id: string,
  clientKey: string,
): "not-found" | "at-cap" | "client-at-cap" | "ok" {
  sweepExpired(Date.now());
  const rec = plans.get(id);
  if (rec === undefined) return "not-found";
  if (rec.subscribers.size >= MAX_SUBSCRIBERS) return "at-cap";
  let mine = 0;
  for (const s of rec.subscribers) if (s.clientKey === clientKey) mine += 1;
  return mine >= MAX_SUBSCRIBERS_PER_CLIENT ? "client-at-cap" : "ok";
}

// subscribe to a plan's updates; returns an unsubscribe function, or null if the
// plan is gone or has no free slot (overall, or for this client). `update` fires
// on each accepted signature; `close` is invoked if the plan is swept while the
// stream is open.
export function subscribe(
  id: string,
  update: (plan: PlanPublic) => void,
  close: () => void,
  clientKey: string,
): (() => void) | null {
  if (subscriberStatus(id, clientKey) !== "ok") return null;
  const rec = plans.get(id)!;
  const sub: Subscriber = { update, close, clientKey };
  rec.subscribers.add(sub);
  return () => {
    rec.subscribers.delete(sub);
  };
}

function notify(rec: PlanRecord): void {
  const snapshot = toPublic(rec);
  for (const s of rec.subscribers) {
    try {
      s.update(snapshot);
    } catch (e) {
      // a broken subscriber must not stop the others
      console.error("signing relay: subscriber update threw", e);
    }
  }
}

// test-only: drop all state
export function __resetRelayForTests(): void {
  for (const rec of plans.values()) terminate(rec);
  plans.clear();
  if (sweeper !== null) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

// test-only: seed a plan directly, bypassing the Horizon signer lookup that
// createPlan does, so the merge/subscribe/expiry logic can be exercised offline.
export function __seedPlanForTests(
  network: StellarNetwork,
  xdr: string,
  signerKeys: readonly string[],
  createdAt: number = Date.now(),
  thresholds: PlanThresholds = { low: 0, med: 0, high: 0 },
): string {
  ensureSweeper();
  const passphrase = resolveNetwork(network).passphrase;
  const tx = TransactionBuilder.fromXdr(xdr, passphrase) as Transaction;
  const id = Buffer.from(tx.hash()).toString("hex");
  plans.set(id, {
    network,
    xdr,
    account: tx.source,
    signers: signerKeys.map((key) => ({ key, weight: 1 })),
    thresholds,
    expiresAt: computeExpiry(tx, createdAt),
    subscribers: new Set(),
  });
  return id;
}
