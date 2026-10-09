import {
  Account,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  closeSignerSet,
  decodePinned,
  EnvelopeMismatchError,
  mergeRelayEnvelope,
  trimToThreshold,
} from "@/components/multisig/envelope";
import { TooManySignaturesError } from "@/lib/multisig/partial-xdr";

const NET = Networks.TESTNET;
const source = Keypair.random();
const a = Keypair.random();
const b = Keypair.random();
const stranger = Keypair.random();

function build(dest = Keypair.random().publicKey()): Transaction {
  return new TransactionBuilder(new Account(source.publicKey(), "41"), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.accountMerge({ destination: dest }))
    .build();
}

const tx = build();
const id = Buffer.from(tx.hash()).toString("hex");

function signed(...kps: Keypair[]): string {
  const t = TransactionBuilder.fromXdr(tx.toXdr(), NET) as Transaction;
  for (const kp of kps) t.sign(kp);
  return t.toXdr();
}

function keysOf(envelope: string): string[] {
  const t = TransactionBuilder.fromXdr(envelope, NET) as Transaction;
  const hash = t.hash();
  return t.signatures.map(
    (s) =>
      [source, a, b, stranger].find((kp) => kp.verify(hash, s.signature.toBytes()))?.publicKey() ??
      "unknown",
  );
}

const w1 = (...kps: Keypair[]) => kps.map((k) => ({ key: k.publicKey(), weight: 1 }));

describe("trimToThreshold", () => {
  it("keeps signatures in envelope order until the weight is met", () => {
    const r = trimToThreshold(signed(source, a, b), NET, w1(source, a, b), 2);
    expect(r.met).toBe(true);
    expect(r.weight).toBe(2);
    expect(r.kept).toEqual([source.publicKey(), a.publicKey()]);
    expect(keysOf(r.xdr)).toEqual([source.publicKey(), a.publicKey()]);
  });

  it("drops a signature from a key that is not a current signer", () => {
    const r = trimToThreshold(signed(stranger, source, a), NET, w1(source, a), 2);
    expect(r.kept).toEqual([source.publicKey(), a.publicKey()]);
    expect(keysOf(r.xdr)).toEqual([source.publicKey(), a.publicKey()]);
  });

  it("counts weights, not signatures", () => {
    const signers = [
      { key: source.publicKey(), weight: 1 },
      { key: a.publicKey(), weight: 3 },
      { key: b.publicKey(), weight: 1 },
    ];
    const r = trimToThreshold(signed(a, source, b), NET, signers, 3);
    expect(r.kept).toEqual([a.publicKey()]);
    expect(r.weight).toBe(3);
  });

  it("reports a shortfall and keeps every usable signature", () => {
    const r = trimToThreshold(signed(source, stranger), NET, w1(source, a, b), 2);
    expect(r.met).toBe(false);
    expect(r.weight).toBe(1);
    expect(keysOf(r.xdr)).toEqual([source.publicKey()]);
  });

  it("counts a duplicate signature from the same key once", () => {
    const t = TransactionBuilder.fromXdr(signed(source), NET) as Transaction;
    const first = t.signatures[0]!;
    // same signature bytes under a junk hint
    t.signatures.push(
      new xdr.DecoratedSignature({
        hint: new Uint8Array([1, 2, 3, 4]),
        signature: first.signature.toBytes(),
      }),
    );
    const r = trimToThreshold(t.toXdr(), NET, w1(source, a), 2);
    expect(r.met).toBe(false);
    expect(r.kept).toEqual([source.publicKey()]);
  });

  it("rewrites a kept signature's hint to the signer's real hint", () => {
    const t = TransactionBuilder.fromXdr(tx.toXdr(), NET) as Transaction;
    const sig = a.sign(t.hash());
    t.signatures.push(
      new xdr.DecoratedSignature({ hint: new Uint8Array([9, 9, 9, 9]), signature: sig }),
    );
    const r = trimToThreshold(t.toXdr(), NET, w1(a), 1);
    const out = TransactionBuilder.fromXdr(r.xdr, NET) as Transaction;
    expect(Buffer.from(out.signatures[0]!.hint.toBytes())).toEqual(Buffer.from(a.signatureHint()));
  });
});

