import "server-only";

import { z } from "zod";

// server-only env vars. each feature's variables are validated on their own, so
// a bad value for one (say a SOROSWAP_API_URL without a scheme) can't disable
// an unrelated feature (the mediator) the way a single combined schema did.

// empty-string values from .env are defined but unset in practice. coerce
// them to undefined so .optional() schemas don't trip the constraint checks
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const MediatorSecretSchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .startsWith("S", { message: "MEDIATOR_SECRET must be a Stellar seed" })
    .length(56, { message: "MEDIATOR_SECRET must be 56 characters" })
    .optional(),
);

const SoroswapSchema = z.object({
  SOROSWAP_API_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default("https://api.soroswap.finance"),
  ),
  SOROSWAP_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
});

export interface SoroswapConfig {
  readonly apiUrl: string;
  readonly apiKey: string | undefined;
}

// zod messages name the failing field and rule but never include the value, so
// they are safe to log
function invalid(name: string, error: z.ZodError): Error {
  return new Error(`Invalid server environment configuration for ${name}: ${error.message}`);
}

let mediatorSecret: { readonly value: string | undefined } | null = null;
let soroswap: SoroswapConfig | null = null;

// the mediator master seed, or undefined when unset. throws when it is set but
// malformed.
export function getMediatorSecret(): string | undefined {
  if (mediatorSecret !== null) return mediatorSecret.value;
  const parsed = MediatorSecretSchema.safeParse(process.env.MEDIATOR_SECRET);
  if (!parsed.success) throw invalid("MEDIATOR_SECRET", parsed.error);
  mediatorSecret = { value: parsed.data };
  return parsed.data;
}

export function getSoroswapConfig(): SoroswapConfig {
  if (soroswap !== null) return soroswap;
  const parsed = SoroswapSchema.safeParse({
    SOROSWAP_API_URL: process.env.SOROSWAP_API_URL,
    SOROSWAP_API_KEY: process.env.SOROSWAP_API_KEY,
  });
  if (!parsed.success) throw invalid("SOROSWAP_API_URL / SOROSWAP_API_KEY", parsed.error);
  soroswap = { apiUrl: parsed.data.SOROSWAP_API_URL, apiKey: parsed.data.SOROSWAP_API_KEY };
  return soroswap;
}

export interface ServerEnv {
  readonly MEDIATOR_SECRET: string | undefined;
  readonly SOROSWAP_API_URL: string;
  readonly SOROSWAP_API_KEY: string | undefined;
}

// a view over the getters above. each property validates only its own
// variable when read, so reading MEDIATOR_SECRET never fails because of a bad
// Soroswap setting and the other way round.
export function getServerEnv(): ServerEnv {
  return {
    get MEDIATOR_SECRET() {
      return getMediatorSecret();
    },
    get SOROSWAP_API_URL() {
      return getSoroswapConfig().apiUrl;
    },
    get SOROSWAP_API_KEY() {
      return getSoroswapConfig().apiKey;
    },
  };
}

// require a specific server-only var to be set. throws clearly when the
// deployment is misconfigured
export function requireServerEnv<K extends keyof ServerEnv>(key: K): NonNullable<ServerEnv[K]> {
  const value = getServerEnv()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Required server environment variable "${String(key)}" is not set.`);
  }
  return value as NonNullable<ServerEnv[K]>;
}

// test-only: forget cached values so a test can change the environment
export function __resetServerEnvForTests(): void {
  mediatorSecret = null;
  soroswap = null;
}
