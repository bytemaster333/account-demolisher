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
import { DEFAULT_TX_VALIDITY_SECONDS, fetchLedgerClock } from "@/lib/stellar/ledger-clock";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { TESTNET } from "@/lib/config/networks";
import { CLOSE_MARKER_NAME, CLOSE_MARKER_VALUE } from "@/lib/metrics/close-marker";
import type { BatchedOperation } from "@/lib/types/plan";

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
        Number(BASE_FEE),
        DEFAULT_TX_VALIDITY_SECONDS,
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

  it("lands the close marker pair right before the merge", async () => {
    const kp = Keypair.random();
    const destination = Keypair.random();
    await friendbotFund(kp.publicKey());
    await friendbotFund(destination.publicKey());

    const marker = (action: string): BatchedOperation =>
      ({
        kind: "close_marker",
        summary: `close marker ${action}`,
        metadata: { action },
      }) as unknown as BatchedOperation;
    const source = await server.loadAccount(kp.publicKey());
    const clock = await fetchLedgerClock(TESTNET);
    const built = buildClassicTransaction(
      {
        operations: [
          marker("set"),
          marker("delete"),
          {
            kind: "account_merge",
            summary: "merge",
            metadata: { destination: destination.publicKey() },
          },
        ],
        destination: destination.publicKey(),
      },
      source,
      TESTNET,
      Number(BASE_FEE),
      DEFAULT_TX_VALIDITY_SECONDS,
      clock.closedAt,
    );
    const tx = built.transaction as Transaction;
    tx.sign(kp);
    const res = await server.submitTransaction(tx);

    const ops = await server.operations().forTransaction(res.hash).call();
    expect(ops.records.map((o) => o.type)).toEqual(["manage_data", "manage_data", "account_merge"]);
    const [set, del] = ops.records as unknown as { name: string; value: string }[];
    expect(set!.name).toBe(CLOSE_MARKER_NAME);
    expect(Buffer.from(set!.value, "base64").toString()).toBe(CLOSE_MARKER_VALUE);
    expect(del!.name).toBe(CLOSE_MARKER_NAME);
    expect(del!.value).toBe("");
    await expect(auditAccount(kp.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });
});
