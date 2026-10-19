// live testnet helpers for the e2e specs: funding, reading balances and
// operations back from Horizon. the specs assert on chain with these, never on
// app state.

import {
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { fundWithFriendbot } from "../../helpers/friendbot";

export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
export const PASSPHRASE = Networks.TESTNET;

export const horizon = new Horizon.Server(HORIZON_URL);

export async function friendbotFund(publicKey: string): Promise<void> {
  await fundWithFriendbot(publicKey);
}

export async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await horizon.loadAccount(publicKey);
    return true;
  } catch (err: unknown) {
    if ((err as { response?: { status?: number } })?.response?.status === 404) return false;
    throw err; // a transient error must not read as "account gone"
  }
}

// "123.4567890" -> 1234567890n
function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole ?? "0") * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
}

export async function nativeBalance(publicKey: string): Promise<bigint> {
  const account = await horizon.loadAccount(publicKey);
  const line = account.balances.find((b) => b.asset_type === "native");
  if (line === undefined) throw new Error(`${publicKey} has no native balance line`);
  return toStroops(line.balance);
}

// one classic transaction from kp, signed by kp and any extra signers
export async function submitAs(
  kp: Keypair,
  ops: readonly xdr.Operation[],
  extraSigners: readonly Keypair[] = [],
): Promise<string> {
  const account = await horizon.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE });
  for (const op of ops) b.addOperation(op);
  const tx = b.setTimeout(120).build();
  tx.sign(kp, ...extraSigners);
  try {
    return (await horizon.submitTransaction(tx)).hash;
  } catch (err) {
    const codes = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })
      .response?.data?.extras?.result_codes;
    throw new Error(`setup transaction refused: ${JSON.stringify(codes ?? String(err))}`);
  }
}

// a friendbot account and a destination split off it, so the account holds a
// few hundred XLM (under the 1,000 XLM high-value review) and the destination
// exists as a real merge target
export async function fundedPair(): Promise<{ source: Keypair; destination: Keypair }> {
  const source = Keypair.random();
  const destination = Keypair.random();
  await friendbotFund(source.publicKey());
  await submitAs(source, [
    Operation.createAccount({ destination: destination.publicKey(), startingBalance: "9400" }),
  ]);
  return { source, destination };
}

// the successful account_merge operations the account ran, newest first
export async function mergesOf(publicKey: string): Promise<{ into: string; tx: string }[]> {
  const page = await horizon.operations().forAccount(publicKey).order("desc").limit(50).call();
  return page.records
    .filter(
      (r) =>
        String(r.type) === "account_merge" &&
        r.transaction_successful &&
        r.source_account === publicKey,
    )
    .map((r) => ({
      into: (r as unknown as { into: string }).into,
      tx: r.transaction_hash,
    }));
}
