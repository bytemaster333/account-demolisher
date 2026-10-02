import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import {
  decodeMemoCommitment,
  isMediatorNetworkId,
  type MediatorNetworkId,
} from "@/lib/mediator/forward-terms";
import { getServerEnv } from "@/server/server-env";

// Ephemeral per-flow mediator keys.
//
// The mediator co-signs a 2-op "forward" (native payout + accountMerge) so a
// close-out can reach a memo-required exchange. MEDIATOR_SECRET is only a master
// key: each close-out gets its own throwaway keypair, derived from a random
// per-flow nonce, and an HMAC flow token carries that nonce together with the
// terms the forward must meet (network, destination, deposit memo). The honest
// sign route only co-signs a forward that matches those terms.
//
// What this does not protect against: whoever holds MEDIATOR_SECRET (the
// operator, or anyone who compromises the server) can derive every mediator key
// and move any balance that is sitting in a mediator. The server also serves the
// app code. Exposure is bounded by how long funds sit in a mediator, not by
// cryptography. Script running in the page can mint its own flow, so the token
// binding does not help against a compromised page either; it limits what a
// token that leaks on its own (storage, logs) can be used for.
//
// Derivation is stateless (no per-flow seed storage), so it survives across
// server instances, and an expired token can be re-issued for the same nonce.

// long enough to build, sign and submit a close; an expired token is not a dead
// end because reissueMediatorFlow renews it for the same mediator and terms.
export const MEDIATOR_FLOW_TTL_MS = 15 * 60 * 1000;

const TOKEN_VERSION = "v2";
const KEY_DERIVATION_LABEL = "mediator-flow-key";
const TOKEN_MAC_LABEL = "mediator-flow-token-v2";

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

// deterministic per-flow keypair. same nonce + master gives the same keypair,
// so no per-flow seed ever needs to be stored.
function deriveFlowKeypair(nonceHex: string): Keypair {
  const seed = hmac(`${KEY_DERIVATION_LABEL}:${nonceHex}`); // 32 bytes
  return Keypair.fromRawEd25519Seed(seed);
}

// what a forward out of this flow's mediator must look like
export interface MediatorFlowTerms {
  readonly destination: string;
  readonly networkId: MediatorNetworkId;
  // base64 xdr of the deposit memo (MemoNone when the destination takes none)
  readonly memoXdr: string;
}

export interface MediatorFlow {
  // token the client echoes back at sign time to unlock this flow's key
  readonly flowToken: string;
  // the ephemeral account the plan funds and merges into for this flow only
  readonly mediatorPublicKey: string;
  // ms epoch after which the token must be re-issued before it signs again
  readonly expiresAt: number;
}

export interface ResolvedMediatorFlow extends MediatorFlowTerms {
  readonly keypair: Keypair;
  readonly expiresAt: number;
}

export type FlowTokenFailure = "malformed" | "forged" | "expired";

export type FlowResolution =
  | { readonly ok: true; readonly flow: ResolvedMediatorFlow }
  | { readonly ok: false; readonly reason: FlowTokenFailure };

export type FlowReissue =
  | { readonly ok: true; readonly flow: MediatorFlow; readonly terms: MediatorFlowTerms }
  | { readonly ok: false; readonly reason: Exclude<FlowTokenFailure, "expired"> };

function assertTerms(terms: MediatorFlowTerms): void {
  if (!StrKey.isValidEd25519PublicKey(terms.destination)) {
    throw new Error("startMediatorFlow: destination must be a valid Stellar public key (G...).");
  }
  if (!isMediatorNetworkId(terms.networkId)) {
    throw new Error("startMediatorFlow: network must be mainnet or testnet.");
  }
  if (decodeMemoCommitment(terms.memoXdr) === null) {
    throw new Error("startMediatorFlow: memo must be the base64 xdr of one Stellar memo.");
  }
}

