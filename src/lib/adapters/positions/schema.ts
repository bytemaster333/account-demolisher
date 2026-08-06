// Zod schema validation for discovery-provider outputs.
//
// Every position-discovery source (the direct on-chain reader today; a future API
// provider behind the same interface) is validated against these schemas before
// its positions enter the plan. That gives the provider layer a single, strict,
// schema-validated boundary: a malformed balance (negative, non-integer), a
// bad contract/pool id, or a wrong-shaped record is REJECTED rather than silently
// carried into a close where it could mis-price a conversion or hide a position.
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";

import type {
  AquariusPositionSummary,
  BlendBackstopSummary,
  BlendPositionSummary,
  FxDAOPositionSummary,
  SoroswapPositionSummary,
} from "./interface";

// a Soroban contract id (C…). Asset ids and pool/token contracts are all C-strkeys.
const contractId = z.string().refine((s) => StrKey.isValidContract(s), {
  message: "expected a valid Soroban contract id (C…)",
});

// balances are non-negative integers in smallest units (bigint, never floats)
const nonNegBigInt = z.bigint().nonnegative();

// a balance map: asset-id (contract id) -> non-negative bigint amount
const balanceMap = z.map(contractId, nonNegBigInt);

// u32 reserve-token ids
const reserveTokenId = z.number().int().nonnegative().max(0xffffffff);

export const blendPositionSchema: z.ZodType<BlendPositionSummary> = z.object({
  poolId: contractId,
  liabilities: balanceMap,
  collateral: balanceMap,
  supply: balanceMap,
  emissionReserveTokenIds: z.array(reserveTokenId),
});

export const blendBackstopSchema: z.ZodType<BlendBackstopSummary> = z.object({
  poolId: contractId,
  shares: nonNegBigInt,
  queuedForWithdrawal: nonNegBigInt,
});

export const aquariusPositionSchema: z.ZodType<AquariusPositionSummary> = z.object({
  // 32-byte pool index, hex-encoded (64 hex chars, optional 0x prefix) — matches
  // poolIndexHexToBytes's accepted form so validation never rejects a real index
  poolIndex: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/u, "expected a 32-byte hex pool index"),
  shareBalance: nonNegBigInt,
  tokens: z.array(contractId),
});

export const soroswapPositionSchema: z.ZodType<SoroswapPositionSummary> = z.object({
  pair: z.object({ tokenA: contractId, tokenB: contractId }),
  shareBalance: nonNegBigInt,
});

export const fxdaoPositionSchema: z.ZodType<FxDAOPositionSummary> = z.object({
  denomination: z.string().min(1),
  debt: nonNegBigInt,
  collateral: nonNegBigInt,
});

// Parse an array of provider records with a per-item schema. Throws z.ZodError on
// the first invalid record (fail-closed: the caller turns that into a per-protocol
// discovery error, which blocks a clean close rather than merging around it).
export function parsePositions<T>(schema: z.ZodType<T>, raw: readonly unknown[]): T[] {
  return raw.map((r) => schema.parse(r));
}
