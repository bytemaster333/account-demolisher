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

const STORAGE_KEY = "account-demolisher:signing-request";

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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearSigningRequest(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored, or storage unavailable: nothing to clear
  }
}

// the stored request for this account and network, or null. An expired one is
// removed, since the relay can no longer get it submitted.
export function loadSigningRequest(
  publicKey: string,
  networkId: string,
  nowMs: number,
): StoredSigningRequest | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearSigningRequest();
    return null;
  }
  if (!isStored(parsed)) {
    clearSigningRequest();
    return null;
  }
  if (parsed.validUntil !== null && parsed.validUntil <= nowMs) {
    clearSigningRequest();
    return null;
  }
  if (parsed.publicKey !== publicKey || parsed.networkId !== networkId) return null;
  return parsed;
}

function hashHex(tx: Transaction): string {
  return Buffer.from(tx.hash()).toString("hex");
}

// check an envelope fetched from the relay before showing or submitting it: the
// relay is a convenience, not a trusted party, so its envelope must hash to the
// request id we published and close this account to the reviewed destination
export function verifyRelayEnvelope(args: {
  readonly planId: string;
  readonly relay: RelayPlan;
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
