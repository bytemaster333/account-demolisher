import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
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

// a partial envelope carrying one signer's SAME signature under `count` forged
// hints, the shape an attacker would use to try to bloat the canonical envelope.
function forgedHintPartial(sourcePk: string, seq: string, kp: Keypair, count: number): string {
  const signedOnce = TransactionBuilder.fromXDR(signPartial(sourcePk, seq, kp), NET);
  const sig = Buffer.from(signedOnce.signatures[0]!.signature());
  const forged = TransactionBuilder.fromXDR(buildTx(sourcePk, seq).toXDR(), NET);
  for (let i = 0; i < count; i++) {
    forged.signatures.push(
      new xdr.DecoratedSignature({ hint: Buffer.from([i, i, i, i]), signature: sig }),
    );
  }
  return forged.toXDR();
}

describe("mergeSignatures signature-wedge hardening", () => {
  it("collapses one signer's signature replayed under many forged hints to a single slot", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const source = a.publicKey();
    const signers = [a.publicKey(), b.publicKey()];

    const canonicalXdr = signPartial(source, "1", a);
    // attacker floods with 15 forged-hint copies of a's one signature (one partial
    // can hold at most 20 signatures; without dedup-by-key these would each take a
    // slot and, across a few requests, wedge the envelope at the 20-signature cap)
    const merged = mergeSignatures(canonicalXdr, [forgedHintPartial(source, "1", a, 15)], NET, {
      expectedSigners: signers,
    });
    // still exactly one slot for a, nowhere near the 20-signature XDR cap
    expect(TransactionBuilder.fromXDR(merged, NET).signatures).toHaveLength(1);

    // a genuine second signer still merges cleanly afterwards
    const withB = mergeSignatures(merged, [signPartial(source, "1", b)], NET, {
      expectedSigners: signers,
    });
    expect(TransactionBuilder.fromXDR(withB, NET).signatures).toHaveLength(2);
  });
});

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
