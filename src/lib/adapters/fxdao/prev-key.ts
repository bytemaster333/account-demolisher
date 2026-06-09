// resolves the on-chain prev_key for a user's vault in fxdao's sorted linked list.
//
// fxdao stores open vaults as a singly-linked list per denomination, sorted by
// collateral ratio ascending. pay_debt needs the vault's predecessor (the node
// whose next_key points at the user's vault). resolving this requires walking
// from the list head (vaults_info.lowest_key) forward via vault.next_key.

import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { address as scvAddress } from "@/lib/soroban/scval";
import { simulate } from "@/lib/soroban/simulate";

export interface VaultKey {
  readonly account: string;
  readonly index: bigint;
}

export interface FindPrevDeps {
  readonly server: rpc.Server;
  readonly simulate?: typeof simulate;
  // hard cap on walk length so a corrupted list can't hang the caller
  readonly maxHops?: number;
}

// returns the predecessor VaultKey for the user's vault, or null if the user
// is the head (or the list is empty). throws if the user's vault isn't found
// in the list or if a contract read fails.
export async function findPrevVaultKey(
  vaultsContractId: string,
  userPublicKey: string,
  denomination: string,
  network: NetworkConfig,
  deps: FindPrevDeps,
): Promise<VaultKey | null> {
  const simulateFn = deps.simulate ?? simulate;
  const maxHops = deps.maxHops ?? 256;

  const lowestKey = await readLowestKey(
    deps.server,
    simulateFn,
    vaultsContractId,
    denomination,
    network,
  );
  if (lowestKey === null) return null;
  if (lowestKey.account === userPublicKey) return null;

  let current: VaultKey = lowestKey;
  for (let hop = 0; hop < maxHops; hop++) {
    const vault = await readVaultRaw(
      deps.server,
      simulateFn,
      vaultsContractId,
      current.account,
      denomination,
      network,
    );
    if (vault === null) {
      throw new Error(`findPrevVaultKey: vault at ${current.account} not found mid-walk`);
    }
    if (vault.nextKey === null) {
      throw new Error(
        `findPrevVaultKey: walked to tail without finding ${userPublicKey} in ${denomination} list`,
      );
    }
    if (vault.nextKey.account === userPublicKey) {
      return current;
    }
    current = vault.nextKey;
  }
  throw new Error(`findPrevVaultKey: exceeded ${maxHops} hops without finding user`);
}

// encode Some(VaultKey) / None for an OptionalVaultKey contract argument.
export function optionalVaultKeyScVal(key: VaultKey | null): xdr.ScVal {
  if (key === null) {
    return xdr.ScVal.scvVec([nativeToScVal("None", { type: "symbol" })]);
  }
  return xdr.ScVal.scvVec([nativeToScVal("Some", { type: "symbol" }), vaultKeyScVal(key)]);
}

// VaultKey on-chain is scvMap with fields in alphabetical order: account, denomination, index.
function vaultKeyScVal(key: VaultKey): xdr.ScVal {
  // denomination is intentionally omitted here because the host expects the
  // tuple <account, index> as the key — actual on-chain encoding sorts the
  // map alphabetically. we include the standard three-field shape; consumers
  // that need just account+index drop the third.
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("account", { type: "symbol" }),
      val: scvAddress(key.account),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("index", { type: "symbol" }),
      val: nativeToScVal(key.index, { type: "u128" }),
    }),
  ]);
}

async function readLowestKey(
  server: rpc.Server,
  simulateFn: typeof simulate,
  vaultsContractId: string,
  denomination: string,
  network: NetworkConfig,
): Promise<VaultKey | null> {
  const tx = buildReadOnlyTx(vaultsContractId, "get_vaults_info", network, [
    nativeToScVal(denomination, { type: "symbol" }),
  ]);
  const sim = await simulateFn(server, tx);
  if (!sim.ok || sim.retval === null) {
    throw new Error(
      `readLowestKey(${denomination}): get_vaults_info simulation failed${sim.ok ? " (no retval)" : `: ${sim.error}`}`,
    );
  }
  const info = scValToNative(sim.retval) as Record<string, unknown> | null;
  if (info === null || typeof info !== "object") return null;
  const lowest = info["lowest_key"];
  return decodeOptionalVaultKey(lowest);
}

interface RawVault {
  readonly index: bigint;
  readonly nextKey: VaultKey | null;
}

async function readVaultRaw(
  server: rpc.Server,
  simulateFn: typeof simulate,
  vaultsContractId: string,
  account: string,
  denomination: string,
  network: NetworkConfig,
): Promise<RawVault | null> {
  const tx = buildReadOnlyTx(vaultsContractId, "get_vault", network, [
    scvAddress(account),
    nativeToScVal(denomination, { type: "symbol" }),
  ]);
  const sim = await simulateFn(server, tx);
  if (!sim.ok || sim.retval === null) {
    return null;
  }
  const decoded = scValToNative(sim.retval) as Record<string, unknown> | null;
  if (decoded === null || typeof decoded !== "object") return null;
  const index = decoded["index"];
  if (typeof index !== "bigint") return null;
  const nextKey = decodeOptionalVaultKey(decoded["next_key"]);
  return { index, nextKey };
}

function decodeOptionalVaultKey(v: unknown): VaultKey | null {
  // OptionalVaultKey is encoded as a tagged tuple (vec) with either ["None"]
  // or ["Some", VaultKey]. scValToNative on a contract enum maps it to
  // { tag: "None" | "Some", values?: [{account, denomination, index}] } or
  // similar. handle both shapes defensively.
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const [tag, payload] = v;
    if (tag === "None") return null;
    if (tag === "Some" && payload && typeof payload === "object") {
      return decodeVaultKey(payload as Record<string, unknown>);
    }
    return null;
  }
  if (typeof v === "object") {
    const tag = (v as { tag?: unknown }).tag;
    if (tag === "None") return null;
    const values = (v as { values?: unknown }).values;
    if (tag === "Some" && Array.isArray(values) && values.length > 0) {
      const inner = values[0];
      if (inner && typeof inner === "object") {
        return decodeVaultKey(inner as Record<string, unknown>);
      }
    }
    // some sdks decode straight to the inner object when the tag is "Some"
    if ("account" in (v as object) && "index" in (v as object)) {
      return decodeVaultKey(v as Record<string, unknown>);
    }
  }
  return null;
}

function decodeVaultKey(o: Record<string, unknown>): VaultKey | null {
  const account = o["account"];
  const index = o["index"];
  if (typeof account !== "string") return null;
  if (typeof index !== "bigint") return null;
  return { account, index };
}

// build an unsigned read-only tx for get_vault / get_vaults_info simulation.
function buildReadOnlyTx(
  contractId: string,
  fn: string,
  network: NetworkConfig,
  args: xdr.ScVal[],
): import("@stellar/stellar-sdk").Transaction {
  // any well-formed source key works — simulation doesn't require funding.
  const SYNTHETIC_SOURCE = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
  const source = new Account(SYNTHETIC_SOURCE, "0");
  const contract = new Contract(contractId);
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();
}
