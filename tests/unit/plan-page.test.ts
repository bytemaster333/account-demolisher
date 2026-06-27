import { Account, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, it, expect } from "vitest";

import { verifyEnvelope } from "@/app/plan/[id]/page";

// verifyEnvelope cryptographically binds a Refractor-returned envelope to the
// id in the URL and the app's network. these lock in that a tampered/mismatched
// envelope fails verification (so the sign action is suppressed) while a genuine
// one that hashes to its id on the configured network passes.

// build a real classic tx on `passphrase`, returning its base64 XDR and the
// hex tx hash Refractor would key it under (== the /plan/{id} id)
function buildTx(passphrase: string): { xdr: string; id: string } {
  const source = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0",
  );
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: passphrase })
    .addOperation(
      Operation.bumpSequence({ bumpTo: "1" }),
    )
    .setTimeout(0)
    .build();
  return { xdr: tx.toXDR(), id: tx.hash().toString("hex") };
}

const PUBLIC = Networks.PUBLIC;
const TESTNET = Networks.TESTNET;

describe("verifyEnvelope — binds envelope to link + network", () => {
  it("passes for an envelope that hashes to its id on the configured network", () => {
    const { xdr, id } = buildTx(TESTNET);
    const v = verifyEnvelope(id, { xdr, network: "testnet" }, TESTNET);
    expect(v).toEqual({ hashOk: true, networkOk: true, verified: true });
  });

  it("fails hashOk when the id does not match the envelope's real hash", () => {
    const { xdr } = buildTx(TESTNET);
    // the id in the URL points at a different transaction than what was returned
    const v = verifyEnvelope("deadbeef".repeat(8), { xdr, network: "testnet" }, TESTNET);
    expect(v.hashOk).toBe(false);
    expect(v.verified).toBe(false);
  });

  it("fails networkOk when the returned network token differs from the app network", () => {
    // envelope legitimately hashes to id, but the app is on public while the
    // response claims testnet — refuse to show the sign action
    const { xdr, id } = buildTx(PUBLIC);
    const v = verifyEnvelope(id, { xdr, network: "testnet" }, PUBLIC);
    expect(v.hashOk).toBe(true);
    expect(v.networkOk).toBe(false);
    expect(v.verified).toBe(false);
  });

  it("maps the public passphrase to Refractor's 'public' token", () => {
    const { xdr, id } = buildTx(PUBLIC);
    const v = verifyEnvelope(id, { xdr, network: "public" }, PUBLIC);
    expect(v).toEqual({ hashOk: true, networkOk: true, verified: true });
  });

  it("fails safely (does not throw) on a malformed XDR", () => {
    const v = verifyEnvelope("abc", { xdr: "not-base64-xdr", network: "testnet" }, TESTNET);
    expect(v.hashOk).toBe(false);
    expect(v.verified).toBe(false);
  });

  it("fails hashOk when the envelope is hashed under a different passphrase", () => {
    // same bytes, wrong network passphrase => different hash => mismatch with id
    const { xdr, id } = buildTx(TESTNET);
    const v = verifyEnvelope(id, { xdr, network: "public" }, PUBLIC);
    expect(v.hashOk).toBe(false);
    expect(v.verified).toBe(false);
  });
});
