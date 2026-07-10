import { describe, it, expect } from "vitest";

import { RefractorClient } from "@/lib/multisig/refractor";

// Refractor's GET /tx/{hash} returns `desiredSigners` (the required set) and
// `signatures` (collected so far), each as bare G-strings or { key } objects.
// These tests lock in how parseStatus derives the surfaced `signers`, the
// `signedBy` subset the per-signer UI reads, and `signaturesNeeded`.

const A = "GA00000000000000000000000000000000000000000000000000000AAAA";
const B = "GB00000000000000000000000000000000000000000000000000000BBBB";
const C = "GC00000000000000000000000000000000000000000000000000000CCCC";
const OUTSIDER = "GX00000000000000000000000000000000000000000000000000000XXXX";

// build a RefractorClient whose fetch returns the given JSON body with 200 OK
function clientReturning(body: unknown): RefractorClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return new RefractorClient({ fetchImpl });
}

const BASE = { hash: "abc123", network: "testnet", xdr: "AAAAxdr" };

describe("refractor parseStatus, signedBy derivation", () => {
  it("marks only the collected signers as signed, rest pending", async () => {
    const status = await clientReturning({
      ...BASE,
      desiredSigners: [{ key: A }, { key: B }, { key: C }],
      signatures: [{ key: A }],
    }).getStatus(BASE.hash);

    expect(status.signers).toEqual([A, B, C]);
    expect(status.signedBy).toEqual([A]);
    expect(status.signaturesNeeded).toBe(2);
  });

  it("normalizes bare-string signer arrays", async () => {
    const status = await clientReturning({
      ...BASE,
      desiredSigners: [A, B],
      signatures: [A, B],
    }).getStatus(BASE.hash);

    expect(status.signers).toEqual([A, B]);
    expect(status.signedBy).toEqual([A, B]);
    expect(status.signaturesNeeded).toBe(0);
  });

  it("intersects signedBy against the surfaced set (drops keys not in desiredSigners)", async () => {
    const status = await clientReturning({
      ...BASE,
      desiredSigners: [A, B],
      // a stray collected key outside the required set must not mark a signer
      signatures: [{ key: A }, { key: OUTSIDER }],
    }).getStatus(BASE.hash);

    expect(status.signers).toEqual([A, B]);
    expect(status.signedBy).toEqual([A]);
  });

  it("stays indeterminate (no fabricated signer list) when desiredSigners is absent", async () => {
    // when refractor hasn't resolved the required set, surfacing only the
    // already-collected keys would render a complete-looking list that hides the
    // missing signer(s). the surfaced list must be empty so the UI shows its
    // honest indeterminate state, while collectedCount still exposes progress.
    const status = await clientReturning({
      ...BASE,
      desiredSigners: null,
      signatures: [{ key: A }],
    }).getStatus(BASE.hash);

    expect(status.signers).toEqual([]);
    expect(status.signedBy).toEqual([]);
    expect(status.collectedCount).toBe(1);
  });

  it("reports no signers signed when signatures is empty", async () => {
    const status = await clientReturning({
      ...BASE,
      desiredSigners: [A, B],
      signatures: [],
    }).getStatus(BASE.hash);

    expect(status.signedBy).toEqual([]);
    expect(status.signaturesNeeded).toBe(2);
    expect(status.collectedCount).toBe(0);
  });

  it("surfaces refractor's own status/error strings for reconciliation", async () => {
    const status = await clientReturning({
      ...BASE,
      desiredSigners: [A, B],
      signatures: [A, B],
      status: "failed",
      error: "Failed to submit transaction",
    }).getStatus(BASE.hash);

    expect(status.status).toBe("failed");
    expect(status.error).toBe("Failed to submit transaction");
  });
});
