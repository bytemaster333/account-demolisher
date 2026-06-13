import "server-only";

import { z } from "zod";

// server-only env vars

// empty-string values from .env are defined but unset in practice. coerce
// them to undefined so .optional() schemas don't trip the constraint checks
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const ServerEnvSchema = z.object({
  MEDIATOR_SECRET: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .startsWith("S", { message: "MEDIATOR_SECRET must be a Stellar seed" })
      .length(56)
      .optional(),
  ),
  ORION_API_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  ORION_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  OCTOPOS_API_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  OCTOPOS_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SOROSWAP_API_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default("https://api.soroswap.finance"),
  ),
  SOROSWAP_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = ServerEnvSchema.safeParse({
    MEDIATOR_SECRET: process.env.MEDIATOR_SECRET,
    ORION_API_URL: process.env.ORION_API_URL,
    ORION_API_KEY: process.env.ORION_API_KEY,
    OCTOPOS_API_URL: process.env.OCTOPOS_API_URL,
    OCTOPOS_API_KEY: process.env.OCTOPOS_API_KEY,
    SOROSWAP_API_URL: process.env.SOROSWAP_API_URL,
    SOROSWAP_API_KEY: process.env.SOROSWAP_API_KEY,
  });
  if (!parsed.success) {
    throw new Error(`Invalid server environment configuration: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
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
