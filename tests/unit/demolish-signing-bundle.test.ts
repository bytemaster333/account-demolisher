import { describe, it, expect } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  TransactionBuilder,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { PlanTree } from "@/lib/plan/tree";
import type { ClaimableBalanceEntry } from "@/lib/types/account";

import {
  assessSigningRequest,
  buildReviewedBundle,
  claimsAtRiskInWindow,
  hasClassicPoolShares,
  reprobeBeforePublish,
} from "@/app/demolish/_lib/signing-bundle";

import {
  ACC,
  DEST,
  POOL_ID,
  TOKEN_C,
  blendPositions,
  emptyPositions,
  makeAudit,
  makeTree,
} from "./demolish-fixtures";

// claimable balance ids are a 4-byte type prefix plus a 32-byte hash, in hex
const CB_KEEP = `00000000${"a1".repeat(32)}`;
const CB_DROP = `00000000${"b2".repeat(32)}`;

function source(): Horizon.AccountResponse {
  // TransactionBuilder only reads accountId()/sequenceNumber(); a real Account
  // stands in for the Horizon response
  return new Account(ACC, "4100") as unknown as Horizon.AccountResponse;
}

function gate(over: Partial<Parameters<typeof assessSigningRequest>[0]> = {}) {
  return assessSigningRequest({
    positions: emptyPositions(),
    allowanceCount: 0,
    useMediator: false,
    heldTokensSelected: 0,
    hasClassicPoolShares: false,
    tree: makeTree(),
    deterministic: true,
    ...over,
  });
}

function cb(id: string, over: Partial<ClaimableBalanceEntry> = {}): ClaimableBalanceEntry {
  return {
    id,
    asset: { kind: "native" },
    amount: "5.0000000",
    sponsor: Keypair.random().publicKey(),
    predicate: [{ destination: ACC, predicate: { unconditional: true } }],
    claimants: [ACC],
    claimableNow: true,
    ...over,
  };
}

