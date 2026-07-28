import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  applySlippage,
  batchClassicDemolition,
  isResidueOp,
  MAX_OPS_PER_TX,
  unroutableCredits,
} from "@/lib/plan/classic-batcher";
import type { AccountAudit } from "@/lib/types/account";
import type {
  BatchOptions,
  BatchedOperation,
  ClassicOpKind,
  PathResultRef,
} from "@/lib/types/plan";

const ACC = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const MED = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const POOL_ID = "a".repeat(64);

function makeAudit(over: Partial<AccountAudit> = {}): AccountAudit {
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
    balances: [],
    signers: [],
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

const directOptions: BatchOptions = { destination: DEST, useMediator: false };

function allOps(batches: readonly { readonly operations: readonly BatchedOperation[] }[]) {
  return batches.flatMap((b) => b.operations);
}

// canonical 9-phase order the batcher documents
const PHASE: Record<ClassicOpKind, number> = {
  create_account_mediator: 0,
  liquidity_pool_withdraw: 1,
  manage_sell_offer_cancel: 2,
  claim_claimable_balance: 3,
  path_payment_strict_send: 4,
  return_residue_to_issuer: 4,
  send_residue_to_destination: 4,
  change_trust_remove: 5,
  manage_data_delete: 6,
  set_options_clear_signers: 8,
  account_merge: 9,
};

describe("applySlippage", () => {
  it("applies a 1% haircut with 7-decimal precision", () => {
    expect(applySlippage("100")).toBe("99.0000000");
    expect(applySlippage("0")).toBe("0.0000000");
    expect(applySlippage("1.2345678")).toBe("1.2222221");
  });
});

describe("isResidueOp", () => {
  it("identifies only the return-to-issuer op", () => {
    const residue = {
      kind: "return_residue_to_issuer",
      summary: "",
      metadata: {},
    } as BatchedOperation;
    const merge = { kind: "account_merge", summary: "", metadata: {} } as BatchedOperation;
    expect(isResidueOp(residue)).toBe(true);
    expect(isResidueOp(merge)).toBe(false);
  });
});

describe("batchClassicDemolition, guards", () => {
  it("throws when useMediator is set without a mediator public key", () => {
    expect(() =>
      batchClassicDemolition(makeAudit(), { destination: DEST, useMediator: true }),
    ).toThrow();
  });
});

describe("batchClassicDemolition, minimal account", () => {
  it("emits a single account_merge to the destination and nothing else", () => {
    const batches = batchClassicDemolition(makeAudit(), directOptions);
    const ops = allOps(batches);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("account_merge");
    expect(ops[0]!.metadata.destination).toBe(DEST);
    expect(batches).toHaveLength(1);
  });
});

describe("batchClassicDemolition, canonical ordering", () => {
  const richAudit = makeAudit({
    thresholds: { low: 1, medium: 2, high: 3, masterWeight: 1 },
    poolShares: [
      {
        poolId: POOL_ID,
        poolType: "constant_product",
        shareBalance: "10",
        totalShares: "1000",
        shareLimit: "1000",
        fee: 30,
        reserves: [
          { asset: { kind: "native" }, amount: "5" },
          { asset: { kind: "credit", code: "USDC", issuer: ISSUER }, amount: "5" },
        ],
      },
    ],
    offers: [
      {
        id: "1",
        selling: { kind: "native" },
        buying: { kind: "credit", code: "USDC", issuer: ISSUER },
        amount: "10",
        priceR: { n: 1, d: 2 },
      },
    ],
    claimableBalances: [
      {
        id: "cb" + "0".repeat(60),
        asset: { kind: "native" },
        amount: "5",
        sponsor: ACC,
        predicate: { unconditional: true },
        claimants: [ACC],
      },
    ],
    balances: [
      {
        asset: { kind: "credit", code: "USDC", issuer: ISSUER },
        amount: "100",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
      {
        asset: { kind: "liquidity_pool_shares", poolId: POOL_ID },
        amount: "10",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ],
    data: [{ name: "key1", value: "dmFs" }],
    signers: [
      { key: OTHER, type: "ed25519_public_key", weight: 1 },
      { key: ACC, type: "ed25519_public_key", weight: 1 },
    ],
    // 1 self-sponsored, claimable CB, released by its claim op, not a revoke
    sponsorship: { numSponsoring: 1, numSponsored: 0, coverable: 1 },
  });

  // supply an XLM path for the USDC balance so it converts via path payment
  const richPaths = new Map<string, PathResultRef>([
    [`USDC:${ISSUER}`, { destinationAmount: "95", path: [], sourceAmount: "100" }],
  ]);
  const ops = allOps(batchClassicDemolition(richAudit, directOptions, richPaths));

  it("emits ops in non-decreasing phase order and merges last", () => {
    const phases = ops.map((o) => PHASE[o.kind]);
    for (let i = 1; i < phases.length; i += 1) {
      expect(phases[i]!).toBeGreaterThanOrEqual(phases[i - 1]!);
    }
    expect(ops[ops.length - 1]!.kind).toBe("account_merge");
  });

  it("covers every phase exactly where expected", () => {
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toContain("liquidity_pool_withdraw");
    expect(kinds).toContain("manage_sell_offer_cancel");
    expect(kinds).toContain("claim_claimable_balance");
    expect(kinds).toContain("path_payment_strict_send"); // USDC converts via the supplied path
    expect(kinds).not.toContain("return_residue_to_issuer");
    expect(kinds.filter((k) => k === "change_trust_remove")).toHaveLength(2); // pool-share + USDC
    expect(kinds).toContain("manage_data_delete");
    expect(kinds).toContain("set_options_clear_signers");
  });

  it("clears only the non-master signer", () => {
    const clears = ops.filter((o) => o.kind === "set_options_clear_signers");
    const signerClears = clears.filter((o) => o.metadata.signerKey !== undefined);
    expect(signerClears).toHaveLength(1);
    expect(signerClears[0]!.metadata.signerKey).toBe(OTHER);
  });

  it("releases self-sponsored CBs via their claim op, emitting no revoke op", () => {
    // the self-sponsored, claimable CB is claimed, which releases its
    // sponsorship on-chain; there is no separate/bogus revoke_sponsorship op.
    const kinds = ops.map((o) => o.kind);
    expect(kinds.filter((k) => k === "claim_claimable_balance")).toHaveLength(1);
    expect(kinds).not.toContain("revoke_sponsorship");
    expect(kinds).toContain("account_merge");
  });
});

describe("batchClassicDemolition, liquidity pool withdraw minimums", () => {
  // a fractional holder: this account owns "1" of a pool's "1000" total shares,
  // whose reserves are "500"/"500". Its proportional payout is 500 * 1/1000 =
  // 0.5 of each reserve; the withdraw minimum is a 1% haircut of THAT (0.495),
  // never ~99% of the whole reserve (495), which would revert for a fractional
  // holder with LIQUIDITY_POOL_WITHDRAW_UNDER_MINIMUM.
  const fractionalPool = makeAudit({
    poolShares: [
      {
        poolId: POOL_ID,
        poolType: "constant_product",
        shareBalance: "1",
        totalShares: "1000",
        shareLimit: "1000",
        fee: 30,
        reserves: [
          { asset: { kind: "native" }, amount: "500" },
          { asset: { kind: "credit", code: "USDC", issuer: ISSUER }, amount: "500" },
        ],
      },
    ],
  });

  it("derives the withdraw minimum from the holder's proportional share", () => {
    const withdraw = allOps(batchClassicDemolition(fractionalPool, directOptions)).find(
      (o) => o.kind === "liquidity_pool_withdraw",
    )!;
    // the amount withdrawn is still this account's full share balance
    expect(withdraw.metadata.amount).toBe("1");
    // proportional payout 500 * 1/1000 = 0.5 per reserve, 1% haircut -> 0.495
    expect(withdraw.metadata.minAmountA).toBe("0.4950000");
    expect(withdraw.metadata.minAmountB).toBe("0.4950000");
  });

  it("falls back to a 0 floor when totalShares is unavailable", () => {
    const noTotal = makeAudit({
      poolShares: [
        {
          poolId: POOL_ID,
          poolType: "constant_product",
          shareBalance: "1",
          totalShares: "0",
          shareLimit: "1000",
          fee: 30,
          reserves: [
            { asset: { kind: "native" }, amount: "500" },
            { asset: { kind: "credit", code: "USDC", issuer: ISSUER }, amount: "500" },
          ],
        },
      ],
    });
    const withdraw = allOps(batchClassicDemolition(noTotal, directOptions)).find(
      (o) => o.kind === "liquidity_pool_withdraw",
    )!;
    expect(withdraw.metadata.minAmountA).toBe("0");
    expect(withdraw.metadata.minAmountB).toBe("0");
  });
});

describe("batchClassicDemolition, SEC-13 two-phase pool close", () => {
  // an account holding pool shares AND the underlying trustlines. A withdraw
  // credits the underlying assets, so removing their trustlines / merging in the
  // same tx would revert. The batcher must isolate the withdraw into a leading
  // batch; the executor re-audits and handles the credited balances afterwards.
  const poolAccount = makeAudit({
    poolShares: [
      {
        poolId: POOL_ID,
        poolType: "constant_product",
        shareBalance: "10",
        totalShares: "1000",
        shareLimit: "1000",
        fee: 30,
        reserves: [
          { asset: { kind: "native" }, amount: "5" },
          { asset: { kind: "credit", code: "USDC", issuer: ISSUER }, amount: "5" },
        ],
      },
    ],
    balances: [
      // pool-share trustline + the underlying USDC trustline, both empty at audit
      // time (the underlying balance only appears AFTER the withdraw)
      {
        asset: { kind: "liquidity_pool_shares", poolId: POOL_ID },
        amount: "10",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
      {
        asset: { kind: "credit", code: "USDC", issuer: ISSUER },
        amount: "0",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ],
  });

  it("isolates the withdraw into a leading batch, free of removals and the merge", () => {
    const batches = batchClassicDemolition(poolAccount, directOptions);
    expect(batches.length).toBeGreaterThan(1);
    const first = batches[0]!.operations.map((o) => o.kind);
    expect(first).toContain("liquidity_pool_withdraw");
    // the credited-balance handling must NOT share the withdraw's transaction
    expect(first).not.toContain("change_trust_remove");
    expect(first).not.toContain("account_merge");
  });

  it("keeps the account_merge in the final batch and drops no ops", () => {
    const batches = batchClassicDemolition(poolAccount, directOptions);
    const last = batches[batches.length - 1]!.operations;
    expect(last[last.length - 1]!.kind).toBe("account_merge");
    // exactly one withdraw and one merge across the whole close, nothing dropped
    const kinds = allOps(batches).map((o) => o.kind);
    expect(kinds.filter((k) => k === "liquidity_pool_withdraw")).toHaveLength(1);
    expect(kinds.filter((k) => k === "account_merge")).toHaveLength(1);
    // the pool-share trustline is still removed (in the later batch, not batch 0)
    expect(kinds).toContain("change_trust_remove");
  });

  it("keeps the mediator-funding op with the withdraw and omits it once funded", () => {
    const withFunding = batchClassicDemolition(poolAccount, {
      destination: DEST,
      useMediator: true,
      mediatorPublicKey: MED,
    });
    // funding op leads the withdraw batch so the mediator exists before the merge
    expect(withFunding[0]!.operations[0]!.kind).toBe("create_account_mediator");

    // a re-audit phase after the mediator is funded must NOT re-create it
    const alreadyFunded = batchClassicDemolition(poolAccount, {
      destination: DEST,
      useMediator: true,
      mediatorPublicKey: MED,
      mediatorAlreadyFunded: true,
    });
    const allKinds = allOps(alreadyFunded).map((o) => o.kind);
    expect(allKinds).not.toContain("create_account_mediator");
  });
});

describe("batchClassicDemolition, self-merge guard", () => {
  it("throws when the direct merge destination equals the account being closed", () => {
    expect(() =>
      batchClassicDemolition(makeAudit({ accountId: ACC }), {
        destination: ACC,
        useMediator: false,
      }),
    ).toThrow(/self-merge is invalid/);
  });

  it("still merges into a distinct direct destination", () => {
    const ops = allOps(batchClassicDemolition(makeAudit({ accountId: ACC }), directOptions));
    const merge = ops.find((o) => o.kind === "account_merge")!;
    expect(merge.metadata.destination).toBe(DEST);
  });
});

describe("batchClassicDemolition, claimable-balance opt-in", () => {
  const twoCbs = makeAudit({
    claimableBalances: [
      {
        id: "cbA",
        asset: { kind: "native" },
        amount: "1",
        sponsor: OTHER,
        predicate: {},
        claimants: [ACC],
      },
      {
        id: "cbB",
        asset: { kind: "native" },
        amount: "1",
        sponsor: OTHER,
        predicate: {},
        claimants: [ACC],
      },
    ],
  });

  it("claims all CBs when the opt-in list is undefined", () => {
    const claims = allOps(batchClassicDemolition(twoCbs, directOptions)).filter(
      (o) => o.kind === "claim_claimable_balance",
    );
    expect(claims).toHaveLength(2);
  });

  it("claims no CBs when the opt-in list is empty", () => {
    const claims = allOps(
      batchClassicDemolition(twoCbs, { ...directOptions, claimableBalanceIds: [] }),
    ).filter((o) => o.kind === "claim_claimable_balance");
    expect(claims).toHaveLength(0);
  });

  it("claims only the opted-in CB", () => {
    const claims = allOps(
      batchClassicDemolition(twoCbs, { ...directOptions, claimableBalanceIds: ["cbB"] }),
    ).filter((o) => o.kind === "claim_claimable_balance");
    expect(claims).toHaveLength(1);
    expect(claims[0]!.metadata.balanceId).toBe("cbB");
  });

  it("never claims a CB that is not claimable now, even if opted in", () => {
    const locked = makeAudit({
      claimableBalances: [
        {
          id: "cbLocked",
          asset: { kind: "native" },
          amount: "1",
          sponsor: OTHER,
          predicate: {},
          claimants: [ACC],
          claimableNow: false,
        },
      ],
    });
    const claims = allOps(
      batchClassicDemolition(locked, { ...directOptions, claimableBalanceIds: ["cbLocked"] }),
    ).filter((o) => o.kind === "claim_claimable_balance");
    expect(claims).toHaveLength(0);
  });
});

describe("batchClassicDemolition, un-routable credit handling", () => {
  const key = `USDC:${ISSUER}`;
  const withCredit = makeAudit({
    balances: [
      {
        asset: { kind: "credit", code: "USDC", issuer: ISSUER },
        amount: "100",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ],
  });

  it("leaves an un-routable, unconsented balance untouched, no residue, trustline kept", () => {
    const kinds = allOps(batchClassicDemolition(withCredit, directOptions)).map((o) => o.kind);
    expect(kinds).not.toContain("return_residue_to_issuer");
    expect(kinds).not.toContain("path_payment_strict_send");
    expect(kinds).not.toContain("change_trust_remove"); // live balance => trustline stays
    expect(unroutableCredits(withCredit, undefined, undefined)).toHaveLength(1);
  });

  it("returns to issuer only with explicit consent, then removes the trustline", () => {
    const opts: BatchOptions = { ...directOptions, returnToIssuerAssetKeys: [key] };
    const kinds = allOps(batchClassicDemolition(withCredit, opts)).map((o) => o.kind);
    expect(kinds.filter((k) => k === "return_residue_to_issuer")).toHaveLength(1);
    expect(kinds.filter((k) => k === "change_trust_remove")).toHaveLength(1);
    expect(unroutableCredits(withCredit, undefined, [key])).toHaveLength(0);
  });

  it("converts via path payment when a path exists, then removes the trustline", () => {
    const paths = new Map<string, PathResultRef>([
      [key, { destinationAmount: "95", path: [], sourceAmount: "100" }],
    ]);
    const kinds = allOps(batchClassicDemolition(withCredit, directOptions, paths)).map(
      (o) => o.kind,
    );
    expect(kinds.filter((k) => k === "path_payment_strict_send")).toHaveLength(1);
    expect(kinds).not.toContain("return_residue_to_issuer");
    expect(kinds.filter((k) => k === "change_trust_remove")).toHaveLength(1);
    expect(unroutableCredits(withCredit, paths, undefined)).toHaveLength(0);
  });

  it("treats a zero-balance credit line as removable, not un-routable", () => {
    const zero = makeAudit({
      balances: [
        {
          asset: { kind: "credit", code: "ZERO", issuer: ISSUER },
          amount: "0",
          buyingLiabilities: "0",
          sellingLiabilities: "0",
        },
      ],
    });
    const kinds = allOps(batchClassicDemolition(zero, directOptions)).map((o) => o.kind);
    expect(kinds.filter((k) => k === "change_trust_remove")).toHaveLength(1);
    expect(unroutableCredits(zero, undefined, undefined)).toHaveLength(0);
  });
});

describe("batchClassicDemolition, MAX_OPS splitting", () => {
  const manyOffers = makeAudit({
    offers: Array.from({ length: 150 }, (_, i) => ({
      id: String(i + 1),
      selling: { kind: "native" as const },
      buying: { kind: "credit" as const, code: "USDC", issuer: ISSUER },
      amount: "1",
      priceR: { n: 1, d: 1 },
    })),
  });

  it("splits into batches of at most MAX_OPS_PER_TX with the merge in the final batch", () => {
    const batches = batchClassicDemolition(manyOffers, directOptions);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.operations.length).toBeLessThanOrEqual(MAX_OPS_PER_TX);
    const flat = allOps(batches);
    expect(flat).toHaveLength(151); // 150 cancels + 1 merge
    const last = batches[batches.length - 1]!;
    expect(last.operations[last.operations.length - 1]!.kind).toBe("account_merge");
  });
});

describe("batchClassicDemolition, mediator", () => {
  const opts: BatchOptions = { destination: DEST, useMediator: true, mediatorPublicKey: MED };

  it("funds the mediator first, merges into the mediator, and tags the batch", () => {
    const batches = batchClassicDemolition(makeAudit(), opts);
    const ops = allOps(batches);
    expect(ops[0]!.kind).toBe("create_account_mediator");
    expect(ops[0]!.metadata.destination).toBe(MED);
    const merge = ops.find((o) => o.kind === "account_merge")!;
    expect(merge.metadata.destination).toBe(MED); // merges into mediator, not the final dest
    expect(merge.metadata.ultimateDestination).toBe(DEST);
    expect(batches[batches.length - 1]!.mediator?.publicKey).toBe(MED);
  });
});

describe("batchClassicDemolition, un-routable residue disposal", () => {
  const CODE = "WEIRD";
  const RES_KEY = `${CODE}:${ISSUER}`;
  const residueAudit = makeAudit({
    balances: [
      {
        asset: { kind: "credit", code: CODE, issuer: ISSUER },
        amount: "10",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ],
  });

  it("sends the balance to the merge destination when consented (not the issuer), then removes its trustline", () => {
    const ops = allOps(
      batchClassicDemolition(residueAudit, {
        ...directOptions,
        sendToDestinationAssetKeys: [RES_KEY],
      }),
    );
    const send = ops.find((o) => o.kind === "send_residue_to_destination");
    expect(send).toBeDefined();
    expect(send!.metadata.destination).toBe(DEST); // the merge destination, not the issuer
    expect(send!.metadata.amount).toBe("10");
    expect(ops.some((o) => o.kind === "return_residue_to_issuer")).toBe(false);
    // once disposed, the trustline is removed and the account can merge
    expect(ops.filter((o) => o.kind === "change_trust_remove")).toHaveLength(1);
    expect(ops[ops.length - 1]!.kind).toBe("account_merge");
  });

  it("send-to-destination takes precedence over a same-asset return-to-issuer consent", () => {
    const ops = allOps(
      batchClassicDemolition(residueAudit, {
        ...directOptions,
        returnToIssuerAssetKeys: [RES_KEY],
        sendToDestinationAssetKeys: [RES_KEY],
      }),
    );
    expect(ops.some((o) => o.kind === "send_residue_to_destination")).toBe(true);
    expect(ops.some((o) => o.kind === "return_residue_to_issuer")).toBe(false);
  });

  it("leaves the balance and its trustline in place with no disposal consent", () => {
    const ops = allOps(batchClassicDemolition(residueAudit, directOptions));
    expect(ops.some((o) => o.kind === "send_residue_to_destination")).toBe(false);
    expect(ops.some((o) => o.kind === "return_residue_to_issuer")).toBe(false);
    expect(ops.some((o) => o.kind === "change_trust_remove")).toBe(false);
  });

  it("unroutableCredits excludes assets consented to send-to-destination", () => {
    expect(unroutableCredits(residueAudit, undefined).map((c) => c.key)).toEqual([RES_KEY]);
    expect(unroutableCredits(residueAudit, undefined, [], [RES_KEY])).toEqual([]);
  });

  it("isResidueOp recognises the send-to-destination op", () => {
    const op = {
      kind: "send_residue_to_destination",
      summary: "",
      metadata: {},
    } as BatchedOperation;
    expect(isResidueOp(op)).toBe(true);
  });
});
