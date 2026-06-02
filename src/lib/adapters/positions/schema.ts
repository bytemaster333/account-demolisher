/**
 * zod schemas for the JSON wire shape orion/octopos are expected to publish.
 * numeric balances arrive as decimal strings (bigints don't survive JSON.stringify);
 * coerced via z.coerce.bigint. strict() so adapter tests fail loudly on drift.
 */

import { z } from "zod";

import type { ProtocolPositions } from "./interface";

// decimal-string → bigint coercion, non-negative
const BalanceSchema = z.coerce
  .bigint()
  .refine((v) => v >= 0n, { message: "balance must be non-negative" });

// Record<string, bigint> on the wire, decoded into a ReadonlyMap
const BalanceMapSchema = z
  .record(z.string().min(1), BalanceSchema)
  .transform((rec) => new Map<string, bigint>(Object.entries(rec)) as ReadonlyMap<string, bigint>);

export const BlendPositionSummarySchema = z
  .object({
    poolId: z.string().min(1),
    liabilities: BalanceMapSchema,
    collateral: BalanceMapSchema,
    supply: BalanceMapSchema,
  })
  .strict();

export const AquariusPositionSummarySchema = z
  .object({
    poolIndex: z.string().min(1),
    shareBalance: BalanceSchema,
    tokens: z.array(z.string().min(1)).readonly(),
  })
  .strict();

export const SoroswapPositionSummarySchema = z
  .object({
    pair: z
      .object({
        tokenA: z.string().min(1),
        tokenB: z.string().min(1),
      })
      .strict(),
    shareBalance: BalanceSchema,
  })
  .strict();

export const FxDAOPositionSummarySchema = z
  .object({
    denomination: z.string().min(1),
    debt: BalanceSchema,
    collateral: BalanceSchema,
  })
  .strict();

export const ProtocolErrorSchema = z
  .object({
    protocol: z.string().min(1),
    message: z.string(),
  })
  .strict();

// top-level wire schema. every field required so upstream can't elide protocols silently.
export const ProtocolPositionsSchema = z
  .object({
    blend: z.array(BlendPositionSummarySchema),
    aquarius: z.array(AquariusPositionSummarySchema),
    soroswap: z.array(SoroswapPositionSummarySchema),
    fxdao: z.array(FxDAOPositionSummarySchema),
    errors: z.array(ProtocolErrorSchema),
  })
  .strict();

// decode an unknown into ProtocolPositions. caller wraps the error branch into ProviderSchemaMismatch.
export function parseProtocolPositions(
  raw: unknown,
): { ok: true; value: ProtocolPositions } | { ok: false; issues: string } {
  const result = ProtocolPositionsSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, value: result.data as ProtocolPositions };
  }
  const issues = result.error.issues
    .map((iss) => `${iss.path.join(".") || "<root>"}: ${iss.message}`)
    .join("; ");
  return { ok: false, issues };
}