describe("signing-request gate covers what discovery found (C-08)", () => {
  it("allows a classic-only plan", () => {
    expect(gate().ok).toBe(true);
  });

  it("refuses a fully queued backstop, which produces no plan node", () => {
    const positions: ProtocolPositions = emptyPositions({
      backstop: [{ poolId: POOL_ID, shares: 0n, queuedForWithdrawal: 50n }],
    });
    expect(gate({ positions }).ok).toBe(false);
  });

  it("refuses when position discovery recorded an error", () => {
    const positions = emptyPositions({ errors: [{ protocol: "Blend", message: "timeout" }] });
    const result = gate({ positions });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/couldn't confirm/i);
  });

  it("refuses when standalone tokens are selected to be swept", () => {
    expect(gate({ heldTokensSelected: 1 }).ok).toBe(false);
  });

  it("refuses an account holding a classic pool share, withdrawn in its own transaction (L-94)", () => {
    const result = gate({ hasClassicPoolShares: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/liquidity pool share/i);
  });

  it("refuses an open Aquarius concentrated position (H-26)", () => {
    const positions = emptyPositions({
      aquariusConcentrated: [
        {
          poolAddress: POOL_ID,
          poolIndex: "ab".repeat(32),
          tokens: ["CA", "CB"],
          ranges: [{ tickLower: -10, tickUpper: 10, liquidity: 5n }],
          pendingFees: [0n, 0n],
          pendingReward: 0n,
        },
      ],
    });
    expect(gate({ positions }).ok).toBe(false);
  });

  it("refuses a tree with any step besides the classic close, even a skipped one", () => {
    const tree = makeTree({ positions: blendPositions() });
    // every Blend step skipped (a preview that couldn't build them), leaving only
    // skipped nodes besides the close
    for (const n of tree.allNodes.values()) if (n.kind !== "FinalClassicTx") n.status = "skipped";
    // positions cleared to prove the tree check stands on its own
    expect(gate({ tree }).ok).toBe(false);
  });

  it("refuses a held-token transfer step", () => {
    const tree = makeTree({ opts: { heldTokens: [{ contractId: TOKEN_C, balance: 1n }] } });
    expect(gate({ tree }).reason).toMatch(/TransferAsIs|token/i);
  });

  it("refuses a plan that was not built in deterministic mode (M-32)", () => {
    const result = gate({ deterministic: false });
    expect(result.ok).toBe(false);
  });
});

describe("the signing request is built from the reviewed plan (H-29)", () => {
  function decode(tx: Transaction): Transaction {
    return TransactionBuilder.fromXdr(tx.toXdr(), Networks.TESTNET) as Transaction;
  }

  it("carries the reviewed memo", () => {
    const memo = { type: "id", value: "777" } as const;
    const tree = makeTree({ opts: { memo } });
    const tx = decode(
      buildReviewedBundle({
        tree,
        input: { destination: DEST, useMediator: false, memo },
        sourceAccount: source(),
        network: TESTNET,
      }),
    );
    expect(tx.memo.type).toBe("id");
    expect(String(tx.memo.value)).toBe("777");
    const merge = tx.operations[tx.operations.length - 1]!;
    expect(merge.type).toBe("accountMerge");
    expect((merge as { destination: string }).destination).toBe(DEST);
  });

  it("claims only the claimable balances in the reviewed selection", () => {
    const audit = makeAudit({ claimableBalances: [cb(CB_KEEP), cb(CB_DROP)] });
    const tree = makeTree({ audit, opts: { selectedClaimableBalanceIds: [CB_KEEP] } });
    const tx = decode(
      buildReviewedBundle({
        tree,
        input: { destination: DEST, useMediator: false },
        sourceAccount: source(),
        network: TESTNET,
      }),
    );
    const claims = tx.operations.filter((o) => o.type === "claimClaimableBalance");
    expect(claims).toHaveLength(1);
    expect((claims[0] as { balanceId: string }).balanceId).toBe(CB_KEEP);
  });

  it("refuses when the reviewed memo and the plan's memo disagree", () => {
    const tree = makeTree({ opts: { memo: { type: "id", value: "1" } } });
    expect(() =>
      buildReviewedBundle({
        tree,
        input: { destination: DEST, useMediator: false, memo: { type: "id", value: "2" } },
        sourceAccount: source(),
        network: TESTNET,
      }),
    ).toThrow(/memo/i);
  });

  it("refuses a destination that differs from the reviewed one", () => {
    const tree: PlanTree = makeTree();
    expect(() =>
      buildReviewedBundle({
        tree,
        input: { destination: Keypair.random().publicKey(), useMediator: false },
        sourceAccount: source(),
        network: TESTNET,
      }),
    ).toThrow(/destination/i);
  });
});

describe("claims that may fail inside the 72h signing window (H-29)", () => {
  it("flags a balance whose claim window closes before the request expires", () => {
    const now = Date.parse("2026-10-02T00:00:00Z");
    const soon = new Date(now + 24 * 3600 * 1000).toISOString();
    const audit = makeAudit({
      claimableBalances: [
        cb("cb-expiring", {
          predicate: [{ destination: ACC, predicate: { abs_before: soon } }],
        }),
        cb("cb-fine"),
      ],
    });
    const tree = makeTree({ audit });
    const risky = claimsAtRiskInWindow({
      audit,
      tree,
      publicKey: ACC,
      nowMs: now,
      windowSeconds: 72 * 3600,
    });
    expect(risky.map((r) => r.id)).toEqual(["cb-expiring"]);
    expect(risky[0]!.reason).toBe("expires");
  });

  it("flags a balance the sender can take back", () => {
    const sender = Keypair.random().publicKey();
    const audit = makeAudit({
      claimableBalances: [
        cb("cb-reclaimable", {
          claimants: [ACC, sender],
          predicate: [
            { destination: ACC, predicate: { unconditional: true } },
            { destination: sender, predicate: { unconditional: true } },
          ],
        }),
      ],
    });
    const risky = claimsAtRiskInWindow({
      audit,
      tree: makeTree({ audit }),
      publicKey: ACC,
      nowMs: Date.now(),
      windowSeconds: 72 * 3600,
    });
    expect(risky.map((r) => r.reason)).toEqual(["reclaimable"]);
  });

  it("flags a claim of an asset the account holds no trustline for and the bundle doesn't open", () => {
    const issuer = Keypair.random().publicKey();
    const usdc = { kind: "credit" as const, code: "USDC", issuer };
    const audit = makeAudit({
      claimableBalances: [cb("cb-untrusted", { asset: usdc, issuerAuthRequired: false })],
    });
    // the plan opens the trustline right before the claim, so nothing is at risk
    const tree = makeTree({ audit });
    const final = tree.allNodes.get("final-classic-tx")!;
    if (final.kind !== "FinalClassicTx") throw new Error("expected the final node");
    const ops = final.metadata.batches.flatMap((b) => b.operations);
    expect(ops.some((o) => o.kind === "change_trust_add")).toBe(true);
    const args = { audit, publicKey: ACC, nowMs: Date.now(), windowSeconds: 72 * 3600 };
    expect(claimsAtRiskInWindow({ ...args, tree })).toEqual([]);

    // a bundle that claims without opening the line is rejected on chain
    const withoutLine: PlanTree = {
      ...tree,
      allNodes: new Map([
        [
          "final-classic-tx",
          {
            ...final,
            metadata: {
              ...final.metadata,
              batches: final.metadata.batches.map((b) => ({
                ...b,
                operations: b.operations.filter((o) => o.kind !== "change_trust_add"),
              })),
            },
          },
        ],
      ]),
    };
    const risky = claimsAtRiskInWindow({ ...args, tree: withoutLine });
    expect(risky.map((r) => r.reason)).toEqual(["untrusted"]);

    // the same balance is fine once the account trusts the asset
    const trusted = makeAudit({
      claimableBalances: [cb("cb-trusted", { asset: usdc })],
      balances: [
        ...makeAudit().balances,
        { asset: usdc, amount: "0.0000000", buyingLiabilities: "0", sellingLiabilities: "0" },
      ],
    });
    expect(
      claimsAtRiskInWindow({
        audit: trusted,
        tree: makeTree({ audit: trusted }),
        publicKey: ACC,
        nowMs: Date.now(),
        windowSeconds: 72 * 3600,
      }),
    ).toEqual([]);
  });
});

describe("hasClassicPoolShares", () => {
  it("is true only for a pool share line with a positive balance", () => {
    const share = (shareBalance: string) =>
      makeAudit({
        poolShares: [
          {
            poolId: "ab".repeat(32),
            poolType: "constant_product",
            shareBalance,
            totalShares: "100.0000000",
            shareLimit: "922337203685.4775807",
            fee: 30,
            reserves: [],
          },
        ],
      });
    expect(hasClassicPoolShares(share("0.0000000"))).toBe(false);
    expect(hasClassicPoolShares(share("1.5000000"))).toBe(true);
    expect(hasClassicPoolShares(makeAudit())).toBe(false);
  });
});

describe("re-probe before publishing (C-08)", () => {
  it("refuses when a backstop is still queued", async () => {
    const result = await reprobeBeforePublish(ACC, TESTNET, async () =>
      emptyPositions({ backstop: [{ poolId: POOL_ID, shares: 0n, queuedForWithdrawal: 3n }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses when the probe records an error or throws", async () => {
    const withError = await reprobeBeforePublish(ACC, TESTNET, async () =>
      emptyPositions({ errors: [{ protocol: "FxDAO", message: "rpc down" }] }),
    );
    expect(withError.ok).toBe(false);
    const thrown = await reprobeBeforePublish(ACC, TESTNET, async () => {
      throw new Error("network");
    });
    expect(thrown.ok).toBe(false);
  });

  it("passes when nothing is open", async () => {
    const result = await reprobeBeforePublish(ACC, TESTNET, async () => emptyPositions());
    expect(result.ok).toBe(true);
  });

  it("refuses an open lending position", async () => {
    const result = await reprobeBeforePublish(ACC, TESTNET, async () => blendPositions());
    expect(result.ok).toBe(false);
  });
});
