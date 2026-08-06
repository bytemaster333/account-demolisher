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
import { mergeSignatures } from "@/lib/multisig/partial-xdr";

// Live testnet proof of the 2-of-3 multisig close via the PARTIAL-XDR merge path
// (the relay's coordination mechanism), NOT the locally-held-keys connector. A
// 3-signer account (each weight 1, threshold 2) is closed by having TWO of the
// three signers sign the SAME canonical transaction INDEPENDENTLY, then merging
// their signatures with mergeSignatures and submitting the result. This is what a
// real multi-party close does: each party signs alone and hands back a partial
// envelope; the signatures are hash-bound and merged into one.

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

// one signer signs the canonical tx ALONE and returns its partial envelope xdr
function partialSign(canonicalXdr: string, signer: Keypair): string {
  const tx = TransactionBuilder.fromXDR(canonicalXdr, TESTNET.passphrase) as Transaction;
  tx.sign(signer);
  return tx.toEnvelope().toXDR("base64");
}

describe("integration: 2-of-3 multisig close via partial-XDR merge (testnet)", () => {
  it("closes a 2-of-3 account by merging two independently-signed partials", async () => {
    const master = Keypair.random();
    const cosignerA = Keypair.random();
    const cosignerB = Keypair.random();
    const destination = Keypair.random();

    await friendbotFund(master.publicKey());
    await friendbotFund(destination.publicKey());

    // make it 2-of-3: add two cosigners (weight 1 each) and raise thresholds to 2,
    // so the master + two cosigners are three weight-1 signers and ANY two of them
    // meet the threshold. Authorized by the master alone (new thresholds apply next).
    const setupSource = await server.loadAccount(master.publicKey());
    const setupTx = new TransactionBuilder(setupSource, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        Operation.setOptions({
          signer: { ed25519PublicKey: cosignerA.publicKey(), weight: 1 },
        }),
      )
      .addOperation(
        Operation.setOptions({
          signer: { ed25519PublicKey: cosignerB.publicKey(), weight: 1 },
          lowThreshold: 2,
          medThreshold: 2,
          highThreshold: 2,
        }),
      )
      .setTimeout(120)
      .build();
    setupTx.sign(master);
    await server.submitTransaction(setupTx);

    const audit = await auditAccount(master.publicKey(), TESTNET);
    expect(audit.thresholds.high).toBe(2);
    expect(audit.requiresMultisig).toBe(true);
    expect(audit.mergeability.mergeable).toBe(true);

    const expectedSigners = [master.publicKey(), cosignerA.publicKey(), cosignerB.publicKey()];
    const batches = batchClassicDemolition(audit, {
      destination: destination.publicKey(),
      useMediator: false,
    });

    for (const batch of batches) {
      const source = await server.loadAccount(master.publicKey());
      const canonical = buildClassicTransaction(batch, source, TESTNET).transaction;
      const canonicalXdr = canonical.toEnvelope().toXDR("base64");

      // TWO of the three signers sign the SAME canonical tx, independently
      const partialMaster = partialSign(canonicalXdr, master);
      const partialA = partialSign(canonicalXdr, cosignerA);

      // merge their signatures into the canonical envelope (hash-bound)
      const mergedXdr = mergeSignatures(canonicalXdr, [partialMaster, partialA], TESTNET.passphrase, {
        expectedSigners,
      });
      const merged = TransactionBuilder.fromXDR(mergedXdr, TESTNET.passphrase) as Transaction;
      // exactly the two collected signatures; the 2-of-3 threshold is met
      expect(merged.signatures.length).toBe(2);
      await server.submitTransaction(merged);
    }

    // the account is gone
    await expect(auditAccount(master.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });
});
