import { describe, it, expect } from "vitest";
import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { auditAccount, AccountNotFoundError } from "@/lib/stellar/account-audit";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { TESTNET } from "@/lib/config/networks";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

// Live testnet round-trip: fund an account, give it real subentries, audit it,
// then run the actual demolition (batcher -> builder -> sign -> submit) and
// confirm the account is gone. Exercises the Phase-2 correctness paths against
// real Horizon rather than a fixture.

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

async function submitAs(kp: Keypair, build: (b: TransactionBuilder) => void): Promise<void> {
  const account = await server.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  });
  build(builder);
  builder.setTimeout(120);
  const tx = builder.build();
  tx.sign(kp);
  await server.submitTransaction(tx);
}

describe("integration: classic account close (testnet)", () => {
  it("audits and fully merges a funded account carrying data entries and a co-signer", async () => {
    const kp = Keypair.random();
    const destination = Keypair.random();
    const coSigner = Keypair.random().publicKey();

    await friendbotFund(kp.publicKey());
    await friendbotFund(destination.publicKey());

    // give the account real subentries: two data entries + an extra signer.
    // thresholds stay at 0, so the master key alone can still authorize the merge.
    await submitAs(kp, (b) => {
      b.addOperation(Operation.manageData({ name: "k1", value: "v1" }));
      b.addOperation(Operation.manageData({ name: "k2", value: "v2" }));
      b.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: coSigner, weight: 1 } }));
    });

    // audit reflects on-chain reality and the corrected derivations
    const audit = await auditAccount(kp.publicKey(), TESTNET);
    expect(audit.data.map((d) => d.name).sort()).toEqual(["k1", "k2"]);
    expect(audit.signers.some((s) => s.key === coSigner && s.weight === 1)).toBe(true);
    // master weight (1) meets the high threshold (0) -> NOT multisig
    expect(audit.requiresMultisig).toBe(false);
    expect(audit.mergeability.mergeable).toBe(true);
    expect(audit.sponsorship.numSponsoring).toBe(0);

    // run the real demolition
    const batches = batchClassicDemolition(audit, {
      destination: destination.publicKey(),
      useMediator: false,
    });
    const connector = new SecretKeyConnector(kp.secret());
    for (const batch of batches) {
      const source = await server.loadAccount(kp.publicKey());
      const built = buildClassicTransaction(batch, source, TESTNET);
      const { signedXdr } = await connector.signTransaction(built.transaction, TESTNET.passphrase);
      const signed = TransactionBuilder.fromXDR(signedXdr, TESTNET.passphrase) as Transaction;
      await server.submitTransaction(signed);
    }

    // the account no longer exists
    await expect(auditAccount(kp.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });
});
