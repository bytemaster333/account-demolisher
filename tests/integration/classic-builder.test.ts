import { describe, it, expect } from "vitest";
import {
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { auditAccount, AccountNotFoundError } from "@/lib/stellar/account-audit";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { TESTNET } from "@/lib/config/networks";

// live testnet close of an account carrying every non-ed25519 signer type, with
// a base64 hash memo, built through the real batcher and builder and anchored to
// the ledger clock the audit read

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

function randomBytes32(): Uint8Array {
  return Uint8Array.from(Keypair.random().rawPublicKey());
}

describe("integration: classic builder (testnet)", () => {
  it("closes an account with pre-auth, hash and signed-payload signers", async () => {
    const kp = Keypair.random();
    const destination = Keypair.random();
    await friendbotFund(kp.publicKey());
    await friendbotFund(destination.publicKey());

    const signedPayload = StrKey.encodeSignedPayload(
      new xdr.SignerKeyEd25519SignedPayload({
        ed25519: Keypair.random().rawPublicKey(),
        payload: Uint8Array.from([9, 8, 7, 6]),
      }).toXdr(),
    );
    const setup = await server.loadAccount(kp.publicKey());
    const setupTx = new TransactionBuilder(setup, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.setOptions({ signer: { preAuthTx: randomBytes32(), weight: 1 } }))
      .addOperation(Operation.setOptions({ signer: { sha256Hash: randomBytes32(), weight: 1 } }))
      .addOperation(
        Operation.setOptions({ signer: { ed25519SignedPayload: signedPayload, weight: 1 } }),
      )
      .setTimeout(120)
      .build();
    setupTx.sign(kp);
    await server.submitTransaction(setupTx);

    const audit = await auditAccount(kp.publicKey(), TESTNET);
    expect(audit.signers.map((s) => s.type).sort()).toEqual([
      "ed25519_public_key",
      "ed25519_signed_payload",
      "preauth_tx",
      "sha256_hash",
    ]);

    const hashMemo = Buffer.from(randomBytes32()).toString("base64");
    const batches = batchClassicDemolition(audit, {
      destination: destination.publicKey(),
      useMediator: false,
      memo: { type: "hash", value: hashMemo },
    });
    for (const batch of batches) {
      const source = await server.loadAccount(kp.publicKey());
      const built = buildClassicTransaction(
        batch,
        source,
        TESTNET,
        undefined,
        undefined,
        audit.ledger.closedAt,
      );
      const tx = built.transaction as Transaction;
      expect(Number(tx.timeBounds?.maxTime)).toBe(audit.ledger.closedAt + 300);
      tx.sign(kp);
      await server.submitTransaction(tx);
    }

    await expect(auditAccount(kp.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });
});
