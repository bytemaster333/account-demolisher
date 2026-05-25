// sep-41 token contract callers.
//
// standard interface:
//   - balance(id: Address) -> i128
//   - allowance(from: Address, spender: Address) -> AllowanceValue { amount: i128, live_until_ledger: u32 }
//   - transfer(from: Address, to: Address, amount: i128)
//   - approve(from: Address, spender: Address, amount: i128, expiration_ledger: u32)
//   - decimals() -> u32
//   - name() -> String
//   - symbol() -> String

import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  xdr,
  type Horizon,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";
import {
  address as scvAddress,
  fromScValI128,
  fromScValString,
  fromScValU32,
  i128 as scvI128,
  u32 as scvU32,
} from "./scval";
import { assembleSubmittable, simulateRead } from "./simulate";

const FIVE_MINUTES_SECONDS = 300;

// decimals() is immutable per contract, so cache per (server, contractId).
const decimalsCache = new WeakMap<rpc.Server, Map<string, number>>();

// balance(id: Address) -> i128
export async function balance(
  server: rpc.Server,
  contractId: string,
  addr: string,
  sourcePublicKey: string,
  network: NetworkConfig,
): Promise<bigint> {
  const { retval } = await simulateRead(
    server,
    contractId,
    "balance",
    [scvAddress(addr)],
    sourcePublicKey,
    network,
  );
  return fromScValI128(retval);
}

// allowance(from, spender) -> { amount: i128, live_until_ledger: u32 }
export async function allowance(
  server: rpc.Server,
  contractId: string,
  from: string,
  spender: string,
  sourcePublicKey: string,
  network: NetworkConfig,
): Promise<{ amount: bigint; live_until_ledger: number }> {
  const { retval } = await simulateRead(
    server,
    contractId,
    "allowance",
    [scvAddress(from), scvAddress(spender)],
    sourcePublicKey,
    network,
  );
  return decodeAllowance(retval);
}

function decodeAllowance(v: xdr.ScVal): { amount: bigint; live_until_ledger: number } {
  if (v.switch().name !== "scvMap") {
    throw new TypeError(`Expected scvMap for allowance return, got ${v.switch().name}`);
  }
  const entries = v.map();
  if (entries === null) {
    throw new TypeError("allowance return: scvMap had null entries");
  }
  let amount: bigint | undefined;
  let liveUntilLedger: number | undefined;
  for (const entry of entries) {
    const key = entry.key();
    if (key.switch().name !== "scvSymbol") continue;
    const k = key.sym().toString();
    if (k === "amount") amount = fromScValI128(entry.val());
    else if (k === "live_until_ledger") liveUntilLedger = fromScValU32(entry.val());
  }
  if (amount === undefined || liveUntilLedger === undefined) {
    throw new TypeError(
      `allowance return missing required keys; got ${entries.map((e) => e.key().switch().name).join(",")}`,
    );
  }
  return { amount, live_until_ledger: liveUntilLedger };
}

// decimals() -> u32, cached per (server, contractId).
export async function decimals(
  server: rpc.Server,
  contractId: string,
  sourcePublicKey: string,
  network: NetworkConfig,
): Promise<number> {
  let perServer = decimalsCache.get(server);
  if (!perServer) {
    perServer = new Map<string, number>();
    decimalsCache.set(server, perServer);
  }
  const hit = perServer.get(contractId);
  if (hit !== undefined) return hit;

  const { retval } = await simulateRead(
    server,
    contractId,
    "decimals",
    [],
    sourcePublicKey,
    network,
  );
  const value = fromScValU32(retval);
  perServer.set(contractId, value);
  return value;
}

// name() -> String
export async function name(
  server: rpc.Server,
  contractId: string,
  sourcePublicKey: string,
  network: NetworkConfig,
): Promise<string> {
  const { retval } = await simulateRead(server, contractId, "name", [], sourcePublicKey, network);
  return fromScValString(retval);
}

// symbol() -> String
export async function symbol(
  server: rpc.Server,
  contractId: string,
  sourcePublicKey: string,
  network: NetworkConfig,
): Promise<string> {
  const { retval } = await simulateRead(server, contractId, "symbol", [], sourcePublicKey, network);
  return fromScValString(retval);
}

// build a transfer(from, to, amount) tx, simulated + assembled.
export async function buildTransfer(
  server: rpc.Server,
  contractId: string,
  from: string,
  to: string,
  amount: bigint,
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
): Promise<Transaction> {
  return buildInvoke(
    server,
    contractId,
    "transfer",
    [scvAddress(from), scvAddress(to), scvI128(amount)],
    network,
    sourceAccount,
  );
}

// build an approve(from, spender, amount, expiration_ledger) tx.
export async function buildApprove(
  server: rpc.Server,
  contractId: string,
  from: string,
  spender: string,
  amount: bigint,
  liveUntilLedger: number,
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
): Promise<Transaction> {
  return buildInvoke(
    server,
    contractId,
    "approve",
    [scvAddress(from), scvAddress(spender), scvI128(amount), scvU32(liveUntilLedger)],
    network,
    sourceAccount,
  );
}

async function buildInvoke(
  server: rpc.Server,
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
): Promise<Transaction> {
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(contract.call(fnName, ...args))
    .setTimeout(FIVE_MINUTES_SECONDS)
    .build();

  const prepared = await assembleSubmittable(server, tx);
  // narrow off FeeBumpTransaction via innerTransaction. fee-bump wrapping
  // happens in the orchestrator, not here.
  if ("innerTransaction" in prepared) {
    throw new Error("buildInvoke: prepareTransaction returned a FeeBumpTransaction unexpectedly");
  }
  return prepared;
}
