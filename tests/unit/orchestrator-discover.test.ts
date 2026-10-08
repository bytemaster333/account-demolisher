import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, toPromise } from "xstate";
import { Asset } from "@stellar/stellar-sdk";

import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";

import { NETWORK, USDC_ISSUER, USDC_SAC, USER, XLM_SAC, makeAudit } from "./orchestrator-fixtures";

// the real discover actor. the audit, the scans, the token-instance read and the
// aquarius reward reads are the network leaves; which tokens an exit pays and
// which of them lack a trustline are worked out by the real helpers.
const auditAccount = vi.fn();
const getPositions = vi.fn();
const readWrappedAssets = vi.fn();
const getUserReward = vi.fn();
const readAquariusRewardToken = vi.fn();
const readAquariusPoolRewardTokens = vi.fn();
const readAquariusPoolAddress = vi.fn();
const readPositionGaugeRewards = vi.fn();
const scanAllowances = vi.fn();
const loadAccount = vi.fn();

vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({ loadAccount: (...a: unknown[]) => loadAccount(...a) }),
}));

vi.mock("@/lib/stellar/account-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/account-audit")>(
    "@/lib/stellar/account-audit",
  );
  return { ...actual, auditAccount: (...a: unknown[]) => auditAccount(...a) };
});
vi.mock("@/lib/soroban/rpc-client", () => ({
  getRpc: () => ({ getLatestLedger: async () => ({ sequence: 1000 }) }),
}));
vi.mock("@/lib/adapters/positions/direct", () => ({
  DirectContractProvider: class {
    getPositions(...a: unknown[]) {
      return getPositions(...a);
    }
  },
}));
vi.mock("@/lib/soroban/allowances", async () => {
  const actual = await vi.importActual<typeof import("@/lib/soroban/allowances")>(
    "@/lib/soroban/allowances",
  );
  return {
    ...actual,
    scanAllowances: (...a: unknown[]) => scanAllowances(...a),
    confirmAllowancesOnChain: async (_rpc: unknown, _user: unknown, records: unknown[]) =>
      records.map((r) => ({ ...(r as object), onChainAmount: (r as { amount: bigint }).amount })),
  };
});
vi.mock("@/lib/soroban/held-tokens", async () => {
  const actual = await vi.importActual<typeof import("@/lib/soroban/held-tokens")>(
    "@/lib/soroban/held-tokens",
  );
  return {
    ...actual,
    discoverHeldTokens: async () => ({ held: [], unreadable: [], incomplete: null }),
  };
});
vi.mock("@/lib/soroban/stellar-asset", async () => {
  const actual = await vi.importActual<typeof import("@/lib/soroban/stellar-asset")>(
    "@/lib/soroban/stellar-asset",
  );
  return { ...actual, readWrappedAssets: (...a: unknown[]) => readWrappedAssets(...a) };
});
vi.mock("@/lib/adapters/aquarius/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/adapters/aquarius/client")>(
    "@/lib/adapters/aquarius/client",
  );
  return {
    ...actual,
    getUserReward: (...a: unknown[]) => getUserReward(...a),
    readAquariusRewardToken: (...a: unknown[]) => readAquariusRewardToken(...a),
    readAquariusPoolRewardTokens: (...a: unknown[]) => readAquariusPoolRewardTokens(...a),
  };
});
vi.mock("@/lib/adapters/aquarius/gauges", async () => {
  const actual = await vi.importActual<typeof import("@/lib/adapters/aquarius/gauges")>(
    "@/lib/adapters/aquarius/gauges",
  );
  return {
    ...actual,
    readPositionGaugeRewards: (...a: unknown[]) => readPositionGaugeRewards(...a),
  };
});
vi.mock("@/lib/adapters/aquarius/pools", async () => {
  const actual = await vi.importActual<typeof import("@/lib/adapters/aquarius/pools")>(
    "@/lib/adapters/aquarius/pools",
  );
  return {
    ...actual,
    readAquariusPoolAddress: (...a: unknown[]) => readAquariusPoolAddress(...a),
  };
});

import { discoverActor } from "@/lib/orchestrator/actors/discover";
import { describeAllowanceOverflow } from "@/lib/soroban/allowances";

const AQUA_ISSUER = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const AQUA_SAC = new Asset("AQUA", AQUA_ISSUER).contractId(NETWORK.passphrase);
const AQUARIUS_POOL = "CCNXGPE4AQCSNEBZO3XJDKKDI3CRLYMVS6UWBBTVDLALLWMJEXBORQ2A";

