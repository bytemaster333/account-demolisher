import { describe, it, expect } from "vitest";
import { BASE_FEE, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { buildCloseTransaction } from "@/lib/multisig/signing-request";
import { __resetRelayForTests, addSignature, createPlan, getPlan } from "@/server/signing-relay";
import { auditAccount } from "@/lib/stellar/account-audit";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { fundWithFriendbot } from "../helpers/friendbot";

// live testnet proof for H-32: core rejects a close that carries a signature it
// didn't need (tx_bad_auth_extra), and the relay's stored envelope, which stops
// at the threshold, lands.

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  await fundWithFriendbot(pk);
}

function resultCodes(e: unknown): unknown {
  return (e as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data
    ?.extras?.result_codes;
}

describe("integration: signing relay threshold (testnet)", () => {
  it("a 2-of-3 close with all three signatures fails, the relay's copy lands", async () => {
    const owner = Keypair.random();
    const a = Keypair.random();
    const b = Keypair.random();
    const destination = Keypair.random();
    await Promise.all([friendbotFund(owner.publicKey()), friendbotFund(destination.publicKey())]);

    // two co-signers of weight 1 next to the master key, every threshold at 2
    const setup = new TransactionBuilder(await server.loadAccount(owner.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: a.publicKey(), weight: 1 } }),
      )
      .addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: b.publicKey(), weight: 1 } }),
      )
      .addOperation(
        Operation.setOptions({
          masterWeight: 1,
          lowThreshold: 2,
          medThreshold: 2,
          highThreshold: 2,
        }),
      )
      .setTimeout(120)
      .build();
    setup.sign(owner);
    await server.submitTransaction(setup);

    const audit = await auditAccount(owner.publicKey(), TESTNET);
    const tx = buildCloseTransaction({
      audit,
      destination: destination.publicKey(),
      network: TESTNET,
      sourceAccount: await server.loadAccount(owner.publicKey()),
      disposal: { claimableBalanceIds: [] },
      ledgerCloseTime: audit.ledger.closedAt,
    });
    const signed = (...kps: Keypair[]): string => {
      const copy = TransactionBuilder.fromXdr(tx.toXdr(), TESTNET.passphrase);
      for (const kp of kps) copy.sign(kp);
      return copy.toXdr();
    };

    __resetRelayForTests();
    const published = await createPlan("testnet", signed(owner));
    expect(published.ok).toBe(true);
    const id = published.ok ? published.id : "";
    expect(addSignature(id, signed(a)).ok).toBe(true);
    expect(addSignature(id, signed(b)).ok).toBe(true);
    const stored = getPlan(id)!.xdr;
    expect(TransactionBuilder.fromXdr(stored, TESTNET.passphrase).signatures).toHaveLength(2);

    // every signer signed: one signature is unused, so core refuses the whole close
    let refused: unknown = null;
    try {
      await server.submitTransaction(
        TransactionBuilder.fromXdr(signed(owner, a, b), TESTNET.passphrase),
      );
    } catch (e) {
      refused = resultCodes(e);
    }
    expect(refused).toEqual({ transaction: "tx_bad_auth_extra" });

    const landed = await server.submitTransaction(
      TransactionBuilder.fromXdr(stored, TESTNET.passphrase),
    );
    expect(landed.successful).toBe(true);
    __resetRelayForTests();
  });
});
