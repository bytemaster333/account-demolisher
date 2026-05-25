// thin wrappers over nativeToScVal / scValToNative for sep-41 args.

import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

export function address(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: "address" });
}

export function i128(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

export function u32(n: number): xdr.ScVal {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new RangeError(`u32 value out of range: ${n}`);
  }
  return nativeToScVal(n, { type: "u32" });
}

export function symbol(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: "symbol" });
}

export function vec(values: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(values);
}

export function fromScValAddress(v: xdr.ScVal): string {
  if (v.switch().name !== "scvAddress") {
    throw new TypeError(`Expected scvAddress ScVal, got ${v.switch().name}`);
  }
  return Address.fromScVal(v).toString();
}

export function fromScValI128(v: xdr.ScVal): bigint {
  if (v.switch().name !== "scvI128") {
    throw new TypeError(`Expected scvI128 ScVal, got ${v.switch().name}`);
  }
  const n = scValToNative(v);
  if (typeof n !== "bigint") {
    throw new TypeError(`scValToNative for scvI128 returned non-bigint: ${typeof n}`);
  }
  return n;
}

export function fromScValU32(v: xdr.ScVal): number {
  if (v.switch().name !== "scvU32") {
    throw new TypeError(`Expected scvU32 ScVal, got ${v.switch().name}`);
  }
  const n = scValToNative(v);
  if (typeof n !== "number") {
    throw new TypeError(`scValToNative for scvU32 returned non-number: ${typeof n}`);
  }
  return n;
}

export function fromScValSymbol(v: xdr.ScVal): string {
  if (v.switch().name !== "scvSymbol") {
    throw new TypeError(`Expected scvSymbol ScVal, got ${v.switch().name}`);
  }
  const n = scValToNative(v);
  if (typeof n !== "string") {
    throw new TypeError(`scValToNative for scvSymbol returned non-string: ${typeof n}`);
  }
  return n;
}

// sep-41 name()/symbol() return ScVal String. accepts both for completeness.
export function fromScValString(v: xdr.ScVal): string {
  const kind = v.switch().name;
  if (kind !== "scvString" && kind !== "scvSymbol") {
    throw new TypeError(`Expected scvString or scvSymbol ScVal, got ${kind}`);
  }
  const n = scValToNative(v);
  if (typeof n === "string") return n;
  if (n instanceof Uint8Array) return new TextDecoder().decode(n);
  throw new TypeError(`scValToNative for ${kind} returned unexpected type: ${typeof n}`);
}
