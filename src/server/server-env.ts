import "server-only";

import { z } from "zod";

// server-only env vars. importing this from a client component triggers a
// build-time error via `server-only`. validator runs lazily on first
// access so the module is cheap to import at build time.
const ServerEnvSchema = z.object({
  MEDIATOR_SECRET: z
    .string()
    .startsWith("S", { message: "MEDIATOR_SECRET must be a Stellar seed" })
    .length(56)
    .optional(),
  ORION_API_URL: z.string().url().optional(),
  ORION_API_KEY: z.string().optional(),
  OCTOPOS_API_URL: z.string().url().optional(),
  OCTOPOS_API_KEY: z.string().optional(),
  SOROSWAP_API_URL: z.string().url().default("https://api.soroswap.finance"),
  SOROSWAP_API_KEY: z.string().optional(),
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
// deployment is misconfigured.
export function requireServerEnv<K extends keyof ServerEnv>(key: K): NonNullable<ServerEnv[K]> {
  const value = getServerEnv()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Required server environment variable "${String(key)}" is not set.`);
  }
  return value as NonNullable<ServerEnv[K]>;
}
