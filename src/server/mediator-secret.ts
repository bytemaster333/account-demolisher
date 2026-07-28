import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { getServerEnv } from "@/server/server-env";

// Ephemeral per-flow mediator keys.
//
// The mediator co-signs a 2-op "forward" (native payout + accountMerge) so a
// close-out can reach a memo-required exchange. Earlier this used ONE shared
// MEDIATOR_SECRET keypair for every user: because the sign route co-signs any
// well-formed forward to any destination, an attacker who learned that shared
// public key could drain whatever XLM transited it, including another user's
// in-flight merge proceeds.
//
// Instead, MEDIATOR_SECRET is now only a MASTER key. Each close-out gets its own
// throwaway keypair, derived deterministically from a random per-flow nonce, and
// a signed flow token binds the sign request to that nonce. An attacker can only
// ever act on a flow whose token they hold (i.e. their own), and that flow's
// account only ever holds their own funds, so cross-user theft is impossible.
// Derivation is stateless (no per-flow seed storage), so it survives across
// server instances.

// long enough to build + sign a plan and reach the forward step; short enough to
// bound replay of a leaked token.
const FLOW_TTL_MS = 15 * 60 * 1000;

const KEY_DERIVATION_LABEL = "mediator-flow-key";
const TOKEN_MAC_LABEL = "mediator-flow-token";

// the 32-byte ed25519 seed of MEDIATOR_SECRET, used purely as the HMAC master
// key, never as a signing key. Memoized.
let cachedMaster: Buffer | null = null;

function getMasterSecret(): Buffer {
  if (cachedMaster !== null) return cachedMaster;

  const seed = getServerEnv().MEDIATOR_SECRET;
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error(
      "MEDIATOR_SECRET is not set. The mediator flow is unavailable until the deployment configures a master seed.",
    );
  }
  if (!StrKey.isValidEd25519SecretSeed(seed)) {
    throw new Error(
      "MEDIATOR_SECRET is malformed: not a valid Ed25519 secret seed (expected an S-prefixed Stellar seed of length 56).",
    );
  }

  cachedMaster = Buffer.from(Keypair.fromSecret(seed).rawSecretKey());
  return cachedMaster;
}

function hmac(msg: string): Buffer {
  return createHmac("sha256", getMasterSecret()).update(msg).digest();
}

// deterministic per-flow keypair. same nonce + master → same keypair, so no
// per-flow seed ever needs to be stored.
function deriveFlowKeypair(nonceHex: string): Keypair {
  const seed = hmac(`${KEY_DERIVATION_LABEL}:${nonceHex}`); // 32 bytes
  return Keypair.fromRawEd25519Seed(seed);
}

export interface MediatorFlow {
  // opaque token the client echoes back at sign time to unlock this flow's key
  readonly flowToken: string;
  // the ephemeral account the plan funds + merges into for this flow only
  readonly mediatorPublicKey: string;
}

export interface ResolvedMediatorFlow {
  readonly keypair: Keypair;
  // the destination this flow's forward is BOUND to. The sign route rejects any
  // forward whose payout/merge target differs from this, so a leaked token can
  // only ever move the flow's funds to the destination the user committed to.
  readonly destination: string;
}

// mint a fresh ephemeral mediator flow: a random nonce, an HMAC-signed token
// carrying nonce+expiry+destination, and the public key derived from that nonce.
// The destination is committed here so the co-signer is bound to it (SEC-16).
export function startMediatorFlow(destination: string, now: number = Date.now()): MediatorFlow {
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    throw new Error("startMediatorFlow: destination must be a valid Stellar public key (G...).");
  }
  const nonceHex = randomBytes(16).toString("hex");
  const expiry = now + FLOW_TTL_MS;
  const body = `${nonceHex}.${expiry}.${destination}`;
  const mac = hmac(`${TOKEN_MAC_LABEL}:${body}`).toString("hex");
  return {
    flowToken: `${body}.${mac}`,
    mediatorPublicKey: deriveFlowKeypair(nonceHex).publicKey(),
  };
}

// verify a flow token and return its ephemeral keypair + committed destination,
// or null if the token is malformed, forged (bad HMAC) or expired. The HMAC
// compare is constant-time.
export function resolveMediatorFlow(
  flowToken: unknown,
  now: number = Date.now(),
): ResolvedMediatorFlow | null {
  if (typeof flowToken !== "string") return null;
  const parts = flowToken.split(".");
  if (parts.length !== 4) return null;
  const [nonceHex, expiryStr, destination, macHex] = parts;
  if (nonceHex === undefined || !/^[0-9a-f]{32}$/u.test(nonceHex)) return null;
  if (destination === undefined || !StrKey.isValidEd25519PublicKey(destination)) return null;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= now) return null;

  const expectedMac = hmac(`${TOKEN_MAC_LABEL}:${nonceHex}.${expiryStr}.${destination}`);
  let providedMac: Buffer;
  try {
    providedMac = Buffer.from(macHex ?? "", "hex");
  } catch {
    return null;
  }
  if (providedMac.length !== expectedMac.length) return null;
  if (!timingSafeEqual(providedMac, expectedMac)) return null;

  return { keypair: deriveFlowKeypair(nonceHex), destination };
}

// test-only: reset the cached master
export function __resetMediatorKeypairForTests(): void {
  cachedMaster = null;
}
