import { describe, it, expect } from "vitest";
import {
  Operation,
  nativeToScVal,
  scValToNative,
  xdr,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  decodeOptionalVaultKey,
  findPrevVaultKey,
  optionalVaultKeyScVal,
  type VaultKey,
} from "@/lib/adapters/fxdao/prev-key";
import type { simulate } from "@/lib/soroban/simulate";
import type { SimulationResult } from "@/lib/soroban/simulate";
import { TESTNET } from "@/lib/config/networks";

// The on-chain FxDAO VaultKey is a three-field Soroban struct
// (account: Address, denomination: Symbol, index: u128). prev-key.ts encodes
// the prev_key arg of pay_debt; if it drops `denomination` the host cannot
// deserialize the map and pay_debt fails at simulation, blocking the vault exit.
// These tests round-trip the encoder and exercise the untested linked-list walk.

const DENOM = "USD";
const A = "GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA";
const B = "GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC";
const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

const VAULTS_CONTRACT = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

const fakeServer = {} as unknown as rpc.Server;

// ---- ScVal fixtures (mirror what get_vaults_info / get_vault actually return) ----

function key(name: string): xdr.ScVal {
  return nativeToScVal(name, { type: "symbol" });
}

// a VaultKey struct scvMap: {account, denomination, index}
function vaultKeyMap(account: string, denomination: string, index: bigint): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: key("account"), val: nativeToScVal(account, { type: "address" }) }),
    new xdr.ScMapEntry({
      key: key("denomination"),
      val: nativeToScVal(denomination, { type: "symbol" }),
    }),
    new xdr.ScMapEntry({ key: key("index"), val: nativeToScVal(index, { type: "u128" }) }),
  ]);
}

// OptionalVaultKey::Some(VaultKey) — tagged enum vec [symbol("Some"), map]
function some(m: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.scvVec([key("Some"), m]);
}
function none(): xdr.ScVal {
  return xdr.ScVal.scvVec([key("None")]);
}

// get_vaults_info returns a struct { lowest_key: OptionalVaultKey }
function vaultsInfo(lowest: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: key("lowest_key"), val: lowest })]);
}

// get_vault returns a struct { index: u128, next_key: OptionalVaultKey }
function vaultRaw(index: bigint, nextKey: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: key("index"), val: nativeToScVal(index, { type: "u128" }) }),
    new xdr.ScMapEntry({ key: key("next_key"), val: nextKey }),
  ]);
}

function ok(retval: xdr.ScVal): SimulationResult {
  return {
    ok: true,
    retval,
    // the code only touches ok + retval; the rest is never read on this path
    transactionData: undefined as never,
    minResourceFee: "0",
    auth: [],
    latestLedger: 1,
  };
}

function fail(error: string): SimulationResult {
  return { ok: false, error, diagnostic: [], latestLedger: 1 };
}

// pull the invoked contract fn name + first-arg account off a built read-only tx
function invoked(tx: Transaction): { fn: string; account: string } {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = op.func.invokeContract();
  const args = call.args();
  const first = args[0];
  return {
    fn: Buffer.from(call.functionName()).toString(),
    account: first ? String(scValToNative(first)) : "",
  };
}

// build an injected simulate() from a per-vault map. `lowest` names the head
// account; `vaults[account] = nextAccount | null` describes the list edges.
function makeSimulate(
  lowest: string | null,
  vaults: Record<string, string | null>,
): typeof simulate {
  return async (_server, tx): Promise<SimulationResult> => {
    const { fn, account } = invoked(tx as Transaction);
    if (fn === "get_vaults_info") {
      if (lowest === null) return ok(vaultsInfo(none()));
      return ok(vaultsInfo(some(vaultKeyMap(lowest, DENOM, 0n))));
    }
    if (fn === "get_vault") {
      if (!(account in vaults)) return fail(`get_vault: ${account} not found`);
      const next = vaults[account];
      const nextKey =
        next === null || next === undefined ? none() : some(vaultKeyMap(next, DENOM, 1n));
      return ok(vaultRaw(2n, nextKey));
    }
    throw new Error(`unexpected sim call ${fn}`);
  };
}

