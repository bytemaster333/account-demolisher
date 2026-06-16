import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { MultiSignerConnector, type MultiSignerMember } from "@/lib/wallet/multi-signer";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

const NET = Networks.TESTNET;

function member(kp: Keypair, weight: number): MultiSignerMember {
  return { connector: new SecretKeyConnector(kp.secret()), publicKey: kp.publicKey(), weight };
}

function sampleTx(sourcePk: string) {
  return new TransactionBuilder(new Account(sourcePk, "1"), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.payment({ destination: sourcePk, asset: Asset.native(), amount: "1" }))
    .build();
}

describe("MultiSignerConnector", () => {
  it("applies every member's signature and reports combined weight + source", async () => {
    const account = Keypair.random();
    const cosigner = Keypair.random();
    const conn = new MultiSignerConnector(account.publicKey(), [
      member(account, 1),
      member(cosigner, 1),
    ]);

    expect(conn.totalWeight).toBe(2);
    expect(conn.signerKeys).toEqual([account.publicKey(), cosigner.publicKey()]);
    expect(await conn.getPublicKey()).toBe(account.publicKey());

    const tx = sampleTx(account.publicKey());
    const { signedXdr, signerPublicKey } = await conn.signTransaction(tx, NET);
    expect(signerPublicKey).toBe(account.publicKey());

    const signed = TransactionBuilder.fromXDR(signedXdr, NET);
    expect(signed.signatures).toHaveLength(2);
    const hash = signed.hash();
    for (const kp of [account, cosigner]) {
      const present = signed.signatures.some((s) => kp.verify(hash, Buffer.from(s.signature())));
      expect(present).toBe(true);
    }
    // the original tx is not mutated
    expect(tx.signatures).toHaveLength(0);
  });

  it("throws when constructed with no signers", () => {
    expect(() => new MultiSignerConnector(Keypair.random().publicKey(), [])).toThrow();
  });

  it("refuses SEP-43 auth-entry signing (not supported for multisig)", async () => {
    const account = Keypair.random();
    const conn = new MultiSignerConnector(account.publicKey(), [member(account, 1)]);
    await expect(conn.signAuthEntry()).rejects.toThrow(/not supported/);
  });
});
