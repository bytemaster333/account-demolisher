// In-memory relay for multisig signing requests.
//
// A shared-account close is ONE transaction that several people must sign. This
// relay lets the initiator publish that transaction (never a secret key), gives
// it a short id, and lets authorized co-signers add their signatures from their
// own devices. The initiator's page subscribes and sees each signature the
// instant it lands. Nothing here is a secret: only the transaction envelope, a
// public artifact, is ever stored or served.
//
// State lives in-process, like the mediator route's rate-limiter: it is correct
// for a single self-hosted instance and for local dev, and does not survive a
// restart or fan out across serverless instances. Signing windows are short
// (72h) and abandoned plans are swept, so the memory stays bounded.
//
// Security posture:
//  - the id IS the transaction hash, so a co-signer can verify the fetched
//    transaction matches the link they were given (no server-side swap).
//  - a signature is only accepted if it belongs to a real signer of the account
//    (fetched from Horizon at publish time) AND was made over THIS transaction;
//    mergeSignatures enforces both, so garbage and cross-transaction signatures
//    are rejected rather than bloating the envelope.
//  - only classic account-close transactions are accepted.

import { Keypair, StrKey, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { resolveNetwork, type StellarNetwork } from "@/lib/config/networks";
import { mergeSignatures } from "@/lib/multisig/partial-xdr";
import { getHorizon } from "@/lib/stellar/horizon-client";

const SIGNING_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_PLANS = 500;
const MAX_XDR_CHARS = 12_000;
const MAX_SUBSCRIBERS = 50;

export interface PlanPublic {
  readonly network: StellarNetwork;
  readonly xdr: string;
}

// a live listener on a plan: `update` fires on each accepted signature; `close`
// is invoked when the plan is swept so its SSE stream is torn down proactively.
interface Subscriber {
  readonly update: (plan: PlanPublic) => void;
  readonly close: () => void;
}

interface PlanRecord {
  readonly network: StellarNetwork;
  xdr: string;
  readonly signerKeys: readonly string[];
  readonly createdAt: number;
  readonly subscribers: Set<Subscriber>;
}

const plans = new Map<string, PlanRecord>();

export type CreateResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export type SignResult =
  | { readonly ok: true; readonly plan: PlanPublic }
  | { readonly ok: false; readonly code: string; readonly reason: string };

// tear down a plan's live streams before dropping it, so no SSE heartbeat or
// subscriber closure outlives the record it references.
function terminate(rec: PlanRecord): void {
  for (const s of rec.subscribers) {
    try {
      s.close();
    } catch {
      // a broken close hook must not stop the others
    }
  }
  rec.subscribers.clear();
}

function sweepExpired(now: number): void {
  for (const [id, rec] of plans) {
    if (now - rec.createdAt > SIGNING_WINDOW_MS) {
      terminate(rec);
      plans.delete(id);
    }
  }
}

function isClassicTransaction(tx: Transaction | { innerTransaction?: unknown }): tx is Transaction {
  const candidate = tx as { feeSource?: unknown; innerTransaction?: unknown };
  return candidate.feeSource === undefined && candidate.innerTransaction === undefined;
}

// number of decorated signatures on an envelope; -1 if it can't be parsed. Used
// to only wake SSE subscribers when a signature was actually added.
function signatureCount(xdr: string, passphrase: string): number {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
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
    if (tx.signatures.some((ds) => kp.verify(hash, Buffer.from(ds.signature())))) out.push(key);
  }
  return out;
}

// Decode a close and identify the account it actually closes. The account is the
// accountMerge operation's effective source (op.source ?? tx.source) — NOT blindly
// tx.source — and every operation must share that same effective source, so an
// attacker can't fetch the signer set of an account they control while merging a
// victim account. Muxed / non-ed25519 sources are rejected.
function decodeClose(
  xdr: string,
  passphrase: string,
): { tx: Transaction; source: string } | null {
  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
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
  return { tx, source: closing };
}

// publish a close transaction. Returns its id (the transaction hash). The account
// is read from Horizon to learn its authorized signers, which bound the merge.
export async function createPlan(network: string, xdr: string): Promise<CreateResult> {
  const now = Date.now();
  sweepExpired(now);

  if (typeof xdr !== "string" || xdr.length === 0 || xdr.length > MAX_XDR_CHARS) {
    return { ok: false, code: "BAD_XDR", reason: "Missing or oversized transaction." };
  }
  const net = resolveNetwork(network);
  if (net.id !== network) {
    return { ok: false, code: "BAD_NETWORK", reason: "Unknown network." };
  }

  const decoded = decodeClose(xdr, net.passphrase);
  if (decoded === null) {
    return {
      ok: false,
      code: "NOT_A_CLOSE",
      reason: "Transaction must be a classic account-close (contains an account-merge).",
    };
  }

  const id = Buffer.from(decoded.tx.hash()).toString("hex");
  const existing = plans.get(id);
  if (existing !== undefined) {
    // same transaction re-published: merge in any new signatures. A malformed
    // re-publish is rejected rather than silently reporting success.
    try {
      const before = signatureCount(existing.xdr, net.passphrase);
      const merged = mergeSignatures(existing.xdr, [xdr], net.passphrase, {
        expectedSigners: existing.signerKeys,
      });
      existing.xdr = merged;
      // only wake subscribers when a signature actually landed (a duplicate
      // re-publish must not amplify into an SSE broadcast to every listener)
      if (signatureCount(merged, net.passphrase) > before) notify(existing);
    } catch {
      return {
        ok: false,
        code: "REJECTED",
        reason: "That signature isn't valid for this transaction or isn't from an authorized signer.",
      };
    }
    return { ok: true, id };
  }

  if (plans.size >= MAX_PLANS) {
    return { ok: false, code: "CAPACITY", reason: "Too many active signing requests; try later." };
  }

  let signerKeys: string[];
  try {
    const acct = await getHorizon(net).loadAccount(decoded.source);
    signerKeys = acct.signers
      .filter((s) => s.type === "ed25519_public_key" && s.weight > 0)
      .map((s) => s.key);
  } catch {
    return {
      ok: false,
      code: "ACCOUNT_UNREACHABLE",
      reason: "Couldn't read the account being closed from the network.",
    };
  }

  // proof of control: only an account's own authorized signer may open a request
  // to close it. This binds a slot to a real signer, so nobody can fill the store
  // with unsigned closes for accounts they don't control.
  if (signersOf(decoded.tx, signerKeys).length === 0) {
    return {
      ok: false,
      code: "UNSIGNED",
      reason: "Publish a transaction already signed by an authorized signer of the account.",
    };
  }

  // re-check capacity after the awaited Horizon round-trip: concurrent publishes
  // could each have passed the earlier check while all were in flight.
  if (plans.size >= MAX_PLANS) {
    return { ok: false, code: "CAPACITY", reason: "Too many active signing requests; try later." };
  }

  plans.set(id, {
    network: net.id,
    xdr,
    signerKeys,
    createdAt: now,
    subscribers: new Set(),
  });
  return { ok: true, id };
}

