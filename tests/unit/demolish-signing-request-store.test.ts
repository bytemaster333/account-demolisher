// @vitest-environment happy-dom

import { describe, it, expect, afterEach } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  clearSigningRequest,
  loadSigningRequest,
  saveSigningRequest,
  sameOperationsAndMemo,
  verifyRelayEnvelope,
  type StoredSigningRequest,
} from "@/app/demolish/_lib/signing-request-store";

afterEach(() => clearSigningRequest());

const owner = Keypair.random();
const dest = Keypair.random().publicKey();

function closeTx(destination: string, memo: Memo = Memo.none(), seq = "10"): Transaction {
  const tx = new TransactionBuilder(new Account(owner.publicKey(), seq), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
    memo,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: "1" }))
    .addOperation(Operation.accountMerge({ destination }))
    .setTimeout(3600)
    .build();
  tx.sign(owner);
  return tx;
}

function record(over: Partial<StoredSigningRequest> = {}): StoredSigningRequest {
  return {
    planId: "a".repeat(64),
    networkId: "testnet",
    publicKey: owner.publicKey(),
    destination: dest,
    returnToIssuer: [],
    sendToDestination: [],
    selectedCbIds: [],
    validUntil: Date.now() + 3600_000,
    createdAt: Date.now(),
    ...over,
  };
}

describe("persisted signing request (L-54)", () => {
  it("round-trips for the same account and network", () => {
    saveSigningRequest(record({ memo: { type: "id", value: "42" } }));
    const loaded = loadSigningRequest(owner.publicKey(), "testnet", Date.now());
    expect(loaded?.planId).toBe("a".repeat(64));
    expect(loaded?.memo).toEqual({ type: "id", value: "42" });
  });

  it("is not shown for a different account or network", () => {
    saveSigningRequest(record());
    expect(loadSigningRequest(Keypair.random().publicKey(), "testnet", Date.now())).toBeNull();
    expect(loadSigningRequest(owner.publicKey(), "mainnet", Date.now())).toBeNull();
  });

  it("drops an expired request", () => {
    saveSigningRequest(record({ validUntil: Date.now() - 1 }));
    expect(loadSigningRequest(owner.publicKey(), "testnet", Date.now())).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });
});

describe("verifyRelayEnvelope (L-54)", () => {
  it("accepts the envelope whose hash is the request id", () => {
    const tx = closeTx(dest);
    const planId = Buffer.from(tx.hash()).toString("hex");
    const result = verifyRelayEnvelope({
      planId,
      relay: { network: "testnet", xdr: tx.toXdr() },
      expected: { networkId: "testnet", publicKey: owner.publicKey(), destination: dest },
      passphrase: Networks.TESTNET,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an envelope whose hash doesn't match the id", () => {
    const planId = Buffer.from(closeTx(dest).hash()).toString("hex");
    const other = closeTx(dest, Memo.none(), "11");
    const result = verifyRelayEnvelope({
      planId,
      relay: { network: "testnet", xdr: other.toXdr() },
      expected: { networkId: "testnet", publicKey: owner.publicKey(), destination: dest },
      passphrase: Networks.TESTNET,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a close to a different destination", () => {
    const evil = Keypair.random().publicKey();
    const tx = closeTx(evil);
    const result = verifyRelayEnvelope({
      planId: Buffer.from(tx.hash()).toString("hex"),
      relay: { network: "testnet", xdr: tx.toXdr() },
      expected: { networkId: "testnet", publicKey: owner.publicKey(), destination: dest },
      passphrase: Networks.TESTNET,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a request on another network", () => {
    const tx = closeTx(dest);
    const result = verifyRelayEnvelope({
      planId: Buffer.from(tx.hash()).toString("hex"),
      relay: { network: "mainnet", xdr: tx.toXdr() },
      expected: { networkId: "testnet", publicKey: owner.publicKey(), destination: dest },
      passphrase: Networks.TESTNET,
    });
    expect(result.ok).toBe(false);
  });
});

describe("sameOperationsAndMemo", () => {
  it("ignores sequence, time bounds and signatures but not operations or memo", () => {
    expect(
      sameOperationsAndMemo(closeTx(dest, Memo.id("1"), "10"), closeTx(dest, Memo.id("1"), "99")),
    ).toBe(true);
    expect(sameOperationsAndMemo(closeTx(dest, Memo.id("1")), closeTx(dest, Memo.id("2")))).toBe(
      false,
    );
    expect(sameOperationsAndMemo(closeTx(dest), closeTx(Keypair.random().publicKey()))).toBe(false);
  });
});
