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
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

// RFP R14: non-custodial. The secret seed must never leave the client and must
// never be exposed on the connector's surface. Signing happens locally and the
// connector only ever returns signed XDR + the public key.

const NET = Networks.TESTNET;

function sampleTx(sourcePk: string): TransactionBuilder {
  return new TransactionBuilder(new Account(sourcePk, "1"), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  }).addOperation(Operation.payment({ destination: sourcePk, asset: Asset.native(), amount: "1" }));
}

describe("SecretKeyConnector construction", () => {
  it("rejects an empty seed", () => {
    expect(() => new SecretKeyConnector("")).toThrow();
  });

  it("rejects a non-seed string", () => {
    expect(() => new SecretKeyConnector("not-a-seed")).toThrow();
  });

  it("rejects a public key given where a seed is expected", () => {
    const pk = Keypair.random().publicKey();
    expect(() => new SecretKeyConnector(pk)).toThrow();
  });

  it("accepts a valid ed25519 secret seed and derives the matching public key", async () => {
    const kp = Keypair.random();
    const connector = new SecretKeyConnector(kp.secret());
    expect(await connector.getPublicKey()).toBe(kp.publicKey());
    expect((await connector.connect()).publicKey).toBe(kp.publicKey());
    expect(connector.kind).toBe("secret");
  });
});

describe("SecretKeyConnector non-custodial guarantee", () => {
  it("never exposes the seed on the object surface", () => {
    const kp = Keypair.random();
    const seed = kp.secret();
    const connector = new SecretKeyConnector(seed);

    // private #seed is not an own enumerable/named property
    expect(Object.getOwnPropertyNames(connector)).not.toContain("seed");
    expect(Object.values(connector as unknown as Record<string, unknown>)).not.toContain(seed);
    // serializing the connector must not leak the seed
    expect(JSON.stringify(connector)).not.toContain(seed);
    // common accidental accessors return nothing
    expect((connector as unknown as { seed?: string }).seed).toBeUndefined();
  });
});

describe("SecretKeyConnector signing", () => {
  it("produces a signature that verifies against the derived public key", async () => {
    const kp = Keypair.random();
    const connector = new SecretKeyConnector(kp.secret());
    const tx = sampleTx(kp.publicKey()).build();

    const { signedXdr, signerPublicKey } = await connector.signTransaction(tx, NET);
    expect(signerPublicKey).toBe(kp.publicKey());

    const signed = TransactionBuilder.fromXDR(signedXdr, NET);
    expect(signed.signatures).toHaveLength(1);
    // the signature is a real ed25519 signature over the tx hash by this keypair
    const sig = signed.signatures[0]!.signature();
    expect(kp.verify(signed.hash(), sig)).toBe(true);
  });

  it("does not mutate the input transaction (signs a clone)", async () => {
    const kp = Keypair.random();
    const connector = new SecretKeyConnector(kp.secret());
    const tx = sampleTx(kp.publicKey()).build();
    expect(tx.signatures).toHaveLength(0);

    await connector.signTransaction(tx, NET);
    // original stays unsigned; only the returned XDR carries the signature
    expect(tx.signatures).toHaveLength(0);
  });

  it("signAuthEntry returns a verifiable signature over the provided preimage bytes", async () => {
    const kp = Keypair.random();
    const connector = new SecretKeyConnector(kp.secret());
    const preimage = Buffer.from("some-auth-entry-preimage").toString("base64");

    const { signedXdr, signerAddress } = await connector.signAuthEntry(
      preimage,
      kp.publicKey(),
      NET,
    );
    expect(signerAddress).toBe(kp.publicKey());
    const ok = kp.verify(Buffer.from(preimage, "base64"), Buffer.from(signedXdr, "base64"));
    expect(ok).toBe(true);
  });

  it("rejects an empty auth-entry preimage", async () => {
    const kp = Keypair.random();
    const connector = new SecretKeyConnector(kp.secret());
    await expect(connector.signAuthEntry("", kp.publicKey(), NET)).rejects.toThrow();
  });
});