describe("optionalVaultKeyScVal encoding (VaultKey struct shape)", () => {
  it("encodes None as scvVec([symbol('None')])", () => {
    const v = optionalVaultKeyScVal(null);
    const native = scValToNative(v);
    expect(Array.isArray(native)).toBe(true);
    expect(native).toEqual(["None"]);
  });

  it("encodes Some(VaultKey) with all three fields: account, denomination, index", () => {
    const vk: VaultKey = { account: USER, denomination: DENOM, index: 7n };
    const v = optionalVaultKeyScVal(vk);

    // Some(...) is a two-element tagged vec; the payload is the struct map.
    const vec = v.vec();
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(2);
    expect(scValToNative(vec![0]!)).toBe("Some");

    const mapEntries = vec![1]!.map();
    expect(mapEntries).not.toBeNull();
    const keys = mapEntries!.map((e) => scValToNative(e.key()) as string).sort();
    // REGRESSION: the old encoder omitted "denomination"; the host requires all
    // three fields or pay_debt fails to deserialize the prev_key arg.
    expect(keys).toEqual(["account", "denomination", "index"]);

    const native = scValToNative(v) as [string, Record<string, unknown>];
    expect(native[1].account).toBe(USER);
    expect(native[1].denomination).toBe(DENOM);
    expect(native[1].index).toBe(7n);
  });
});

describe("decodeOptionalVaultKey (three SDK decode shapes)", () => {
  it("returns null for null / undefined", () => {
    expect(decodeOptionalVaultKey(null, DENOM)).toBeNull();
    expect(decodeOptionalVaultKey(undefined, DENOM)).toBeNull();
  });

  it("returns null for None in both vec and tagged-object shapes", () => {
    expect(decodeOptionalVaultKey(["None"], DENOM)).toBeNull();
    expect(decodeOptionalVaultKey({ tag: "None", values: [] }, DENOM)).toBeNull();
  });

  it("decodes the array-tuple Some shape and threads the denomination", () => {
    const out = decodeOptionalVaultKey(["Some", { account: USER, index: 7n }], DENOM);
    expect(out).toEqual({ account: USER, denomination: DENOM, index: 7n });
  });

  it("decodes the tagged {tag:'Some', values:[...]} shape", () => {
    const out = decodeOptionalVaultKey(
      { tag: "Some", values: [{ account: USER, index: 3n }] },
      DENOM,
    );
    expect(out).toEqual({ account: USER, denomination: DENOM, index: 3n });
  });

  it("decodes the bare-inner-object shape", () => {
    const out = decodeOptionalVaultKey({ account: USER, index: 9n }, DENOM);
    expect(out).toEqual({ account: USER, denomination: DENOM, index: 9n });
  });

  it("returns null when index is not a bigint (malformed struct)", () => {
    expect(decodeOptionalVaultKey({ account: USER, index: 9 }, DENOM)).toBeNull();
  });
});

describe("findPrevVaultKey walk", () => {
  const deps = (fn: typeof simulate, maxHops?: number) => ({
    server: fakeServer,
    simulate: fn,
    ...(maxHops === undefined ? {} : { maxHops }),
  });

  it("returns null when the list is empty (no lowest_key)", async () => {
    const sim = makeSimulate(null, {});
    const out = await findPrevVaultKey(VAULTS_CONTRACT, USER, DENOM, TESTNET, deps(sim));
    expect(out).toBeNull();
  });

  it("returns null when the user is the list head", async () => {
    const sim = makeSimulate(USER, { [USER]: null });
    const out = await findPrevVaultKey(VAULTS_CONTRACT, USER, DENOM, TESTNET, deps(sim));
    expect(out).toBeNull();
  });

  it("returns the immediate predecessor for a non-head user", async () => {
    // list: A -> B -> USER
    const sim = makeSimulate(A, { [A]: B, [B]: USER, [USER]: null });
    const out = await findPrevVaultKey(VAULTS_CONTRACT, USER, DENOM, TESTNET, deps(sim));
    expect(out).toEqual({ account: B, denomination: DENOM, index: 1n });
  });

  it("throws when it walks to the tail without finding the user", async () => {
    // list: A -> B -> (tail); USER absent
    const sim = makeSimulate(A, { [A]: B, [B]: null });
    await expect(
      findPrevVaultKey(VAULTS_CONTRACT, USER, DENOM, TESTNET, deps(sim)),
    ).rejects.toThrow(/walked to tail/);
  });

  it("throws when a vault is missing mid-walk", async () => {
    // A points at B, but get_vault(B) fails (sim not ok -> readVaultRaw null)
    const sim = makeSimulate(A, { [A]: B });
    await expect(
      findPrevVaultKey(VAULTS_CONTRACT, USER, DENOM, TESTNET, deps(sim)),
    ).rejects.toThrow(/not found mid-walk/);
  });

  it("throws when maxHops is exceeded (cyclic / oversized list)", async () => {
    // A -> B -> A -> ... never reaches USER
    const sim = makeSimulate(A, { [A]: B, [B]: A });
    await expect(
      findPrevVaultKey(VAULTS_CONTRACT, USER, DENOM, TESTNET, deps(sim, 4)),
    ).rejects.toThrow(/exceeded 4 hops/);
  });
});
