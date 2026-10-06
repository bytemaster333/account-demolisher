import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { closeSignerSet, trimToThreshold } from "@/components/multisig/envelope";
import { TESTNET } from "@/lib/config/networks";
import { getHorizon } from "@/lib/stellar/horizon-client";

// live testnet proof that a 2-of-3 close signed by all three is rejected with
// tx_bad_auth_extra, and that the trimmed envelope lands.

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

function resultCodes(e: unknown): unknown {
  return (e as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data
    ?.extras?.result_codes;
}

describe("integration: multisig envelope trimming (testnet)", () => {
  it("an over-signed close fails and the trimmed one succeeds", async () => {
    const master = Keypair.random();
    const a = Keypair.random();
    const b = Keypair.random();
    const destination = Keypair.random();
    await friendbotFund(master.publicKey());
    await friendbotFund(destination.publicKey());

    const setupSource = await server.loadAccount(master.publicKey());
    const setup = new TransactionBuilder(setupSource, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: a.publicKey(), weight: 1 } }),
      )
      .addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: b.publicKey(), weight: 1 } }),
      )
      .addOperation(Operation.setOptions({ lowThreshold: 2, medThreshold: 2, highThreshold: 2 }))
      .setTimeout(120)
      .build();
    setup.sign(master);
    await server.submitTransaction(setup);

    const account = await server.loadAccount(master.publicKey());
    const close = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.accountMerge({ destination: destination.publicKey() }))
      .setTimeout(300)
      .build();
    close.sign(master, a, b);

    let rejected: unknown = null;
    try {
      await server.submitTransaction(
        TransactionBuilder.fromXdr(close.toXdr(), TESTNET.passphrase) as Transaction,
      );
    } catch (e: unknown) {
      rejected = resultCodes(e);
    }
    expect(rejected).toEqual({ transaction: "tx_bad_auth_extra" });

    const set = closeSignerSet(await server.loadAccount(master.publicKey()));
    const trimmed = trimToThreshold(close.toXdr(), TESTNET.passphrase, set.signers, set.required);
    expect(trimmed.met).toBe(true);
    expect(trimmed.kept).toEqual([master.publicKey(), a.publicKey()]);

    const res = await server.submitTransaction(
      TransactionBuilder.fromXdr(trimmed.xdr, TESTNET.passphrase) as Transaction,
    );
    expect(res.successful).toBe(true);
  });
});
