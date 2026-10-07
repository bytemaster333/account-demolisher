import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, toPromise } from "xstate";

import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";

import { NETWORK, USDC_ISSUER, USDC_SAC, USER, XLM_SAC, makeAudit } from "./orchestrator-fixtures";

// the real discover actor. the audit, the scans and the token-instance read are
// the network leaves; which tokens an exit pays and which of them lack a
// trustline are worked out by the real helpers.
const auditAccount = vi.fn();
const getPositions = vi.fn();
const readWrappedAssets = vi.fn();

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
    scanAllowances: async () => ({ records: [], incomplete: null }),
    confirmAllowancesOnChain: async () => [],
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

import { discoverActor } from "@/lib/orchestrator/actors/discover";

const lpPosition = {
  ...EMPTY_POSITIONS,
  soroswap: [{ pair: { tokenA: USDC_SAC, tokenB: XLM_SAC }, shareBalance: 10n }],
};

function discover() {
  return toPromise(
    createActor(discoverActor, { input: { publicKey: USER, network: NETWORK } }).start(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auditAccount.mockResolvedValue(makeAudit());
  readWrappedAssets.mockResolvedValue(
    new Map([
      [USDC_SAC, { kind: "credit", code: "USDC", issuer: USDC_ISSUER }],
      [XLM_SAC, { kind: "native" }],
    ]),
  );
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
  });
});
