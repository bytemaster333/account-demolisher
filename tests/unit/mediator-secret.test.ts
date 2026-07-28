import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// the module is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

// a throwaway master seed (never funded), used only as the HMAC derivation key
process.env.MEDIATOR_SECRET = Keypair.random().secret();

import {
  startMediatorFlow,
  resolveMediatorFlow,
  __resetMediatorKeypairForTests,
} from "@/server/mediator-secret";

const DEST = Keypair.random().publicKey();

describe("mediator ephemeral per-flow keys", () => {
  beforeEach(() => {
    __resetMediatorKeypairForTests();
  });

  it("mints a valid ephemeral public key and a 4-part token", () => {
    const flow = startMediatorFlow(DEST);
    expect(StrKey.isValidEd25519PublicKey(flow.mediatorPublicKey)).toBe(true);
    // nonce.expiry.destination.mac
    expect(flow.flowToken.split(".")).toHaveLength(4);
  });

  it("gives each flow a DIFFERENT key (no shared mediator across users)", () => {
    const a = startMediatorFlow(DEST);
    const b = startMediatorFlow(DEST);
    expect(a.mediatorPublicKey).not.toBe(b.mediatorPublicKey);
    expect(a.flowToken).not.toBe(b.flowToken);
  });

  it("resolves a fresh token to its keypair AND its committed destination", () => {
    const flow = startMediatorFlow(DEST);
    const resolved = resolveMediatorFlow(flow.flowToken);
    expect(resolved).not.toBeNull();
    expect(resolved!.keypair.publicKey()).toBe(flow.mediatorPublicKey);
    expect(resolved!.destination).toBe(DEST);
  });

  it("rejects a token with a tampered HMAC (forgery)", () => {
    const flow = startMediatorFlow(DEST);
    const [nonce, exp, dest] = flow.flowToken.split(".");
    const forged = `${nonce}.${exp}.${dest}.${"0".repeat(64)}`;
    expect(resolveMediatorFlow(forged)).toBeNull();
  });

  it("rejects a token whose destination was swapped (SEC-16: destination is HMAC-bound)", () => {
    const flow = startMediatorFlow(DEST);
    const [nonce, exp, , mac] = flow.flowToken.split(".");
    const other = Keypair.random().publicKey();
    const swapped = `${nonce}.${exp}.${other}.${mac}`;
    expect(resolveMediatorFlow(swapped)).toBeNull();
  });

  it("rejects a forged token crafted without the master seed", () => {
    const attackerNonce = "ffffffffffffffffffffffffffffffff";
    const attackerToken = `${attackerNonce}.${Date.now() + 60_000}.${DEST}.${"a".repeat(64)}`;
    expect(resolveMediatorFlow(attackerToken)).toBeNull();
  });

  it("rejects an expired token", () => {
    const flow = startMediatorFlow(DEST, 1_000);
    // now is well past mint time + TTL
    expect(resolveMediatorFlow(flow.flowToken, 1_000 + 60 * 60 * 1000)).toBeNull();
  });

  it("rejects an invalid destination at mint time", () => {
    expect(() => startMediatorFlow("not-a-key")).toThrow();
  });

  it("rejects malformed input", () => {
    expect(resolveMediatorFlow("")).toBeNull();
    expect(resolveMediatorFlow("a.b.c")).toBeNull();
    expect(resolveMediatorFlow(null)).toBeNull();
    expect(resolveMediatorFlow(42)).toBeNull();
    expect(resolveMediatorFlow("NOTHEX.123.G.abc")).toBeNull();
  });
});