export function getPlan(id: string): PlanPublic | null {
  sweepExpired(Date.now());
  const rec = plans.get(id);
  return rec === undefined ? null : { network: rec.network, xdr: rec.xdr };
}

// add a co-signer's signatures. Only signatures that (a) are over exactly this
// transaction and (b) come from an authorized signer are kept; everything else
// is rejected by mergeSignatures.
export function addSignature(id: string, partialXdr: string): SignResult {
  sweepExpired(Date.now());
  const rec = plans.get(id);
  if (rec === undefined) {
    return { ok: false, code: "NOT_FOUND", reason: "This signing request no longer exists." };
  }
  if (typeof partialXdr !== "string" || partialXdr.length === 0 || partialXdr.length > MAX_XDR_CHARS) {
    return { ok: false, code: "BAD_XDR", reason: "Missing or oversized signature payload." };
  }
  const passphrase = resolveNetwork(rec.network).passphrase;
  let merged: string;
  const before = signatureCount(rec.xdr, passphrase);
  try {
    merged = mergeSignatures(rec.xdr, [partialXdr], passphrase, { expectedSigners: rec.signerKeys });
  } catch {
    return {
      ok: false,
      code: "REJECTED",
      reason: "That signature isn't valid for this transaction or isn't from an authorized signer.",
    };
  }
  rec.xdr = merged;
  // only broadcast when a NEW signature landed (a re-submitted duplicate must not
  // wake every SSE listener)
  if (signatureCount(merged, passphrase) > before) notify(rec);
  return { ok: true, plan: { network: rec.network, xdr: rec.xdr } };
}

// subscriber-slot status for a plan, so the SSE route can return a distinct 503
// (at capacity, retry) vs 404 (gone) instead of silently closing the stream.
export function subscriberStatus(id: string): "not-found" | "at-cap" | "ok" {
  const rec = plans.get(id);
  if (rec === undefined) return "not-found";
  return rec.subscribers.size >= MAX_SUBSCRIBERS ? "at-cap" : "ok";
}

// subscribe to a plan's updates; returns an unsubscribe function, or null if the
// plan is gone or already has the maximum number of live listeners (which bounds
// SSE connections, timers, and memory per plan). `update` fires on each accepted
// signature; `close` is invoked if the plan is swept while the stream is open.
export function subscribe(
  id: string,
  update: (plan: PlanPublic) => void,
  close: () => void = () => {},
): (() => void) | null {
  const rec = plans.get(id);
  if (rec === undefined) return null;
  if (rec.subscribers.size >= MAX_SUBSCRIBERS) return null;
  const sub: Subscriber = { update, close };
  rec.subscribers.add(sub);
  return () => {
    rec.subscribers.delete(sub);
  };
}

function notify(rec: PlanRecord): void {
  const snapshot: PlanPublic = { network: rec.network, xdr: rec.xdr };
  for (const s of rec.subscribers) {
    try {
      s.update(snapshot);
    } catch {
      // a broken subscriber must not stop the others
    }
  }
}

// test-only: drop all state
export function __resetRelayForTests(): void {
  plans.clear();
}

// test-only: seed a plan directly, bypassing the Horizon signer lookup that
// createPlan does, so the merge/subscribe/expiry logic can be exercised offline.
export function __seedPlanForTests(
  network: StellarNetwork,
  xdr: string,
  signerKeys: readonly string[],
  createdAt: number = Date.now(),
): string {
  const passphrase = resolveNetwork(network).passphrase;
  const id = Buffer.from(
    (TransactionBuilder.fromXDR(xdr, passphrase) as Transaction).hash(),
  ).toString("hex");
  plans.set(id, { network, xdr, signerKeys: [...signerKeys], createdAt, subscribers: new Set() });
  return id;
}

// verify a signer key derives (used defensively by callers); exported for tests
export function isValidSignerKey(key: string): boolean {
  try {
    Keypair.fromPublicKey(key);
    return true;
  } catch {
    return false;
  }
}
