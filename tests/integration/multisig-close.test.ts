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
import { MultiSignerConnector, type MultiSignerMember } from "@/lib/wallet/multi-signer";

// Live testnet proof of R2/R13: build a real 2-of-2 multisig account, then close
// it by gathering both signers through the MultiSignerConnector and running the
// actual demolition. A single signature would fail the high threshold.

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

function member(kp: Keypair, weight: number): MultiSignerMember {
  return { connector: new SecretKeyConnector(kp.secret()), publicKey: kp.publicKey(), weight };
}

describe("integration: multisig account close (testnet)", () => {
  it("closes a 2-of-2 account by gathering both signatures", async () => {
    const master = Keypair.random();
    const cosigner = Keypair.random();
    const destination = Keypair.random();

    await friendbotFund(master.publicKey());
    await friendbotFund(destination.publicKey());

    // turn the account into 2-of-2: add the cosigner (weight 1) and raise all
    // thresholds to 2. This setup tx is authorized by the master alone because
    // the new thresholds only take effect afterward.
    const setupSource = await server.loadAccount(master.publicKey());
    const setupTx = new TransactionBuilder(setupSource, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        Operation.setOptions({
          signer: { ed25519PublicKey: cosigner.publicKey(), weight: 1 },
          lowThreshold: 2,
          medThreshold: 2,
          highThreshold: 2,
        }),
      )
      .setTimeout(120)
      .build();
    setupTx.sign(master);
    await server.submitTransaction(setupTx);

    // audit sees a genuine multisig account
    const audit = await auditAccount(master.publicKey(), TESTNET);
    expect(audit.thresholds.high).toBe(2);
    expect(audit.thresholds.masterWeight).toBe(1);
    expect(audit.requiresMultisig).toBe(true);
    expect(audit.mergeability.mergeable).toBe(true);

    // close it with BOTH signers combined
    const connector = new MultiSignerConnector(master.publicKey(), [
      member(master, 1),
      member(cosigner, 1),
    ]);
    expect(connector.totalWeight).toBe(2);

    const batches = batchClassicDemolition(audit, {
      destination: destination.publicKey(),
      useMediator: false,
    });
    for (const batch of batches) {
      const source = await server.loadAccount(master.publicKey());
      const built = buildClassicTransaction(batch, source, TESTNET);
      const { signedXdr } = await connector.signTransaction(built.transaction, TESTNET.passphrase);
      const signed = TransactionBuilder.fromXDR(signedXdr, TESTNET.passphrase) as Transaction;
      // both signatures are attached, the high threshold of 2 is met
      expect(signed.signatures.length).toBeGreaterThanOrEqual(2);
      await server.submitTransaction(signed);
    }

    await expect(auditAccount(master.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });
});
