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
import {
  TooManySignaturesError,
  canonicalizeSignatures,
  isClassicTransaction,
  mergeSignatures,
  signedSigners,
  trimToThreshold,
} from "@/lib/multisig/partial-xdr";

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
  const clone = TransactionBuilder.fromXdr(buildTx(sourcePk, seq).toXdr(), NET);
  clone.sign(kp);
  return clone.toXdr();
}

// a partial envelope carrying one signer's SAME signature under `count` forged
// hints, the shape an attacker would use to try to bloat the canonical envelope.
function forgedHintPartial(sourcePk: string, seq: string, kp: Keypair, count: number): string {
  const signedOnce = TransactionBuilder.fromXdr(signPartial(sourcePk, seq, kp), NET);
  const sig = signedOnce.signatures[0]!.signature.toBytes();
  const forged = TransactionBuilder.fromXdr(buildTx(sourcePk, seq).toXdr(), NET);
  for (let i = 0; i < count; i++) {
    forged.signatures.push(
      new xdr.DecoratedSignature({ hint: Buffer.from([i, i, i, i]), signature: sig }),
    );
  }
  return forged.toXdr();
}

describe("isClassicTransaction", () => {
  it("accepts a classic transaction and refuses a fee-bump around one", () => {
    const kp = Keypair.random();
    const inner = buildTx(kp.publicKey(), "7");
    inner.sign(kp);
    const bump = TransactionBuilder.buildFeeBumpTransaction(kp, "200", inner, NET);
    expect(isClassicTransaction(TransactionBuilder.fromXdr(inner.toXdr(), NET))).toBe(true);
    expect(isClassicTransaction(TransactionBuilder.fromXdr(bump.toXdr(), NET))).toBe(false);
  });
});

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
    expect(TransactionBuilder.fromXdr(merged, NET).signatures).toHaveLength(1);

    // a genuine second signer still merges cleanly afterwards
    const withB = mergeSignatures(merged, [signPartial(source, "1", b)], NET, {
      expectedSigners: signers,
    });
    expect(TransactionBuilder.fromXdr(withB, NET).signatures).toHaveLength(2);
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

    const tx = TransactionBuilder.fromXdr(merged, NET);
    expect(tx.signatures).toHaveLength(2);
    const hash = tx.hash();
    for (const kp of [a, b]) {
      expect(tx.signatures.some((s) => kp.verify(hash, s.signature.toBytes()))).toBe(true);
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

    expect(TransactionBuilder.fromXdr(merged, NET).signatures).toHaveLength(2);
  });

  describe("without expectedSigners (candidate-set fallback)", () => {
    it("accepts a signature from the transaction source account", () => {
      const a = Keypair.random();
      const source = a.publicKey();

      // canonical is unsigned; the partial is signed by the source itself
      const canonicalXdr = buildTx(source, "1").toXdr();
      const partialFromSource = signPartial(source, "1", a);

      const merged = mergeSignatures(canonicalXdr, [partialFromSource], NET);

      const tx = TransactionBuilder.fromXdr(merged, NET);
      expect(tx.signatures).toHaveLength(1);
      expect(a.verify(tx.hash(), tx.signatures[0]!.signature.toBytes())).toBe(true);
    });

    it("rejects a signature from a key that is neither tx nor op source", () => {
      const a = Keypair.random();
      const c = Keypair.random();
      const source = a.publicKey();

      const canonicalXdr = buildTx(source, "1").toXdr();
      const partialFromC = signPartial(source, "1", c);

      expect(() => mergeSignatures(canonicalXdr, [partialFromC], NET)).toThrow(
        /does not match any known signer/,
      );
    });
  });
});

describe("canonicalizeSignatures", () => {
  it("keeps one verified signature per expected signer and drops junk", () => {
    const source = Keypair.random();
    const other = Keypair.random();
    const tx = TransactionBuilder.fromXdr(signPartial(source.publicKey(), "1", source), NET);
    // five junk signatures plus a valid one from a key that is not a signer
    for (let i = 0; i < 5; i++) {
      tx.signatures.push(
        new xdr.DecoratedSignature({
          hint: Buffer.from([i, 1, 2, 3]),
          signature: Buffer.alloc(64, i + 1),
        }),
      );
    }
    tx.sign(Keypair.random());
    tx.sign(source); // a duplicate of the valid one
    const out = canonicalizeSignatures(tx.toXdr(), NET, [source.publicKey(), other.publicKey()]);
    const parsed = TransactionBuilder.fromXdr(out, NET);
    expect(parsed.signatures).toHaveLength(1);
    expect(source.verify(parsed.hash(), parsed.signatures[0]!.signature.toBytes())).toBe(true);
    // a later co-signer still merges into the canonical envelope
    const merged = mergeSignatures(out, [signPartial(source.publicKey(), "1", other)], NET, {
      expectedSigners: [source.publicKey(), other.publicKey()],
    });
    expect(TransactionBuilder.fromXdr(merged, NET).signatures).toHaveLength(2);
  });
});

