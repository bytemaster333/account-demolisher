import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// the module is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

// a throwaway master seed (never funded) — used only as the HMAC derivation key
process.env.MEDIATOR_SECRET = Keypair.random().secret();

import {
  startMediatorFlow,
  resolveMediatorFlow,
  __resetMediatorKeypairForTests,
} from "@/server/mediator-secret";

describe("mediator ephemeral per-flow keys", () => {
  beforeEach(() => {
    __resetMediatorKeypairForTests();
  });

  it("mints a valid ephemeral public key and a token", () => {
    const flow = startMediatorFlow();
    expect(StrKey.isValidEd25519PublicKey(flow.mediatorPublicKey)).toBe(true);
    expect(flow.flowToken.split(".")).toHaveLength(3);
  });

  it("gives each flow a DIFFERENT key (no shared mediator across users)", () => {
    const a = startMediatorFlow();
    const b = startMediatorFlow();
    expect(a.mediatorPublicKey).not.toBe(b.mediatorPublicKey);
    expect(a.flowToken).not.toBe(b.flowToken);
  });

  it("resolves a fresh token to the keypair matching its public key", () => {
    const flow = startMediatorFlow();
    const kp = resolveMediatorFlow(flow.flowToken);
    expect(kp).not.toBeNull();
    expect(kp!.publicKey()).toBe(flow.mediatorPublicKey);
  });

  it("rejects a token with a tampered HMAC (forgery)", () => {
    const flow = startMediatorFlow();
    const [nonce, exp] = flow.flowToken.split(".");
    const forged = `${nonce}.${exp}.${"0".repeat(64)}`;
    expect(resolveMediatorFlow(forged)).toBeNull();
  });

  it("rejects a token whose destination account an attacker cannot forge without the master", () => {
    // an attacker knows a victim's ephemeral pubkey (it appears on-chain) but not
    // its flow token; any token they craft resolves to a DIFFERENT key, so the
    // route would refuse to sign a drain of the victim's account.
    const victim = startMediatorFlow();
    const attackerNonce = "ffffffffffffffffffffffffffffffff";
    const attackerToken = `${attackerNonce}.${Date.now() + 60_000}.${"a".repeat(64)}`;
    const resolved = resolveMediatorFlow(attackerToken);
    // forged mac -> null; even if it resolved, its key != victim's
    expect(resolved).toBeNull();
    expect(victim.mediatorPublicKey).not.toBe("");
  });

  it("rejects an expired token", () => {
    const flow = startMediatorFlow(1_000);
    // now is well past mint time + TTL
    expect(resolveMediatorFlow(flow.flowToken, 1_000 + 60 * 60 * 1000)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(resolveMediatorFlow("")).toBeNull();
    expect(resolveMediatorFlow("a.b")).toBeNull();
    expect(resolveMediatorFlow(null)).toBeNull();
    expect(resolveMediatorFlow(42)).toBeNull();
    expect(resolveMediatorFlow("NOTHEX.123.abc")).toBeNull();
  });
});
