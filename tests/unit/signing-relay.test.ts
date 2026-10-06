import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetRelayForTests,
  __seedPlanForTests,
  addSignature,
  getPlan,
  subscribe,
  subscriberStatus,
} from "@/server/signing-relay";

const NET = Networks.TESTNET;

function buildClose(sourcePk: string, destination: string, seq = "1") {
  return new TransactionBuilder(new Account(sourcePk, seq), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.accountMerge({ destination }))
    .build();
}

function signPartial(sourcePk: string, destination: string, kp: Keypair): string {
  const tx = TransactionBuilder.fromXdr(buildClose(sourcePk, destination).toXdr(), NET);
  tx.sign(kp);
  return tx.toXdr();
}

afterEach(() => __resetRelayForTests());

describe("signing-relay addSignature", () => {
  it("accepts a valid co-signer signature and keeps a full snapshot", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const source = a.publicKey();
    const dest = Keypair.random().publicKey();

    // seed with the initiator's (a) signature already present
    const id = __seedPlanForTests("testnet", signPartial(source, dest, a), [
      a.publicKey(),
      b.publicKey(),
    ]);

    const res = addSignature(id, signPartial(source, dest, b));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const tx = TransactionBuilder.fromXdr(res.plan.xdr, NET);
    expect(tx.signatures).toHaveLength(2);
    const hash = tx.hash();
    for (const kp of [a, b]) {
      expect(tx.signatures.some((s) => kp.verify(hash, s.signature.toBytes()))).toBe(true);
    }
  });

  it("rejects a signature from a key that isn't an authorized signer", () => {
    const a = Keypair.random();
    const intruder = Keypair.random();
    const source = a.publicKey();
    const dest = Keypair.random().publicKey();

    // only `a` is an authorized signer
    const id = __seedPlanForTests("testnet", signPartial(source, dest, a), [a.publicKey()]);

    const res = addSignature(id, signPartial(source, dest, intruder));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("REJECTED");
  });

  it("rejects a signature made over a DIFFERENT transaction", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const source = a.publicKey();
    const dest = Keypair.random().publicKey();
    const otherDest = Keypair.random().publicKey();

    const id = __seedPlanForTests("testnet", signPartial(source, dest, a), [
      a.publicKey(),
      b.publicKey(),
    ]);

    // b signs a close to a DIFFERENT destination; its hash won't match
    const res = addSignature(id, signPartial(source, otherDest, b));
    expect(res.ok).toBe(false);
  });

  it("404s for an unknown id", () => {
    const res = addSignature("deadbeef", "AAAA");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("NOT_FOUND");
  });

  it("rejects an oversized payload", () => {
    const a = Keypair.random();
    const dest = Keypair.random().publicKey();
    const id = __seedPlanForTests("testnet", signPartial(a.publicKey(), dest, a), [a.publicKey()]);
    const res = addSignature(id, "A".repeat(30_000));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("BAD_XDR");
  });
});

describe("signing-relay subscribe", () => {
  it("notifies subscribers with the merged envelope on each accepted signature", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const source = a.publicKey();
    const dest = Keypair.random().publicKey();
    const id = __seedPlanForTests("testnet", signPartial(source, dest, a), [
      a.publicKey(),
      b.publicKey(),
    ]);

    const seen: string[] = [];
    const unsub = subscribe(
      id,
      (plan) => seen.push(plan.xdr),
      () => {},
      "203.0.113.1",
    );
    expect(unsub).not.toBeNull();

    addSignature(id, signPartial(source, dest, b));
    expect(seen).toHaveLength(1);
    const tx = TransactionBuilder.fromXdr(seen[0]!, NET);
    expect(tx.signatures).toHaveLength(2);

    unsub?.();
    addSignature(id, signPartial(source, dest, b)); // idempotent, but no new push after unsub
    expect(seen).toHaveLength(1);
  });

  it("returns null when subscribing to an unknown id", () => {
    expect(
      subscribe(
        "nope",
        () => {},
        () => {},
        "203.0.113.1",
      ),
    ).toBeNull();
  });

  it("refuses a fourth stream from one client while other clients still get slots", () => {
    const a = Keypair.random();
    const dest = Keypair.random().publicKey();
    const id = __seedPlanForTests("testnet", signPartial(a.publicKey(), dest, a), [a.publicKey()]);
    const noop = (): void => {};
    for (let i = 0; i < 3; i++) expect(subscribe(id, noop, noop, "198.51.100.9")).not.toBeNull();
    expect(subscriberStatus(id, "198.51.100.9")).toBe("client-at-cap");
    expect(subscribe(id, noop, noop, "198.51.100.9")).toBeNull();
    expect(subscribe(id, noop, noop, "198.51.100.10")).not.toBeNull();
  });

  it("answers not-found for an expired plan before any stream is opened", () => {
    const a = Keypair.random();
    const dest = Keypair.random().publicKey();
    const old = Date.now() - 73 * 60 * 60 * 1000;
    const id = __seedPlanForTests(
      "testnet",
      signPartial(a.publicKey(), dest, a),
      [a.publicKey()],
      old,
    );
    expect(subscriberStatus(id, "198.51.100.9")).toBe("not-found");
  });
});

describe("signing-relay expiry", () => {
  it("sweeps plans older than the signing window", () => {
    const a = Keypair.random();
    const dest = Keypair.random().publicKey();
    const old = Date.now() - 73 * 60 * 60 * 1000;
    const id = __seedPlanForTests(
      "testnet",
      signPartial(a.publicKey(), dest, a),
      [a.publicKey()],
      old,
    );
    expect(getPlan(id)).toBeNull();
  });

  it("sweeps a plan whose transaction timebounds have passed even if just published", () => {
    // recent publish, but the transaction's own maxTime is already in the past:
    // expiry must key off the timebounds, not publish time, so we never serve a
    // tx that Horizon would reject as tx_too_late.
    const a = Keypair.random();
    const dest = Keypair.random().publicKey();
    const pastMax = Math.floor(Date.now() / 1000) - 3600;
    const tx = new TransactionBuilder(new Account(a.publicKey(), "1"), {
      fee: BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: 0, maxTime: pastMax },
    })
      .addOperation(Operation.accountMerge({ destination: dest }))
      .build();
    tx.sign(a);
    const id = __seedPlanForTests("testnet", tx.toXdr(), [a.publicKey()]);
    expect(getPlan(id)).toBeNull();
  });

  it("keeps a plan whose transaction timebounds are still in the future", () => {
    const a = Keypair.random();
    const dest = Keypair.random().publicKey();
    const futureMax = Math.floor(Date.now() / 1000) + 3600;
    const tx = new TransactionBuilder(new Account(a.publicKey(), "1"), {
      fee: BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: 0, maxTime: futureMax },
    })
      .addOperation(Operation.accountMerge({ destination: dest }))
      .build();
    tx.sign(a);
    const id = __seedPlanForTests("testnet", tx.toXdr(), [a.publicKey()]);
    expect(getPlan(id)).not.toBeNull();
  });
});
