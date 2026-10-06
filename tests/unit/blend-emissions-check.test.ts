import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { blndTokenForNetwork } from "@/lib/adapters/blend/constants";
import { blndTrustlineRequirement } from "@/lib/adapters/blend/emissions-check";
import type { BlendPositionSummary } from "@/lib/adapters/positions/interface";
import { MAINNET, TESTNET } from "@/lib/config/networks";
import type { AccountAudit, AuditBalance } from "@/lib/types/account";

const BLND = blndTokenForNetwork(MAINNET);
const POOL_A = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const POOL_B = "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";

function auditWith(balances: readonly Partial<AuditBalance>[]): AccountAudit {
  return {
    balances: balances.map((b) => ({
      asset: { kind: "native" },
      amount: "0",
      buyingLiabilities: "0",
      sellingLiabilities: "0",
      ...b,
    })),
  } as unknown as AccountAudit;
}

function pool(poolId: string, emissionReserveTokenIds: readonly number[]): BlendPositionSummary {
  return {
    poolId,
    liabilities: new Map(),
    collateral: new Map(),
    supply: new Map(),
    emissionReserveTokenIds,
  };
}

const blndLine = (extra: Partial<AuditBalance> = {}): Partial<AuditBalance> => ({
  asset: { kind: "credit", code: "BLND", issuer: BLND.issuer },
  amount: "0.0000000",
  ...extra,
});

describe("blndTrustlineRequirement (M-26)", () => {
  it("asks for the BLND trustline when a pool has emissions to claim and the account has none", () => {
    const req = blndTrustlineRequirement(
      auditWith([{ amount: "100.0000000" }]),
      [pool(POOL_A, [1]), pool(POOL_B, []), pool(POOL_B, [3])],
      MAINNET,
    );
    expect(req).toEqual({
      reason: "missing",
      code: "BLND",
      issuer: BLND.issuer,
      contractId: BLND.contractId,
      poolIds: [POOL_A, POOL_B],
    });
  });

  it("needs nothing when the account already holds an authorized BLND trustline", () => {
    expect(blndTrustlineRequirement(auditWith([blndLine()]), [pool(POOL_A, [1])], MAINNET)).toBe(
      null,
    );
  });

  it("needs nothing when no pool has emissions to claim", () => {
    expect(blndTrustlineRequirement(auditWith([]), [pool(POOL_A, [])], MAINNET)).toBe(null);
  });

  it("does not accept a BLND code from another issuer", () => {
    const fake = Keypair.random().publicKey();
    const req = blndTrustlineRequirement(
      auditWith([blndLine({ asset: { kind: "credit", code: "BLND", issuer: fake } })]),
      [pool(POOL_A, [1])],
      MAINNET,
    );
    expect(req?.issuer).toBe(BLND.issuer);
  });

  it("treats a trustline the issuer has not authorized as unusable", () => {
    const req = blndTrustlineRequirement(
      auditWith([blndLine({ isAuthorized: false })]),
      [pool(POOL_A, [1])],
      MAINNET,
    );
    expect(req?.reason).toBe("unauthorized");
  });

  it("uses the network's own BLND asset", () => {
    const testnetBlnd = blndTokenForNetwork(TESTNET);
    const req = blndTrustlineRequirement(auditWith([]), [pool(POOL_A, [1])], TESTNET);
    expect(req?.issuer).toBe(testnetBlnd.issuer);
    expect(req?.contractId).toBe(testnetBlnd.contractId);
  });
});
