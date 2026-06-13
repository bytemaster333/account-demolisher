// public env vars. safe to import from client or server — only reads the
// NEXT_PUBLIC_* subset. server-only vars live in src/server/server-env.ts

import { z } from "zod";

const PublicEnvSchema = z.object({
  NEXT_PUBLIC_STELLAR_NETWORK: z.enum(["mainnet", "testnet", "futurenet"]).default("testnet"),
  NEXT_PUBLIC_HORIZON_URL: z.string().url().optional(),
  NEXT_PUBLIC_RPC_URL: z.string().url().optional(),
  NEXT_PUBLIC_DEPLOYMENT_MODE: z.enum(["reference", "self-hosted"]).default("reference"),
  NEXT_PUBLIC_REFRACTOR_URL: z.string().url().default("https://api.refractor.space"),
});

export type PublicEnv = z.infer<typeof PublicEnvSchema>;

let cached: PublicEnv | null = null;

export function getPublicEnv(): PublicEnv {
  if (cached) return cached;
  const parsed = PublicEnvSchema.safeParse({
    NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
    NEXT_PUBLIC_HORIZON_URL: process.env.NEXT_PUBLIC_HORIZON_URL,
    NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
    NEXT_PUBLIC_DEPLOYMENT_MODE: process.env.NEXT_PUBLIC_DEPLOYMENT_MODE,
    NEXT_PUBLIC_REFRACTOR_URL: process.env.NEXT_PUBLIC_REFRACTOR_URL,
  });
  if (!parsed.success) {
    throw new Error(`Invalid public environment configuration: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}
