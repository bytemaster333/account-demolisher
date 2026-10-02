// shared fixtures for the demolish page tests: a minimal account audit and
// plan trees built by the real generator, so the page helpers see the same node
// shapes and batches the preview produces.

import { Keypair } from "@stellar/stellar-sdk";

import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
import { generatePlan, type GeneratePlanOptions } from "@/lib/plan/generator";
import type { PlanTree } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";

export const ACC = Keypair.random().publicKey();
export const DEST = Keypair.random().publicKey();

export const POOL_ID = "pool0000000000000000000000000000000000000000000000000000000000aa";
export const ASSET_A = "casset0000000000000000000000000000000000000000000000000000000001";
export const TOKEN_C = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export function makeAudit(over: Partial<AccountAudit> = {}): AccountAudit {
  return {
    accountId: ACC,
    sequence: "1",
    subentryCount: 0,
    thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
    flags: {
      authImmutable: false,
      authRequired: false,
      authRevocable: false,
      authClawbackEnabled: false,
    },
    balances: [
      {
        asset: { kind: "native" },
        amount: "100.0000000",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ],
    signers: [{ key: ACC, type: "ed25519_public_key", weight: 1 }],
    offers: [],
    data: [],
    claimableBalances: [],
    poolShares: [],
    sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
    requiresMultisig: false,
    mergeability: { mergeable: true },
    ...over,
  };
}

export function emptyPositions(over: Partial<ProtocolPositions> = {}): ProtocolPositions {
  return {
    blend: [],
    backstop: [],
    aquarius: [],
    soroswap: [],
    fxdao: [],
    errors: [],
    ...over,
  };
}

export function blendPositions(): ProtocolPositions {
  return emptyPositions({
    blend: [
      {
        poolId: POOL_ID,
        liabilities: new Map([[ASSET_A, 100n]]),
        collateral: new Map([[ASSET_A, 200n]]),
        supply: new Map(),
        emissionReserveTokenIds: [],
      },
    ],
  });
}

export function makeTree(
  over: {
    readonly audit?: AccountAudit;
    readonly positions?: ProtocolPositions;
    readonly opts?: GeneratePlanOptions;
  } = {},
): PlanTree {
  return generatePlan(
    over.audit ?? makeAudit(),
    over.positions ?? emptyPositions(),
    [],
    DEST,
    over.opts ?? {},
  );
}
