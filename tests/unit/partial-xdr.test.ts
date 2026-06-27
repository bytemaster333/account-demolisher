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
import { mergeSignatures } from "@/lib/multisig/partial-xdr";

const NET = Networks.TESTNET;

// builds a deterministic classic tx with `sourcePk` as source and sequence `seq`.
function buildTx(sourcePk: string, seq: string) {
  return new TransactionBuilder(new Account(sourcePk, seq), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.payment({ destination: sourcePk, asset: Asset.native(), amount: "1" }))
    .build();
}

// signs an independent clone of the same tx with `kp` and returns its XDR, so
// each partial carries exactly one decorated signature (as real signers do).
function signPartial(sourcePk: string, seq: string, kp: Keypair): string {
  const clone = TransactionBuilder.fromXDR(buildTx(sourcePk, seq).toXDR(), NET);
  clone.sign(kp);
  return clone.toXDR();
}

describe("mergeSignatures", () => {
  it("merges a co-signer's signature into the canonical envelope", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const source = a.publicKey();

    const canonicalXdr = signPartial(source, "1", a);
    const partialFromB = signPartial(source, "1", b);

    const merged = mergeSignatures(canonicalXdr, [partialFromB], NET, {
      expectedSigners: [a.publicKey(), b.publicKey()],
    });

    const tx = TransactionBuilder.fromXDR(merged, NET);
    expect(tx.signatures).toHaveLength(2);
    const hash = tx.hash();
    for (const kp of [a, b]) {
      expect(tx.signatures.some((s) => kp.verify(hash, Buffer.from(s.signature())))).toBe(true);
    }
  });

  it("rejects a partial built from a different transaction (hash mismatch)", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const source = a.publicKey();

    const canonicalXdr = signPartial(source, "1", a);
    // same source/op but a different sequence -> different tx hash
    const partialFromB = signPartial(source, "2", b);

    expect(() =>
      mergeSignatures(canonicalXdr, [partialFromB], NET, {
        expectedSigners: [a.publicKey(), b.publicKey()],
      }),
    ).toThrow(/transaction hash differs/);
  });

  it("rejects a signature from a signer outside the allowlist", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const c = Keypair.random();
    const source = a.publicKey();

    const canonicalXdr = signPartial(source, "1", a);
    const partialFromC = signPartial(source, "1", c);

    expect(() =>
      mergeSignatures(canonicalXdr, [partialFromC], NET, {
        expectedSigners: [a.publicKey(), b.publicKey()],
      }),
    ).toThrow(/does not match any known signer/);
  });

  it("does not duplicate a signature already present", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const source = a.publicKey();

    const canonicalXdr = signPartial(source, "1", a);
    const partialFromB = signPartial(source, "1", b);

    // feed the same partial twice -> still exactly 2 signatures, not 3
    const merged = mergeSignatures(canonicalXdr, [partialFromB, partialFromB], NET, {
      expectedSigners: [a.publicKey(), b.publicKey()],
    });

    expect(TransactionBuilder.fromXDR(merged, NET).signatures).toHaveLength(2);
  });

  describe("without expectedSigners (candidate-set fallback)", () => {
    it("accepts a signature from the transaction source account", () => {
      const a = Keypair.random();
      const source = a.publicKey();

      // canonical is unsigned; the partial is signed by the source itself
      const canonicalXdr = buildTx(source, "1").toXDR();
      const partialFromSource = signPartial(source, "1", a);

      const merged = mergeSignatures(canonicalXdr, [partialFromSource], NET);

      const tx = TransactionBuilder.fromXDR(merged, NET);
      expect(tx.signatures).toHaveLength(1);
      expect(a.verify(tx.hash(), Buffer.from(tx.signatures[0]!.signature()))).toBe(true);
    });

    it("rejects a signature from a key that is neither tx nor op source", () => {
      const a = Keypair.random();
      const c = Keypair.random();
      const source = a.publicKey();

      const canonicalXdr = buildTx(source, "1").toXDR();
      const partialFromC = signPartial(source, "1", c);

      expect(() => mergeSignatures(canonicalXdr, [partialFromC], NET)).toThrow(
        /does not match any known signer/,
      );
    });
  });
});
