import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { blendRepayShortfallWarnings } from "@/lib/adapters/blend/repay-check";
import type { BlendPositionSummary } from "@/lib/adapters/positions/interface";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AccountAudit, AuditBalance } from "@/lib/types/account";

const NETWORK = { passphrase: Networks.TESTNET } as unknown as NetworkConfig;
const ISSUER = Keypair.random().publicKey();

// the SAC contract id a Blend reserve keys a USDC liability under
const USDC_SAC = new Asset("USDC", ISSUER).contractId(Networks.TESTNET);
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);

function auditWith(
  balances: readonly Partial<AuditBalance>[],
  reserve: { subentryCount?: number; numSponsoring?: number; numSponsored?: number } = {},
): AccountAudit {
  return {
    balances: balances.map((b) => ({
      amount: "0",
      buyingLiabilities: "0",
      sellingLiabilities: "0",
      ...b,
    })),
    subentryCount: reserve.subentryCount ?? 0,
    sponsorship: {
      numSponsoring: reserve.numSponsoring ?? 0,
      numSponsored: reserve.numSponsored ?? 0,
      coverable: 0,
    },
  } as unknown as AccountAudit;
}

function pool(liabilities: ReadonlyMap<string, bigint>): BlendPositionSummary {
  return {
    poolId: "CBLENDPOOL",
    liabilities,
    collateral: new Map(),
    supply: new Map(),
    emissionReserveTokenIds: [],
  };
}

describe("blendRepayShortfallWarnings", () => {
  it("warns when a borrowed token isn't held in sufficient amount", () => {
    const audit = auditWith([
      { asset: { kind: "credit", code: "USDC", issuer: ISSUER }, amount: "50" },
    ]);
    const positions = [pool(new Map([[USDC_SAC, 100_0000000n]]))]; // owe 100, hold 50
    const warnings = blendRepayShortfallWarnings(audit, positions, NETWORK);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Blend loan/);
  });

  it("does not warn when the account holds enough of the borrowed token", () => {
    const audit = auditWith([
      { asset: { kind: "credit", code: "USDC", issuer: ISSUER }, amount: "150" },
    ]);
    const positions = [pool(new Map([[USDC_SAC, 100_0000000n]]))]; // owe 100, hold 150
    expect(blendRepayShortfallWarnings(audit, positions, NETWORK)).toEqual([]);
  });

  it("treats holding exactly the owed amount as sufficient", () => {
    const audit = auditWith([
      { asset: { kind: "credit", code: "USDC", issuer: ISSUER }, amount: "100" },
    ]);
    const positions = [pool(new Map([[USDC_SAC, 100_0000000n]]))];
    expect(blendRepayShortfallWarnings(audit, positions, NETWORK)).toEqual([]);
  });

  it("matches native XLM liabilities against the native SAC id", () => {
    const audit = auditWith([{ asset: { kind: "native" }, amount: "5" }]);
    const positions = [pool(new Map([[XLM_SAC, 10_0000000n]]))]; // owe 10 XLM, hold 5
    expect(blendRepayShortfallWarnings(audit, positions, NETWORK)).toHaveLength(1);
  });

  it("emits a single warning even when several liabilities are short", () => {
    const audit = auditWith([]); // holds nothing
    const positions = [
      pool(
        new Map([
          [USDC_SAC, 100_0000000n],
          [XLM_SAC, 10_0000000n],
        ]),
      ),
    ];
    expect(blendRepayShortfallWarnings(audit, positions, NETWORK)).toHaveLength(1);
  });

  it("ignores zero-amount liabilities", () => {
    const audit = auditWith([]);
    const positions = [pool(new Map([[USDC_SAC, 0n]]))];
    expect(blendRepayShortfallWarnings(audit, positions, NETWORK)).toEqual([]);
  });

  it("returns nothing when there are no Blend positions", () => {
    expect(blendRepayShortfallWarnings(auditWith([]), [], NETWORK)).toEqual([]);
  });
});

// liabilities arrive in underlying units (discovery converts dTokens with the
// reserve's dRate), so these compare debt against what can actually be spent
describe("blendRepayShortfallWarnings counts what can really be repaid (M-27)", () => {
  it("sums the same borrowed asset across pools before comparing", () => {
    const audit = auditWith([
      { asset: { kind: "credit", code: "USDC", issuer: ISSUER }, amount: "100" },
    ]);
    // 60 owed in each of two pools, 100 held: each loan alone fits, both do not
    const positions = [
      pool(new Map([[USDC_SAC, 60_0000000n]])),
      pool(new Map([[USDC_SAC, 60_0000000n]])),
    ];
    expect(blendRepayShortfallWarnings(audit, positions, NETWORK)).toHaveLength(1);
  });

  it("does not count a balance locked in open offers", () => {
    const audit = auditWith([
      {
        asset: { kind: "credit", code: "USDC", issuer: ISSUER },
        amount: "100",
        sellingLiabilities: "50",
      },
    ]);
    expect(
      blendRepayShortfallWarnings(audit, [pool(new Map([[USDC_SAC, 60_0000000n]]))], NETWORK),
    ).toHaveLength(1);
  });

  it("does not count the XLM held back as the account's minimum reserve", () => {
    // 11 XLM held, 2 subentries: 2 XLM is reserve and cannot repay a 10 XLM loan
    const audit = auditWith([{ asset: { kind: "native" }, amount: "11" }], { subentryCount: 2 });
    expect(
      blendRepayShortfallWarnings(audit, [pool(new Map([[XLM_SAC, 10_0000000n]]))], NETWORK),
    ).toHaveLength(1);
  });

  it("accepts an XLM loan that fits above the reserve and fee allowance", () => {
    const audit = auditWith([{ asset: { kind: "native" }, amount: "20" }], { subentryCount: 2 });
    expect(
      blendRepayShortfallWarnings(audit, [pool(new Map([[XLM_SAC, 10_0000000n]]))], NETWORK),
    ).toEqual([]);
  });
});
