// zod schema validation for discovery-provider outputs.
//
// every position-discovery source (the direct on-chain reader today; a future API
// provider behind the same interface) is validated against these schemas before
// its positions enter the plan. That gives the provider layer a single, strict,
// schema-validated boundary: a malformed balance (negative, non-integer), a
// bad contract/pool id, or a wrong-shaped record is REJECTED rather than silently
// carried into a close where it could mis-price a conversion or hide a position.
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";

import type {
  AquariusConcentratedPositionSummary,
  AquariusPositionSummary,
  BlendBackstopSummary,
  BlendBackstopUnclaimedEmissions,
  BlendPositionSummary,
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
  backstopId: contractId.exactOptional(),
  unlockedQueuedForWithdrawal: nonNegBigInt.exactOptional(),
  accruedEmissions: nonNegBigInt.exactOptional(),
  queueDurationSeconds: z.number().int().positive().exactOptional(),
});

export const blendBackstopUnclaimedSchema: z.ZodType<BlendBackstopUnclaimedEmissions> = z.object({
  poolId: contractId,
  backstopId: contractId,
  accruedEmissions: z.bigint().positive(),
});

// 32-byte pool index, hex-encoded (64 hex chars, optional 0x prefix). matches
// poolIndexHexToBytes's accepted form so validation never rejects a real index
const poolIndex = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/u, "expected a 32-byte hex pool index");

export const aquariusPositionSchema: z.ZodType<AquariusPositionSummary> = z.object({
  poolIndex,
  shareBalance: nonNegBigInt,
  tokens: z.array(contractId),
});

// ticks are i32 on chain
const tick = z.number().int().min(-0x80000000).max(0x7fffffff);

export const aquariusConcentratedPositionSchema: z.ZodType<AquariusConcentratedPositionSummary> = z
  .object({
    poolAddress: contractId,
    poolIndex,
    tokens: z.array(contractId).min(2),
    ranges: z.array(
      z
        .object({ tickLower: tick, tickUpper: tick, liquidity: z.bigint().positive() })
        .refine((r) => r.tickLower < r.tickUpper, { message: "tickLower must be below tickUpper" }),
    ),
    pendingFees: z.array(nonNegBigInt),
    pendingReward: nonNegBigInt,
  })
  .refine((p) => p.pendingFees.length === p.tokens.length, {
    message: "expected one pending fee per pool token",
  })
  .refine((p) => p.ranges.length > 0 || p.pendingReward > 0n || p.pendingFees.some((f) => f > 0n), {
    message: "a concentrated position with no liquidity, fees or reward is not a position",
  });

export const soroswapPositionSchema: z.ZodType<SoroswapPositionSummary> = z.object({
  pair: z.object({ tokenA: contractId, tokenB: contractId }),
  shareBalance: nonNegBigInt,
});

// parse an array of provider records with a per-item schema. Throws z.ZodError on
// the first invalid record (fail-closed: the caller turns that into a per-protocol
// discovery error, which blocks a clean close rather than merging around it).
export function parsePositions<T>(schema: z.ZodType<T>, raw: readonly unknown[]): T[] {
  return raw.map((r) => schema.parse(r));
}
