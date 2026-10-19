// public env vars. safe to import from client or server: only reads the
// NEXT_PUBLIC_* subset. server-only vars live in src/server/server-env.ts

import { z } from "@/lib/zod";

import {
  parseMinMarketOutEnv,
  parseSlippageBpsEnv,
  SlippageConfigError,
} from "@/lib/safety/slippage";

// an unset docker build arg or compose ${VAR:-} arrives as "" rather than
// undefined; treat blank as unset so the default applies instead of failing
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const publishableLumeusKey = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v))
  .refine((v) => v === undefined || /^lum_pub_[A-Za-z0-9_]+$/.test(v), {
    message: "a lumeus key in the client bundle must be a publishable key (lum_pub_...)",
  });

const PublicEnvSchema = z.object({
  // testnet and mainnet are the only supported targets
  NEXT_PUBLIC_STELLAR_NETWORK: z.preprocess(
    blankToUndefined,
    z.enum(["mainnet", "testnet"]).default("testnet"),
  ),
  NEXT_PUBLIC_DEPLOYMENT_MODE: z.preprocess(
    blankToUndefined,
    z.enum(["reference", "self-hosted"]).default("reference"),
  ),
  // the walletconnect (reown) project id, a public client-side identifier. when
  // unset, walletconnect is left out of the picker. a github actions secret that
  // is not set arrives as "", so blank means "not configured" rather than a build
  // failure. there is no .min(1): it would run on "" before the transform maps
  // it to undefined.
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v)),
  // lumeus publishable keys (partner history index), one per network. they ship
  // in the client bundle, so only the publishable kind is accepted: a full or
  // read key would hand anyone who opens the page the workspace's own access.
  // unset or blank leaves the scans on the rpc alone.
  NEXT_PUBLIC_LUMEUS_TESTNET_KEY: publishableLumeusKey,
  NEXT_PUBLIC_LUMEUS_MAINNET_KEY: publishableLumeusKey,
  // unset or blank keeps the default; anything else must parse, so an operator
  // typo fails the config instead of quietly changing money-path protection
  NEXT_PUBLIC_SLIPPAGE_BPS: z
    .string()
    .optional()
    .superRefine((v, ctx) => slippageIssue(() => parseSlippageBpsEnv(v), ctx)),
  NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS: z
    .string()
    .optional()
    .superRefine((v, ctx) => slippageIssue(() => parseMinMarketOutEnv(v), ctx)),
});

function slippageIssue(parse: () => unknown, ctx: { addIssue: (message: string) => void }) {
  try {
    parse();
  } catch (e) {
    if (!(e instanceof SlippageConfigError)) throw e;
    ctx.addIssue(e.message);
  }
}

export type PublicEnv = z.infer<typeof PublicEnvSchema>;

let cached: PublicEnv | null = null;

export function getPublicEnv(): PublicEnv {
  if (cached) return cached;
  const parsed = PublicEnvSchema.safeParse({
    NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
    NEXT_PUBLIC_DEPLOYMENT_MODE: process.env.NEXT_PUBLIC_DEPLOYMENT_MODE,
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
    NEXT_PUBLIC_LUMEUS_TESTNET_KEY: process.env.NEXT_PUBLIC_LUMEUS_TESTNET_KEY,
    NEXT_PUBLIC_LUMEUS_MAINNET_KEY: process.env.NEXT_PUBLIC_LUMEUS_MAINNET_KEY,
    NEXT_PUBLIC_SLIPPAGE_BPS: process.env.NEXT_PUBLIC_SLIPPAGE_BPS,
    NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS: process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS,
  });
  if (!parsed.success) {
    throw new Error(`Invalid public environment configuration: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}
