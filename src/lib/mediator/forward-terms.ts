// terms of the mediator forward that both sides must agree on: the browser
// builds the forward with them and the co-signing route enforces them. no
// server-only imports, so the client and the route share one definition.

import { Memo, xdr } from "@stellar/stellar-sdk";

import type { ClassicMemo } from "@/lib/types/plan";

// payment + accountMerge, nothing else
export const FORWARD_OPERATION_COUNT = 2;

// highest per-op fee the forward will ever bid while escalating, and the cap the
// co-signer enforces so a token holder can't get a forward that burns the
// balance on fees. 0.1 XLM per op, same ceiling as the close's own fee logic.
export const MAX_FORWARD_FEE_PER_OP = 1_000_000;
export const MAX_FORWARD_FEE = MAX_FORWARD_FEE_PER_OP * FORWARD_OPERATION_COUNT;

// networks a flow token can be bound to
export type MediatorNetworkId = "mainnet" | "testnet";

export function isMediatorNetworkId(value: unknown): value is MediatorNetworkId {
  return value === "mainnet" || value === "testnet";
}

// the sdk memo for a deposit memo as the app stores it. hash and return values
// are accepted as 64 hex chars or as base64 of 32 bytes, the two forms the memo
// field validation allows; the sdk itself only parses hex.
export function forwardMemoToSdk(memo: ClassicMemo | undefined): Memo {
  if (memo === undefined) return Memo.none();
  switch (memo.type) {
    case "text":
      return Memo.text(memo.value);
    case "id":
      return Memo.id(memo.value);
    case "hash":
      return Memo.hash(hashMemoBytes(memo.value));
    case "return":
      return Memo.return(hashMemoBytes(memo.value));
  }
}

function hashMemoBytes(value: string): Uint8Array {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(v)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number.parseInt(v.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (/^[A-Za-z0-9+/]{43}=$/u.test(v)) {
    const bin = atob(v);
    if (bin.length === 32) return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  throw new Error("A hash or return memo must be 32 bytes as 64 hex chars or 44 base64 chars.");
}

// canonical form of a memo: its xdr, base64. comparing these compares type and
// exact bytes, so text vs id "123" or a different hash can never match.
export function encodeMemoCommitment(memo: Memo): string {
  return memo.toXdrObject().toXdr("base64");
}

// parse a memo commitment back. returns null for anything that is not exactly
// one well-formed memo (bad base64, oversize text, trailing bytes).
export function decodeMemoCommitment(commitment: string): Memo | null {
  try {
    const memo = Memo.fromXdrObject(xdr.Memo.fromXdr(commitment, "base64"));
    // reject non-canonical spellings of the same bytes so the token holds one form
    return encodeMemoCommitment(memo) === commitment ? memo : null;
  } catch {
    return null;
  }
}