const lpPosition = {
  ...EMPTY_POSITIONS,
  soroswap: [{ pair: { tokenA: USDC_SAC, tokenB: XLM_SAC }, shareBalance: 10n }],
};
const aquariusPosition = {
  ...EMPTY_POSITIONS,
  aquarius: [{ poolIndex: "ab".repeat(32), shareBalance: 5n, tokens: [XLM_SAC, USDC_SAC] }],
};
const usdcLine = {
  asset: { kind: "credit" as const, code: "USDC", issuer: USDC_ISSUER },
  amount: "0.0000000",
  buyingLiabilities: "0.0000000",
  sellingLiabilities: "0.0000000",
  limit: "1000.0000000",
  isAuthorized: true,
};

function discover() {
  return toPromise(
    createActor(discoverActor, { input: { publicKey: USER, network: NETWORK } }).start(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auditAccount.mockResolvedValue(makeAudit());
  scanAllowances.mockResolvedValue({ records: [], incomplete: null, overflow: [] });
  readWrappedAssets.mockResolvedValue(
    new Map([
      [USDC_SAC, { kind: "credit", code: "USDC", issuer: USDC_ISSUER, issuerAuthRequired: false }],
      [XLM_SAC, { kind: "native" }],
      [AQUA_SAC, { kind: "credit", code: "AQUA", issuer: AQUA_ISSUER, issuerAuthRequired: false }],
    ]),
  );
  getUserReward.mockResolvedValue(0n);
  readAquariusRewardToken.mockResolvedValue(AQUA_SAC);
  readAquariusPoolAddress.mockResolvedValue(AQUARIUS_POOL);
  readPositionGaugeRewards.mockResolvedValue([]);
  readAquariusPoolRewardTokens.mockImplementation(async (_s: unknown, pools: string[]) => {
    return new Map(pools.map((p) => [p, [AQUA_SAC]]));
  });
});

describe("discovery finds the trustlines a pool exit pays into", () => {
  it("reports a payout asset the account has no trustline for", async () => {
    getPositions.mockResolvedValue(lpPosition);
    const out = await discover();
    expect(readWrappedAssets).toHaveBeenCalledWith(
      expect.anything(),
      NETWORK,
      [USDC_SAC, XLM_SAC],
      USER,
    );
    expect(out.exitTrustlineGaps).toEqual([
      { contractId: USDC_SAC, code: "USDC", issuer: USDC_ISSUER, reason: "missing" },
    ]);
  });

  it("stops discovery when a payout token can't be read, rather than assume no gap", async () => {
    getPositions.mockResolvedValue(lpPosition);
    readWrappedAssets.mockRejectedValue(new Error("token contract instances not returned"));
    await expect(discover()).rejects.toThrow(
      /Could not check which trustlines your pool exits pay into \(token contract instances not returned\)/,
    );
  });

  it("reads nothing when no pool exit is planned", async () => {
    getPositions.mockResolvedValue(EMPTY_POSITIONS);
    const out = await discover();
    expect(readWrappedAssets).not.toHaveBeenCalled();
    expect(out.exitTrustlineGaps).toEqual([]);
    expect(out.aquariusRewardToken).toBeUndefined();
  });

  it("counts the aquarius reward token when a reward claim will pay some", async () => {
    // a pending reward claimed into a missing AQUA line traps with Error(Contract, #13)
    auditAccount.mockResolvedValue(makeAudit({ balances: [...makeAudit().balances, usdcLine] }));
    getPositions.mockResolvedValue(aquariusPosition);
    getUserReward.mockResolvedValue(768_599_147n);
    const out = await discover();
    expect(readWrappedAssets).toHaveBeenCalledWith(
      expect.anything(),
      NETWORK,
      [XLM_SAC, USDC_SAC, AQUA_SAC],
      USER,
    );
    expect(out.aquariusRewardToken).toBe(AQUA_SAC);
    expect(out.exitTrustlineGaps).toEqual([
      { contractId: AQUA_SAC, code: "AQUA", issuer: AQUA_ISSUER, reason: "missing" },
    ]);
  });

  it("stops discovery when a paying pool's own reward token is not the router's", async () => {
    auditAccount.mockResolvedValue(makeAudit({ balances: [...makeAudit().balances, usdcLine] }));
    getPositions.mockResolvedValue(aquariusPosition);
    getUserReward.mockResolvedValue(768_599_147n);
    readAquariusPoolRewardTokens.mockResolvedValue(new Map([[AQUARIUS_POOL, [USDC_SAC]]]));
    const err = await discover().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(
      new RegExp(`^Aquarius pool ${AQUARIUS_POOL} pays its rewards in ${USDC_SAC}`),
    );
    // the pool's own token is a fact on chain, so a retry can't change it
    expect(err?.message).not.toMatch(/Retry once the network is responsive/);
    expect(readWrappedAssets).not.toHaveBeenCalled();
  });

  it("leaves the reward token out when nothing is pending", async () => {
    auditAccount.mockResolvedValue(makeAudit({ balances: [...makeAudit().balances, usdcLine] }));
    getPositions.mockResolvedValue(aquariusPosition);
    const out = await discover();
    expect(readAquariusRewardToken).not.toHaveBeenCalled();
    expect(out.aquariusRewardToken).toBeUndefined();
    expect(out.exitTrustlineGaps).toEqual([]);
  });

  it("stops discovery when a pending reward can't be read", async () => {
    getPositions.mockResolvedValue(aquariusPosition);
    getUserReward.mockRejectedValue({ code: -32001, message: "processing limit" });
    await expect(discover()).rejects.toThrow(
      /Could not check which trustlines your pool exits pay into \(processing limit\)/,
    );
    expect(readWrappedAssets).not.toHaveBeenCalled();
  });
});

describe("discovery sets apart a payout line the close could not use", () => {
  // the issuer's state comes with the token read, so discovery asks nothing else
  const usdcIssuer = (issuerAuthRequired: boolean | null) =>
    readWrappedAssets.mockResolvedValue(
      new Map([
        [USDC_SAC, { kind: "credit", code: "USDC", issuer: USDC_ISSUER, issuerAuthRequired }],
        [XLM_SAC, { kind: "native" }],
      ]),
    );

  it("keeps a line whose issuer authorizes every new trustline out of the plan", async () => {
    getPositions.mockResolvedValue(lpPosition);
    usdcIssuer(true);
    const out = await discover();
    expect(out.exitTrustlineGaps).toEqual([]);
    expect(out.unopenableExitLines).toEqual([
      {
        contractId: USDC_SAC,
        code: "USDC",
        issuer: USDC_ISSUER,
        reason: "issuer_requires_authorization",
      },
    ]);
  });

  // a gone issuer is a fact about the asset, not a failed read, so the review
  // blocks on it instead of discovery asking for a retry
  it("keeps a line whose issuer account is gone out of the plan", async () => {
    getPositions.mockResolvedValue(lpPosition);
    usdcIssuer(null);
    const out = await discover();
    expect(out.exitTrustlineGaps).toEqual([]);
    expect(out.unopenableExitLines).toEqual([
      { contractId: USDC_SAC, code: "USDC", issuer: USDC_ISSUER, reason: "issuer_missing" },
    ]);
    expect(loadAccount).not.toHaveBeenCalled();
  });

  it("plans a line whose issuer lets anyone hold the asset", async () => {
    getPositions.mockResolvedValue(lpPosition);
    usdcIssuer(false);
    const out = await discover();
    expect(out.exitTrustlineGaps).toEqual([
      { contractId: USDC_SAC, code: "USDC", issuer: USDC_ISSUER, reason: "missing" },
    ]);
    expect(out.unopenableExitLines).toEqual([]);
  });

  it("keeps an unauthorized line the account already has with the plan's gaps", async () => {
    auditAccount.mockResolvedValue(
      makeAudit({ balances: [...makeAudit().balances, { ...usdcLine, isAuthorized: false }] }),
    );
    getPositions.mockResolvedValue(lpPosition);
    usdcIssuer(true);
    const out = await discover();
    expect(out.exitTrustlineGaps).toEqual([
      { contractId: USDC_SAC, code: "USDC", issuer: USDC_ISSUER, reason: "unauthorized" },
    ]);
    expect(out.unopenableExitLines).toEqual([]);
  });
});

describe("discovery says when a token's approvals were cut", () => {
  it("warns with the cut contracts and keeps the rows it found", async () => {
    getPositions.mockResolvedValue(EMPTY_POSITIONS);
    const record = {
      contractId: USDC_SAC,
      spender: XLM_SAC,
      amount: 5n,
      live_until_ledger: 5000,
      lastSeenLedger: 900,
      expired: false,
    };
    const overflow = [{ contractId: USDC_SAC, spenders: 31, kept: 20 }];
    scanAllowances.mockResolvedValue({ records: [record], incomplete: null, overflow });
    const out = await discover();
    expect(out.allowances).toHaveLength(1);
    expect(out.discoveryWarnings.join(" ")).toContain(describeAllowanceOverflow(overflow));
    expect(out.discoveryDiagnostics.join(" ")).toContain(
      `allowance overflow: ${USDC_SAC} 31 spenders, 20 kept`,
    );
  });

  it("puts the cut and an unfinished scan in one warning", async () => {
    getPositions.mockResolvedValue(EMPTY_POSITIONS);
    const overflow = [{ contractId: USDC_SAC, spenders: 25, kept: 20 }];
    scanAllowances.mockResolvedValue({
      records: [],
      incomplete: {
        reason: "budget",
        rangeStartLedger: 1,
        coveredFromLedger: 500,
        lastLedger: 1000,
        detail: "stopped at the time budget",
      },
      overflow,
    });
    const out = await discover();
    const allowanceWarnings = out.discoveryWarnings.filter((w) => w.includes("permission"));
    expect(allowanceWarnings).toHaveLength(1);
    expect(allowanceWarnings[0]).toContain(describeAllowanceOverflow(overflow));
  });
});

describe("discovery reads the aquarius gauge rewards the close claims", () => {
  const owed = {
    poolAddress: AQUARIUS_POOL,
    tokens: [XLM_SAC, USDC_SAC],
    poolIndex: "ab".repeat(32),
    rewards: [{ token: XLM_SAC, amount: 1_126_439_834n }],
  };

  it("hands the plan the pools whose gauges owe this account", async () => {
    auditAccount.mockResolvedValue(makeAudit({ balances: [...makeAudit().balances, usdcLine] }));
    getPositions.mockResolvedValue(aquariusPosition);
    readPositionGaugeRewards.mockResolvedValue([owed]);
    const out = await discover();
    expect(readPositionGaugeRewards).toHaveBeenCalledWith(
      expect.anything(),
      NETWORK,
      USER,
      aquariusPosition,
    );
    expect(out.aquariusGaugeRewards).toEqual([owed]);
    // the claim is planned, so nothing warns that the rewards are left behind
    expect(out.discoveryWarnings.join(" ")).not.toMatch(/gauge/i);
  });

  it("checks the trustline of a gauge reward token like any other payout", async () => {
    // a gauge paying AQUA into an account with no AQUA line traps like an exit
    auditAccount.mockResolvedValue(makeAudit({ balances: [...makeAudit().balances, usdcLine] }));
    getPositions.mockResolvedValue(aquariusPosition);
    readPositionGaugeRewards.mockResolvedValue([
      { ...owed, rewards: [{ token: AQUA_SAC, amount: 5n }] },
    ]);
    const out = await discover();
    expect(readWrappedAssets).toHaveBeenCalledWith(
      expect.anything(),
      NETWORK,
      [XLM_SAC, USDC_SAC, AQUA_SAC],
      USER,
    );
    expect(out.exitTrustlineGaps).toEqual([
      { contractId: AQUA_SAC, code: "AQUA", issuer: AQUA_ISSUER, reason: "missing" },
    ]);
  });

  it("returns no gauge rewards when no gauge owes anything", async () => {
    auditAccount.mockResolvedValue(makeAudit({ balances: [...makeAudit().balances, usdcLine] }));
    getPositions.mockResolvedValue(aquariusPosition);
    const out = await discover();
    expect(out.aquariusGaugeRewards).toEqual([]);
  });

  it("does not read gauges without an aquarius position", async () => {
    getPositions.mockResolvedValue(lpPosition);
    const out = await discover();
    expect(readPositionGaugeRewards).not.toHaveBeenCalled();
    expect(out.aquariusGaugeRewards).toEqual([]);
  });

  it("stops with the reason when the gauge read fails, rather than plan without them", async () => {
    auditAccount.mockResolvedValue(makeAudit({ balances: [...makeAudit().balances, usdcLine] }));
    getPositions.mockResolvedValue(aquariusPosition);
    readPositionGaugeRewards.mockRejectedValue({ code: -32001, message: "processing limit" });
    await expect(discover()).rejects.toThrow(
      "Could not read the Aquarius gauge rewards owed to this account (processing limit). " +
        "Nothing was planned, so none of them are left behind. Retry once the network is " +
        "responsive.",
    );
  });
});