function signToken(nonceHex: string, expiry: number, terms: MediatorFlowTerms): MediatorFlow {
  const body = [
    TOKEN_VERSION,
    nonceHex,
    String(expiry),
    terms.networkId,
    terms.destination,
    terms.memoXdr,
  ].join(".");
  const mac = hmac(`${TOKEN_MAC_LABEL}:${body}`).toString("hex");
  return {
    flowToken: `${body}.${mac}`,
    mediatorPublicKey: deriveFlowKeypair(nonceHex).publicKey(),
    expiresAt: expiry,
  };
}

// mint a fresh ephemeral mediator flow bound to `terms`
export function startMediatorFlow(
  terms: MediatorFlowTerms,
  now: number = Date.now(),
): MediatorFlow {
  assertTerms(terms);
  return signToken(randomBytes(16).toString("hex"), now + MEDIATOR_FLOW_TTL_MS, terms);
}

type VerifiedToken =
  | {
      readonly ok: true;
      readonly nonceHex: string;
      readonly expiry: number;
      readonly terms: MediatorFlowTerms;
    }
  | { readonly ok: false; readonly reason: "malformed" | "forged" };

// parse and authenticate a token without looking at its expiry. the hmac
// compare is constant-time.
function verifyToken(flowToken: unknown): VerifiedToken {
  if (typeof flowToken !== "string") return { ok: false, reason: "malformed" };
  const parts = flowToken.split(".");
  if (parts.length !== 7) return { ok: false, reason: "malformed" };
  const [version, nonceHex, expiryStr, networkId, destination, memoXdr, macHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== TOKEN_VERSION) return { ok: false, reason: "malformed" };
  if (!/^[0-9a-f]{32}$/u.test(nonceHex)) return { ok: false, reason: "malformed" };
  if (!/^[0-9]{1,16}$/u.test(expiryStr)) return { ok: false, reason: "malformed" };
  if (!/^[0-9a-f]{64}$/u.test(macHex)) return { ok: false, reason: "malformed" };

  const body = parts.slice(0, 6).join(".");
  const expectedMac = hmac(`${TOKEN_MAC_LABEL}:${body}`);
  const providedMac = Buffer.from(macHex, "hex");
  if (providedMac.length !== expectedMac.length || !timingSafeEqual(providedMac, expectedMac)) {
    return { ok: false, reason: "forged" };
  }

  // authentic from here on, but still refuse terms this build can't honour
  if (
    !isMediatorNetworkId(networkId) ||
    !StrKey.isValidEd25519PublicKey(destination) ||
    decodeMemoCommitment(memoXdr) === null
  ) {
    return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    nonceHex,
    expiry: Number(expiryStr),
    terms: { networkId, destination, memoXdr },
  };
}

// verify a flow token and return its ephemeral keypair and committed terms.
// "expired" is only reported for a token whose mac verifies, so the caller can
// point the client at the re-issue route.
export function resolveMediatorFlow(flowToken: unknown, now: number = Date.now()): FlowResolution {
  const verified = verifyToken(flowToken);
  if (!verified.ok) return verified;
  if (verified.expiry <= now) return { ok: false, reason: "expired" };
  return {
    ok: true,
    flow: {
      ...verified.terms,
      keypair: deriveFlowKeypair(verified.nonceHex),
      expiresAt: verified.expiry,
    },
  };
}

// renew an authentic token, expired or not, for the same nonce (so the same
// mediator) and the same terms. renewing can't widen what the token allows,
// because the co-signer still only signs a forward that meets those terms. the
// route checks the mediator exists on chain before handing the result out.
export function reissueMediatorFlow(flowToken: unknown, now: number = Date.now()): FlowReissue {
  const verified = verifyToken(flowToken);
  if (!verified.ok) return verified;
  return {
    ok: true,
    flow: signToken(verified.nonceHex, now + MEDIATOR_FLOW_TTL_MS, verified.terms),
    terms: verified.terms,
  };
}

// test-only: reset the cached master
export function __resetMediatorKeypairForTests(): void {
  cachedMaster = null;
}
