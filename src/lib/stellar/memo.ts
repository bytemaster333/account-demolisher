// one conversion from the app's memo shape to the sdk Memo, shared by every
// builder that attaches a memo (the classic batches and the mediator forward)

import { Memo } from "@stellar/stellar-sdk";

export type MemoKind = "text" | "id" | "hash" | "return";

export interface MemoInput {
  readonly type: MemoKind;
  readonly value: string;
}

const HEX_32 = /^[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// validateMemoFormat accepts a hash or return memo as 64 hex characters or as
// base64 of 32 bytes, but Memo.hash and Memo.return only take hex or raw bytes,
// so both forms are decoded to bytes here
export function memoHashBytes(value: string): Uint8Array {
  const v = value.trim();
  if (HEX_32.test(v)) {
    return Uint8Array.from({ length: 32 }, (_, i) =>
      Number.parseInt(v.slice(i * 2, i * 2 + 2), 16),
    );
  }
  if (BASE64.test(v) && v.length % 4 === 0) {
    const binary = atob(v);
    if (binary.length === 32) return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  throw new Error(
    `A hash or return memo must be 32 bytes, given as 64 hex characters or base64; got "${value}".`,
  );
}

export function toSdkMemo(memo: MemoInput): Memo {
  switch (memo.type) {
    case "text":
      return Memo.text(memo.value);
    case "id":
      return Memo.id(memo.value);
    case "hash":
      return Memo.hash(memoHashBytes(memo.value));
    case "return":
      return Memo.return(memoHashBytes(memo.value));
  }
}
