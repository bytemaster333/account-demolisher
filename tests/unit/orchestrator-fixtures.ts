// shared builders for the orchestrator tests: real keypairs, real accounts and
// real transactions, with only the network edges replaced

import {
  Account,
  Address,
  Asset,
  Keypair,
  nativeToScVal,
  NotFoundError,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { vi } from "vitest";

import { getAllowlistForNetwork } from "@/lib/config/contracts";
import { MAINNET } from "@/lib/config/networks";
import type { Connector } from "@/lib/wallet/connector";
import type { AccountAuditResult } from "@/lib/stellar/account-audit";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import type { HorizonLike } from "@/lib/orchestrator/executor";

export const NETWORK = MAINNET;
export const PASS = MAINNET.passphrase;

// fixed seeds so failures are reproducible
export const USER_KP = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(11));
export const USER = USER_KP.publicKey();
export const DEST = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(12)).publicKey();
export const ATTACKER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(13)).publicKey();
export const EXCHANGE = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(14)).publicKey();
export const MEDIATOR_A = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(15)).publicKey();
export const MEDIATOR_B = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(16)).publicKey();

export const XLM_SAC = Asset.native().contractId(PASS);
export const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const USDC = new Asset("USDC", USDC_ISSUER);
export const USDC_SAC = USDC.contractId(PASS);
export const HOSTILE_TOKEN = Address.contract(new Uint8Array(32).fill(7)).toString();

export function allowlisted(protocol: string, name: string): string {
  const entry = getAllowlistForNetwork(NETWORK).find(
    (c) => c.protocol === protocol && (c.name === name || c.name.startsWith(name)),
  );
  if (!entry) throw new Error(`no ${protocol} ${name} on the mainnet allow-list`);
  return entry.id;
}

// the ledger the audit was read against; the merge checks read it
export const AUDIT_LEDGER = { sequence: 1000, closedAt: 1_900_000_000 };

// horizon's latest-ledger record as the executor reads it: the base reserve for
// the fee cap, and the sequence and close time the merge is timed by
export function ledgerRecord(over: Record<string, unknown> = {}) {
  return {
    base_reserve_in_stroops: 5_000_000,
    sequence: AUDIT_LEDGER.sequence,
    closed_at: new Date(AUDIT_LEDGER.closedAt * 1000).toISOString(),
    ...over,
  };
}

export function makeAudit(over: Partial<AccountAuditResult> = {}): AccountAuditResult {
  return {
    accountId: USER,
    sequence: "100",
    subentryCount: 0,
    thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
    flags: {
      authImmutable: false,
      authRequired: false,
      authRevocable: false,
      authClawbackEnabled: false,
    },
    balances: [
      {
        asset: { kind: "native" },
        amount: "100.0000000",
        buyingLiabilities: "0.0000000",
        sellingLiabilities: "0.0000000",
      },
    ],
    signers: [],
    offers: [],
    data: [],
    claimableBalances: [],
    poolShares: [],
    sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
    requiresMultisig: false,
    mergeability: { mergeable: true },
    ledger: AUDIT_LEDGER,
    ...over,
  };
}

export interface FakeAccount {
  seq: bigint;
  balances: unknown[];
}

// horizon double backed by a mutable account table. a missing account answers
// with the sdk's real NotFoundError, as horizon does.
export function fakeHorizon(accounts: Map<string, FakeAccount>, extra: Partial<HorizonLike> = {}) {
  const loadAccount = vi.fn(async (id: string) => {
    const a = accounts.get(id);
    if (!a) {
      throw new NotFoundError("Not Found", { status: 404, statusText: "Not Found", data: {} });
    }
    return Object.assign(new Account(id, a.seq.toString()), { balances: a.balances });
  });
  // the latest ledger, closed now, as a live network serves it
  const ledgers = () => ({
    order: () => ({
      limit: () => ({
        call: async () => ({
          records: [ledgerRecord({ closed_at: new Date(Date.now()).toISOString() })],
        }),
      }),
    }),
  });
  return { loadAccount, ledgers, ...extra } as unknown as HorizonLike & {
    loadAccount: typeof loadAccount;
  };
}

