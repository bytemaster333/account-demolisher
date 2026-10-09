// the initiator's published signing request, kept in this browser so a reload
// during the (up to 72 hour) collection can pick it up again instead of making
// every co-signer sign a new transaction. Only the relay id and the inputs the
// close was built from are stored, never a key.

import { FeeBumpTransaction, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import type { RelayPlan } from "@/lib/multisig/plan-client";
import { inspectClose } from "@/lib/multisig/signing-request";
import type { ClassicMemo } from "@/lib/types/plan";

export interface StoredSigningRequest {
  readonly planId: string;
  readonly networkId: string;
  readonly publicKey: string;
  // the inputs the reviewed close was built from, to rebuild and compare it
  readonly destination: string;
  readonly memo?: ClassicMemo;
  readonly returnToIssuer: readonly string[];
  readonly sendToDestination: readonly string[];
  readonly selectedCbIds: readonly string[];
  // ms since epoch; the transaction's maxTime, after which it can't be submitted
  readonly validUntil: number | null;
  readonly createdAt: number;
}

// one record per account and network, so a request for a second shared
// account (or the same account on the other network) doesn't replace the first
const KEY_PREFIX = "account-demolisher:signing-request";

function storageKey(publicKey: string, networkId: string): string {
  return `${KEY_PREFIX}:${networkId}:${publicKey}`;
}

// where every request was stored before records were kept per account
const LEGACY_KEY = KEY_PREFIX;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isMemo(v: unknown): v is ClassicMemo {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    (m.type === "text" || m.type === "id" || m.type === "hash" || m.type === "return") &&
    typeof m.value === "string"
  );
}

function isStored(v: unknown): v is StoredSigningRequest {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.planId === "string" &&
    typeof r.networkId === "string" &&
    typeof r.publicKey === "string" &&
    typeof r.destination === "string" &&
    (r.memo === undefined || isMemo(r.memo)) &&
    isStringArray(r.returnToIssuer) &&
    isStringArray(r.sendToDestination) &&
    isStringArray(r.selectedCbIds) &&
    (r.validUntil === null || typeof r.validUntil === "number") &&
    typeof r.createdAt === "number"
  );
}

// storage can be unavailable (private mode, blocked site data). The request then
// only lives in this tab, as it did before; the caller is told so it can say so.
export function saveSigningRequest(record: StoredSigningRequest): boolean {
  try {
    window.localStorage.setItem(
      storageKey(record.publicKey, record.networkId),
      JSON.stringify(record),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearSigningRequest(publicKey: string, networkId: string): void {
  removeKey(storageKey(publicKey, networkId));
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // nothing stored, or storage unavailable: nothing to clear
  }
}

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

// the record under the old single key, moved to its own account's key when it
// belongs to this account and network. a record for another account stays put
// until that account loads it; an unreadable or expired one is removed.
function takeLegacy(
  publicKey: string,
  networkId: string,
  nowMs: number,
): StoredSigningRequest | null {
  const raw = readKey(LEGACY_KEY);
  if (raw === null) return null;
  const record = parseLive(raw, nowMs);
  if (record === null) {
    removeKey(LEGACY_KEY);
    return null;
  }
  if (record.publicKey !== publicKey || record.networkId !== networkId) return null;
  if (saveSigningRequest(record)) removeKey(LEGACY_KEY);
  return record;
}

// a stored record that is well formed and not expired, or null
function parseLive(raw: string, nowMs: number): StoredSigningRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isStored(parsed)) return null;
  if (parsed.validUntil !== null && parsed.validUntil <= nowMs) return null;
  return parsed;
}

// the stored request for this account and network, or null. An expired one is
// removed, since the relay can no longer get it submitted.
export function loadSigningRequest(
  publicKey: string,
  networkId: string,
  nowMs: number,
): StoredSigningRequest | null {
  const key = storageKey(publicKey, networkId);
  const raw = readKey(key);
  if (raw === null) return takeLegacy(publicKey, networkId, nowMs);
  const record = parseLive(raw, nowMs);
  // the key names the account and network, but a record that says otherwise
  // was not written by saveSigningRequest and is not offered
  if (record === null || record.publicKey !== publicKey || record.networkId !== networkId) {
    removeKey(key);
    return null;
  }
  return record;
}

function hashHex(tx: Transaction): string {
  return Buffer.from(tx.hash()).toString("hex");
}

// check an envelope fetched from the relay before showing or submitting it: the
// relay is a convenience, not a trusted party, so its envelope must hash to the
// request id we published and close this account to the reviewed destination
export function verifyRelayEnvelope(args: {
  readonly planId: string;
  readonly relay: Pick<RelayPlan, "network" | "xdr">;
  readonly expected: {
    readonly networkId: string;
    readonly publicKey: string;
    readonly destination: string;
  };
  readonly passphrase: string;
}):
  | { readonly ok: true; readonly tx: Transaction }
  | { readonly ok: false; readonly reason: string } {
  if (args.relay.network !== args.expected.networkId) {
    return { ok: false, reason: "The stored request belongs to a different network." };
  }
  let tx: Transaction;
  try {
    const decoded = TransactionBuilder.fromXdr(args.relay.xdr, args.passphrase);
    if (decoded instanceof FeeBumpTransaction) {
      return { ok: false, reason: "The relay returned something that isn't a close transaction." };
    }
    tx = decoded;
  } catch {
    return { ok: false, reason: "The relay returned a transaction that can't be read." };
  }
  if (hashHex(tx) !== args.planId.toLowerCase()) {
    return {
      ok: false,
      reason: "The relay returned a different transaction from the request you published.",
    };
  }
  const inspection = inspectClose(args.relay.xdr, args.passphrase);
  if (inspection === null || !inspection.isClose) {
    return { ok: false, reason: "The stored request isn't an account close." };
  }
  if (inspection.source !== args.expected.publicKey) {
    return { ok: false, reason: "The stored request closes a different account." };
  }
  if (inspection.mergeDestination !== args.expected.destination) {
    return { ok: false, reason: "The stored request sends to a different destination." };
  }
  return { ok: true, tx };
}

// whether two transactions do exactly the same thing: same operations in the
// same order and the same memo. Sequence, fee, time bounds and signatures differ
// between a rebuilt plan and the published request and are ignored.
export function sameOperationsAndMemo(a: Transaction, b: Transaction): boolean {
  const ba = envelopeBody(a);
  const bb = envelopeBody(b);
  const opsA = ba.operations.map((o) => o.toXdr("base64"));
  const opsB = bb.operations.map((o) => o.toXdr("base64"));
  if (opsA.length !== opsB.length || opsA.some((o, i) => o !== opsB[i])) return false;
  return ba.memo.toXdr("base64") === bb.memo.toXdr("base64");
}

function envelopeBody(t: Transaction) {
  const env = t.toEnvelope();
  if (env.type === "envelopeTypeTx") return env.v1.tx;
  if (env.type === "envelopeTypeTxV0") return env.v0.tx;
  throw new Error("a fee-bump envelope has no operations of its own");
}
