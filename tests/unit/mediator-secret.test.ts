import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, Memo, StrKey } from "@stellar/stellar-sdk";

// the module is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

// a throwaway master seed (never funded), used only as the HMAC derivation key
process.env.MEDIATOR_SECRET = Keypair.random().secret();

import { encodeMemoCommitment } from "@/lib/mediator/forward-terms";
import {
  startMediatorFlow,
  resolveMediatorFlow,
  reissueMediatorFlow,
  MEDIATOR_FLOW_TTL_MS,
  __resetMediatorKeypairForTests,
} from "@/server/mediator-secret";

const DEST = Keypair.random().publicKey();
const MEMO_ID = encodeMemoCommitment(Memo.id("12345"));
const MEMO_NONE = encodeMemoCommitment(Memo.none());
const TERMS = { destination: DEST, networkId: "mainnet" as const, memoXdr: MEMO_ID };

// token layout: v2.nonce.expiry.network.destination.memo.mac
function swapSegment(token: string, index: number, value: string): string {
  const parts = token.split(".");
  parts[index] = value;
  return parts.join(".");
}

describe("mediator ephemeral per-flow keys", () => {
  beforeEach(() => {
    __resetMediatorKeypairForTests();
  });

  it("mints a valid ephemeral public key and a versioned 7-part token", () => {
    const flow = startMediatorFlow(TERMS);
    expect(StrKey.isValidEd25519PublicKey(flow.mediatorPublicKey)).toBe(true);
    expect(flow.flowToken.split(".")).toHaveLength(7);
    expect(flow.flowToken.startsWith("v2.")).toBe(true);
  });

  it("gives each flow a DIFFERENT key (no shared mediator across users)", () => {
    const a = startMediatorFlow(TERMS);
    const b = startMediatorFlow(TERMS);
    expect(a.mediatorPublicKey).not.toBe(b.mediatorPublicKey);
    expect(a.flowToken).not.toBe(b.flowToken);
  });

  it("resolves a fresh token to its keypair and every committed term", () => {
    const flow = startMediatorFlow(TERMS, 1_000);
    const resolved = resolveMediatorFlow(flow.flowToken, 2_000);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.flow.keypair.publicKey()).toBe(flow.mediatorPublicKey);
    expect(resolved.flow.destination).toBe(DEST);
    expect(resolved.flow.networkId).toBe("mainnet");
    expect(resolved.flow.memoXdr).toBe(MEMO_ID);
    expect(resolved.flow.expiresAt).toBe(1_000 + MEDIATOR_FLOW_TTL_MS);
    expect(flow.expiresAt).toBe(1_000 + MEDIATOR_FLOW_TTL_MS);
  });

  it("rejects a token with a tampered HMAC (forgery)", () => {
    const flow = startMediatorFlow(TERMS);
    expect(resolveMediatorFlow(swapSegment(flow.flowToken, 6, "0".repeat(64)))).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  it("rejects a token whose destination was swapped", () => {
    const flow = startMediatorFlow(TERMS);
    const swapped = swapSegment(flow.flowToken, 4, Keypair.random().publicKey());
    expect(resolveMediatorFlow(swapped)).toEqual({ ok: false, reason: "forged" });
  });

  it("rejects a token whose memo was swapped (the memo is HMAC-bound)", () => {
    const flow = startMediatorFlow(TERMS);
    const swapped = swapSegment(flow.flowToken, 5, encodeMemoCommitment(Memo.id("666")));
    expect(resolveMediatorFlow(swapped)).toEqual({ ok: false, reason: "forged" });
    // dropping the memo is a swap too
    expect(resolveMediatorFlow(swapSegment(flow.flowToken, 5, MEMO_NONE))).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  it("rejects a token moved to the other network", () => {
    const flow = startMediatorFlow(TERMS);
    expect(resolveMediatorFlow(swapSegment(flow.flowToken, 3, "testnet"))).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  it("rejects a forged token crafted without the master seed", () => {
    const attackerToken = [
      "v2",
      "f".repeat(32),
      String(Date.now() + 60_000),
      "mainnet",
      DEST,
      MEMO_NONE,
      "a".repeat(64),
    ].join(".");
    expect(resolveMediatorFlow(attackerToken)).toEqual({ ok: false, reason: "forged" });
  });

  it("reports an authentic token past its expiry as expired, not forged", () => {
    const flow = startMediatorFlow(TERMS, 1_000);
    expect(resolveMediatorFlow(flow.flowToken, 1_000 + MEDIATOR_FLOW_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("re-issues an expired authentic token for the same mediator and terms", () => {
    const flow = startMediatorFlow(TERMS, 1_000);
    const later = 1_000 + 30 * 24 * 60 * 60 * 1000;
    const reissued = reissueMediatorFlow(flow.flowToken, later);
    expect(reissued.ok).toBe(true);
    if (!reissued.ok) return;
    expect(reissued.flow.mediatorPublicKey).toBe(flow.mediatorPublicKey);
    expect(reissued.flow.flowToken).not.toBe(flow.flowToken);
    const resolved = resolveMediatorFlow(reissued.flow.flowToken, later + 1);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.flow.keypair.publicKey()).toBe(flow.mediatorPublicKey);
    expect(resolved.flow.destination).toBe(DEST);
    expect(resolved.flow.memoXdr).toBe(MEMO_ID);
    expect(resolved.flow.networkId).toBe("mainnet");
  });

  it("never re-issues a forged or altered token", () => {
    const flow = startMediatorFlow(TERMS, 1_000);
    const altered = swapSegment(flow.flowToken, 4, Keypair.random().publicKey());
    expect(reissueMediatorFlow(altered, 1_000 + MEDIATOR_FLOW_TTL_MS * 2)).toEqual({
      ok: false,
      reason: "forged",
    });
    expect(reissueMediatorFlow("v2.a.b.c.d.e.f")).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects bad terms at mint time", () => {
    expect(() => startMediatorFlow({ ...TERMS, destination: "not-a-key" })).toThrow();
    expect(() => startMediatorFlow({ ...TERMS, memoXdr: "garbage" })).toThrow();
    expect(() =>
      startMediatorFlow({ ...TERMS, networkId: "futurenet" as unknown as "mainnet" }),
    ).toThrow();
  });

  it("rejects malformed input", () => {
    expect(resolveMediatorFlow("")).toEqual({ ok: false, reason: "malformed" });
    expect(resolveMediatorFlow("a.b.c")).toEqual({ ok: false, reason: "malformed" });
    expect(resolveMediatorFlow(null)).toEqual({ ok: false, reason: "malformed" });
    expect(resolveMediatorFlow(42)).toEqual({ ok: false, reason: "malformed" });
    // the old unversioned 4-part layout is no longer accepted
    expect(
      resolveMediatorFlow(`${"a".repeat(32)}.${Date.now() + 1000}.${DEST}.${"b".repeat(64)}`),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});