export function horizonError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { response: { status } });
}

export interface SigningConnector extends Connector {
  readonly signed: Transaction[];
  readonly signTransaction: ReturnType<typeof vi.fn> & Connector["signTransaction"];
}

// a wallet that really signs with the user's key and records what it signed
export function signingConnector(): SigningConnector {
  const signed: Transaction[] = [];
  const signTransaction = vi.fn(async (tx: Transaction) => {
    tx.sign(USER_KP);
    signed.push(tx);
    return { signedXdr: tx.toEnvelope().toXdr("base64"), signerPublicKey: USER };
  });
  return {
    kind: "secret",
    signed,
    signTransaction,
    connect: async () => ({ publicKey: USER }),
    disconnect: async () => {},
    getPublicKey: async () => USER,
  } as unknown as SigningConnector;
}

export function decode(signedXdr: string): Transaction {
  return TransactionBuilder.fromXdr(signedXdr, PASS) as Transaction;
}

export const addr = (a: string) => nativeToScVal(a, { type: "address" });
export const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
export const u128 = (n: bigint) => nativeToScVal(n, { type: "u128" });
export const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
export const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
export const sym = (s: string) => nativeToScVal(s, { type: "symbol" });

export function inv(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    subInvocations: subs,
  });
}

export function sourceAuth(root: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });
}

// what a prepared transaction declares besides its fee
export interface DeclaredResources {
  readonly writeBytes?: number;
  readonly readWriteEntries?: number;
}

// a prepared contract call from the user's account at the account's next
// sequence, with the given auth tree. `fee` is the total the signature
// authorizes: the inclusion bid plus the resource fee, as assembleTransaction
// sets it. the account object's sequence is bumped, exactly as a real builder
// does.
export function invokeTx(
  account: Account,
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[],
  fee = "150000",
  resources: DeclaredResources = {},
): Transaction {
  const resourceFee = BigInt(fee) - BigInt(SOROBAN_INCLUSION_FEE);
  if (resourceFee <= 0n) throw new Error(`invokeTx: fee ${fee} leaves no resource fee`);
  const readWrite = Array.from({ length: resources.readWriteEntries ?? 1 }, (_, i) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contract).toScAddress(),
        key: nativeToScVal(i, { type: "u32" }),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  const data = new SorobanDataBuilder()
    .setResourceFee(resourceFee)
    .setResources(1_000_000, 1_000, resources.writeBytes ?? 200)
    .setReadWrite(readWrite)
    .build();
  return new TransactionBuilder(account, { fee: SOROBAN_INCLUSION_FEE, networkPassphrase: PASS })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args, auth }))
    .setSorobanData(data)
    .setTimeout(300)
    .build();
}

// a token transfer authorized exactly as the drain guard expects
export function transferTx(
  account: Account,
  token: string,
  to: string,
  amount: bigint,
  fee?: string,
) {
  const args = [addr(USER), addr(to), i128(amount)];
  return invokeTx(
    account,
    token,
    "transfer",
    args,
    [sourceAuth(inv(token, "transfer", args))],
    fee,
  );
}

// the native-SAC drain a hostile token would try to slip into a tree
export function drainInvocation(amount = 9_000_000_000n): xdr.SorobanAuthorizedInvocation {
  return inv(XLM_SAC, "transfer", [addr(USER), addr(ATTACKER), i128(amount)]);
}

// "nonce.expiryMs.destination.mac", the server's flow token layout
export function flowToken(expiryMs: number, destination = EXCHANGE): string {
  return `${"ab".repeat(16)}.${expiryMs}.${destination}.${"cd".repeat(32)}`;
}
