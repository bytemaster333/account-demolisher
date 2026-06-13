import "server-only";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { getServerEnv } from "@/server/server-env";

// loads the mediator signing keypair from MEDIATOR_SECRET
let cachedKeypair: Keypair | null = null;

export function getMediatorKeypair(): Keypair {
  if (cachedKeypair !== null) return cachedKeypair;

  const env = getServerEnv();
  const seed = env.MEDIATOR_SECRET;

  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error(
      "MEDIATOR_SECRET is not set. The /api/mediator/sign route is unavailable until the deployment configures a mediator signing seed.",
    );
  }

  if (!StrKey.isValidEd25519SecretSeed(seed)) {
    throw new Error(
      "MEDIATOR_SECRET is malformed: not a valid Ed25519 secret seed (expected an S-prefixed Stellar seed of length 56).",
    );
  }

  cachedKeypair = Keypair.fromSecret(seed);
  return cachedKeypair;
}

// test-only: reset the cached keypair
export function __resetMediatorKeypairForTests(): void {
  cachedKeypair = null;
}
