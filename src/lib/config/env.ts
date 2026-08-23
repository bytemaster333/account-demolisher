// public env vars. safe to import from client or server: only reads the
// NEXT_PUBLIC_* subset. server-only vars live in src/server/server-env.ts

import { z } from "zod";

const PublicEnvSchema = z.object({
  NEXT_PUBLIC_STELLAR_NETWORK: z.enum(["mainnet", "testnet", "futurenet"]).default("testnet"),
  NEXT_PUBLIC_DEPLOYMENT_MODE: z.enum(["reference", "self-hosted"]).default("reference"),
  // WalletConnect/Reown project id (a public client-side identifier). When unset,
  // the WalletConnect wallet is simply left out of the picker; no placeholder.
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v)),
});

export type PublicEnv = z.infer<typeof PublicEnvSchema>;

let cached: PublicEnv | null = null;

export function getPublicEnv(): PublicEnv {
  if (cached) return cached;
  const parsed = PublicEnvSchema.safeParse({
    NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
    NEXT_PUBLIC_DEPLOYMENT_MODE: process.env.NEXT_PUBLIC_DEPLOYMENT_MODE,
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
  });
  if (!parsed.success) {
    throw new Error(`Invalid public environment configuration: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}
