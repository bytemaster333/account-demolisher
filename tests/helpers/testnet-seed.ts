// sets up on-chain state for the live testnet tests: plain classic and soroban
// submissions signed with throwaway keys. none of this is app code; the app is
// what the tests then run against the state built here.

import {
  BASE_FEE,
  Keypair,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { getHorizon } from "@/lib/stellar/horizon-client";

export const rpc = getRpc(TESTNET);
export const horizon = getHorizon(TESTNET);

export async function submitClassicAs(
  kp: Keypair,
  build: (b: TransactionBuilder) => void,
  extraSigners: readonly Keypair[] = [],
): Promise<string> {
  const account = await horizon.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  });
  build(b);
  const tx = b.setTimeout(120).build();
  tx.sign(kp, ...extraSigners);
  try {
    const res = await horizon.submitTransaction(tx);
    return res.hash;
  } catch (err) {
    const codes = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })
      .response?.data?.extras?.result_codes;
    throw new Error(`classic setup tx refused: ${JSON.stringify(codes ?? String(err))}`);
  }
}

// one contract call (or other soroban op) from kp, simulated, signed and polled
export async function submitSorobanAs(kp: Keypair, op: xdr.Operation): Promise<string> {
  const account = await horizon.loadAccount(kp.publicKey());
  const raw = new TransactionBuilder(account, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: TESTNET.passphrase,
  })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const tx = (await rpc.prepareTransaction(raw)) as Transaction;
  tx.sign(kp);
  const sent = await rpc.sendTransaction(tx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`soroban setup tx ${sent.hash}: sendTransaction returned ${sent.status}`);
  }
  const res = await rpc.pollTransaction(sent.hash, { attempts: 60 });
  if (res.status !== "SUCCESS") {
    throw new Error(`soroban setup tx ${sent.hash} did not succeed: ${res.status}`);
  }
  return sent.hash;
}
