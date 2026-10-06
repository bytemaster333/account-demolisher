// terms of the mediator forward that both sides must agree on: the browser
// builds the forward with them and the co-signing route enforces them. no
// server-only imports, so the client and the route share one definition.

import { Memo, xdr } from "@stellar/stellar-sdk";

import { toSdkMemo } from "@/lib/stellar/memo";
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

// the sdk memo for a deposit memo as the app stores it, through the same
// conversion the classic batches use, so a base64 hash memo that the memo field
// accepts reaches the forward as the same 32 bytes. no memo is MemoNone.
export function forwardMemoToSdk(memo: ClassicMemo | undefined): Memo {
  return memo === undefined ? Memo.none() : toSdkMemo(memo);
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