describe("decodePinned", () => {
  it("accepts the transaction the id names", () => {
    expect(decodePinned(signed(source), NET, id).source).toBe(source.publicKey());
  });

  it("rejects a different transaction", () => {
    const other = build();
    other.sign(source);
    expect(() => decodePinned(other.toXdr(), NET, id)).toThrow(EnvelopeMismatchError);
  });

  it("rejects garbage", () => {
    expect(() => decodePinned("not xdr", NET, id)).toThrow(EnvelopeMismatchError);
  });
});

describe("mergeRelayEnvelope", () => {
  const signers = [source, a, b].map((k) => k.publicKey());

  it("only ever adds signatures", () => {
    const held = signed(source, b);
    const stale = signed(source, a);
    const merged = mergeRelayEnvelope(held, stale, NET, id, signers);
    expect(keysOf(merged)).toEqual([source.publicKey(), b.publicKey(), a.publicKey()]);
  });

  it("returns the held envelope unchanged when nothing is new", () => {
    const held = signed(source, a);
    expect(mergeRelayEnvelope(held, signed(source), NET, id, signers)).toBe(held);
  });

  it("refuses an envelope for a different transaction", () => {
    const other = build();
    other.sign(source, a);
    expect(() => mergeRelayEnvelope(signed(source), other.toXdr(), NET, id, signers)).toThrow(
      EnvelopeMismatchError,
    );
  });

  // a hostile relay can send correctly hashed frames full of signatures from
  // keys that are not signers; two such frames used to push the held envelope
  // past 20 signatures, and serializing it then threw during render (NP5-49)
  it("adds only signatures from the account's signers", () => {
    const junk = () => Array.from({ length: 11 }, () => Keypair.random());
    let held = signed(source);
    held = mergeRelayEnvelope(held, signed(source, a, ...junk()), NET, id, signers);
    held = mergeRelayEnvelope(held, signed(source, ...junk()), NET, id, signers);
    expect(keysOf(held)).toEqual([source.publicKey(), a.publicKey()]);
  });

  it("adds one signature per signer, however many hints it comes under", () => {
    const t = TransactionBuilder.fromXdr(signed(source, a), NET) as Transaction;
    const sig = t.signatures[1]!;
    for (let i = 0; i < 5; i++) {
      t.signatures.push(
        new xdr.DecoratedSignature({
          hint: Buffer.from([i, i, i, i]),
          signature: sig.signature.toBytes(),
        }),
      );
    }
    const merged = mergeRelayEnvelope(signed(source), t.toXdr(), NET, id, signers);
    expect(keysOf(merged)).toEqual([source.publicKey(), a.publicKey()]);
  });

  it("refuses to grow the envelope past 20 signatures", () => {
    const many = Array.from({ length: 21 }, () => Keypair.random());
    const keys = many.map((k) => k.publicKey());
    const held = signed(...many.slice(0, 20));
    expect(() => mergeRelayEnvelope(held, signed(many[20]!), NET, id, keys)).toThrow(
      TooManySignaturesError,
    );
  });
});

describe("closeSignerSet", () => {
  it("needs the largest of the three thresholds and skips zero-weight and non-ed25519 signers", () => {
    const account = new Horizon.AccountResponse({
      id: source.publicKey(),
      account_id: source.publicKey(),
      sequence: "1",
      subentry_count: 0,
      thresholds: { low_threshold: 1, med_threshold: 3, high_threshold: 2 },
      signers: [
        { key: source.publicKey(), weight: 1, type: "ed25519_public_key" },
        { key: a.publicKey(), weight: 0, type: "ed25519_public_key" },
        { key: "TBAD", weight: 1, type: "preauth_tx" },
      ],
      balances: [],
      data: {},
      flags: {},
    } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
    const set = closeSignerSet(account);
    expect(set.required).toBe(3);
    expect(set.signers).toEqual([{ key: source.publicKey(), weight: 1 }]);
  });
});