describe("the 20-signature envelope limit", () => {
  it("rejects the 21st signature with a clear error instead of an XDR write failure", () => {
    const source = Keypair.random();
    const keys = Array.from({ length: 21 }, () => Keypair.random());
    const expectedSigners = keys.map((k) => k.publicKey());
    let canonical = buildTx(source.publicKey(), "1").toXdr();
    for (let i = 0; i < 20; i++) {
      canonical = mergeSignatures(
        canonical,
        [signPartial(source.publicKey(), "1", keys[i]!)],
        NET,
        {
          expectedSigners,
        },
      );
    }
    expect(TransactionBuilder.fromXdr(canonical, NET).signatures).toHaveLength(20);
    expect(() =>
      mergeSignatures(canonical, [signPartial(source.publicKey(), "1", keys[20]!)], NET, {
        expectedSigners,
      }),
    ).toThrow(TooManySignaturesError);
  });
});

describe("trimToThreshold (H-32)", () => {
  // core walks the envelope in order and stops at the needed weight; anything
  // after that is unused and fails the transaction with tx_bad_auth_extra
  it("keeps signatures in envelope order until the required weight is reached", () => {
    const [a, b, c] = [Keypair.random(), Keypair.random(), Keypair.random()];
    const signers = [a, b, c].map((k) => ({ key: k.publicKey(), weight: 1 }));
    const env = TransactionBuilder.fromXdr(buildTx(a.publicKey(), "1").toXdr(), NET);
    env.sign(c);
    env.sign(a);
    env.sign(b);
    const res = trimToThreshold(env.toXdr(), NET, signers, 2);
    expect(res.kept).toEqual([c.publicKey(), a.publicKey()]);
    expect(res.weight).toBe(2);
    expect(res.met).toBe(true);
    expect(TransactionBuilder.fromXdr(res.xdr, NET).signatures).toHaveLength(2);
    expect(
      signedSigners(
        res.xdr,
        NET,
        [a, b, c].map((k) => k.publicKey()),
      ),
    ).toEqual([a.publicKey(), c.publicKey()]);
  });

  it("drops signatures from non-signers and duplicates, and reports a short envelope", () => {
    const [a, b, stranger] = [Keypair.random(), Keypair.random(), Keypair.random()];
    const signers = [
      { key: a.publicKey(), weight: 1 },
      { key: b.publicKey(), weight: 2 },
    ];
    const env = TransactionBuilder.fromXdr(buildTx(a.publicKey(), "1").toXdr(), NET);
    env.sign(stranger);
    env.sign(a);
    env.sign(a);
    const res = trimToThreshold(env.toXdr(), NET, signers, 3);
    expect(res.kept).toEqual([a.publicKey()]);
    expect(res.weight).toBe(1);
    expect(res.met).toBe(false);
    expect(TransactionBuilder.fromXdr(res.xdr, NET).signatures).toHaveLength(1);
  });

  it("rewrites each kept signature with its signer's canonical hint", () => {
    const a = Keypair.random();
    const signed = TransactionBuilder.fromXdr(signPartial(a.publicKey(), "1", a), NET);
    const sig = signed.signatures[0]!.signature.toBytes();
    const odd = TransactionBuilder.fromXdr(buildTx(a.publicKey(), "1").toXdr(), NET);
    odd.signatures.push(
      new xdr.DecoratedSignature({ hint: Buffer.from([1, 2, 3, 4]), signature: sig }),
    );
    const res = trimToThreshold(odd.toXdr(), NET, [{ key: a.publicKey(), weight: 1 }], 1);
    const hint = TransactionBuilder.fromXdr(res.xdr, NET).signatures[0]!.hint.toBytes();
    expect(Buffer.from(hint).equals(Buffer.from(a.signatureHint()))).toBe(true);
  });
});

describe("signer matching by hint", () => {
  // a signature carried under another signer's hint, or under a hint no signer
  // has, still belongs to the key that made it
  function rehinted(kp: Keypair, source: string, hint: Buffer): xdr.DecoratedSignature {
    const sig = TransactionBuilder.fromXdr(signPartial(source, "1", kp), NET).signatures[0]!;
    return new xdr.DecoratedSignature({ hint, signature: sig.signature.toBytes() });
  }

  it("counts signers whose signatures carry a wrong or a borrowed hint", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const c = Keypair.random();
    const source = a.publicKey();
    const tx = TransactionBuilder.fromXdr(buildTx(source, "1").toXdr(), NET);
    tx.signatures.push(rehinted(a, source, Buffer.from(b.signatureHint())));
    tx.signatures.push(rehinted(c, source, Buffer.from([9, 9, 9, 9])));
    const keys = [a, b, c].map((k) => k.publicKey());
    expect(signedSigners(tx.toXdr(), NET, keys)).toEqual([a.publicKey(), c.publicKey()]);
    const res = trimToThreshold(
      tx.toXdr(),
      NET,
      keys.map((key) => ({ key, weight: 1 })),
      2,
    );
    expect(res.kept).toEqual([a.publicKey(), c.publicKey()]);
    expect(res.met).toBe(true);
    expect(canonicalizeSignatures(tx.toXdr(), NET, keys)).toBe(
      (() => {
        const want = TransactionBuilder.fromXdr(buildTx(source, "1").toXdr(), NET);
        want.signatures.push(rehinted(a, source, Buffer.from(a.signatureHint())));
        want.signatures.push(rehinted(c, source, Buffer.from(c.signatureHint())));
        return want.toXdr();
      })(),
    );
  });
});
