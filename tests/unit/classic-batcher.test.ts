import { describe, it, expect } from "vitest";
import { Account, Keypair, type Horizon, type Transaction } from "@stellar/stellar-sdk";
import {
  applySlippage,
  batchClassicDemolition,
  closeMarkerPlanned,
  mediatorFundingCheck,
  MAX_OPS_PER_TX,
  planClaimableBalances,
  unroutableCredits,
} from "@/lib/plan/classic-batcher";
import type { AccountAudit, AuditBalance, ClaimableBalanceEntry } from "@/lib/types/account";
import type {
  BatchOptions,
  BatchedOperation,
  ClassicBatch,
  ClassicOpKind,
  PathResultRef,
} from "@/lib/types/plan";
import { TESTNET } from "@/lib/config/networks";
import { CLOSE_MARKER_NAME, CLOSE_MARKER_VALUE } from "@/lib/metrics/close-marker";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";

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

// a reference quote at the same rate as the full quote: no price impact
function pricedPath(sourceAmount: string, destinationAmount: string): PathResultRef {
  return {
    sourceAmount,
    destinationAmount,
    path: [],
    reference: { sourceAmount, destinationAmount },
  };
}

// canonical order the batcher documents
const PHASE: Record<ClassicOpKind, number> = {
  liquidity_pool_withdraw: 1,
  manage_sell_offer_cancel: 2,
  claim_claimable_balance: 3,
  path_payment_strict_send: 4,
  return_residue_to_issuer: 4,
  send_residue_to_destination: 4,
  change_trust_remove: 5,
  change_trust_add: 3,
  manage_data_delete: 6,
  set_options_clear_signers: 8,
  close_marker: 9,
  create_account_mediator: 9,
  account_merge: 10,
};

describe("applySlippage", () => {
  it("applies a 1% haircut with 7-decimal precision", () => {
    expect(applySlippage("100")).toBe("99.0000000");
    expect(applySlippage("0")).toBe("0.0000000");
    expect(applySlippage("1.2345678")).toBe("1.2222221");
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
  const richPaths = new Map<string, PathResultRef>([[`USDC:${ISSUER}`, pricedPath("100", "95")]]);
  const ops = allOps(batchClassicDemolition(richAudit, directOptions, richPaths));

  it("emits ops in non-decreasing phase order and merges last", () => {
    const phases = ops.map((o) => PHASE[o.kind]);
    for (let i = 1; i < phases.length; i += 1) {
      expect(phases[i]!).toBeGreaterThanOrEqual(phases[i - 1]!);
    }
    expect(ops[ops.length - 1]!.kind).toBe("account_merge");
  });

  it("covers every phase where expected, with no return_residue or send_residue payment", () => {
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toContain("liquidity_pool_withdraw");
    expect(kinds).toContain("manage_sell_offer_cancel");
    expect(kinds).toContain("claim_claimable_balance");
    expect(kinds).toContain("path_payment_strict_send"); // USDC converts via the supplied path
    expect(kinds).not.toContain("return_residue_to_issuer");
    expect(kinds).not.toContain("send_residue_to_destination");
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

  it("refuses to size an unprotected withdraw when totalShares is not positive (L-30)", () => {
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
    expect(() => batchClassicDemolition(noTotal, directOptions)).toThrow(
      /cannot size a withdraw floor/,
    );
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

  it("funds the mediator right before the merge, never in the withdraw batch (H-16)", () => {
    const withFunding = batchClassicDemolition(poolAccount, {
      destination: DEST,
      useMediator: true,
      mediatorPublicKey: MED,
    });
    expect(withFunding[0]!.operations.map((o) => o.kind)).not.toContain("create_account_mediator");
    const last = withFunding[withFunding.length - 1]!.operations.map((o) => o.kind);
    expect(last.slice(-2)).toEqual(["create_account_mediator", "account_merge"]);

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
    const paths = new Map<string, PathResultRef>([[key, pricedPath("100", "95")]]);
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

  it("funds the mediator, merges into the mediator, and tags the batch", () => {
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
    expect(send!.metadata.amount).toBe("10.0000000");
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
});

const USDC = { kind: "credit", code: "USDC", issuer: ISSUER } as const;
const USDC_KEY = `USDC:${ISSUER}`;

function usdcLine(amount: string, over: Partial<AuditBalance> = {}): AuditBalance {
  return {
    asset: USDC,
    amount,
    limit: "922337203685.4775807",
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    isAuthorized: true,
    ...over,
  };
}

function usdcCb(
  id: string,
  amount: string,
  over: Partial<ClaimableBalanceEntry> = {},
): ClaimableBalanceEntry {
  return {
    id,
    asset: USDC,
    amount,
    sponsor: OTHER,
    predicate: {},
    claimants: [ACC],
    claimableNow: true,
    ...over,
  };
}

function nativeLine(amount: string): AuditBalance {
  return {
    asset: { kind: "native" },
    amount,
    buyingLiabilities: "0",
    sellingLiabilities: "0",
  };
}

// index of the first batch holding an op that matches
function batchWith(
  batches: readonly ClassicBatch[],
  pred: (op: BatchedOperation) => boolean,
): number {
  return batches.findIndex((b) => b.operations.some(pred));
}

const isClaim = (op: BatchedOperation) => op.kind === "claim_claimable_balance";
const isUsdcRemoval = (op: BatchedOperation) =>
  op.kind === "change_trust_remove" &&
  (op.metadata.asset as { code?: string } | undefined)?.code === "USDC";

describe("H-09: credit claimable balances the account can't receive are not claimed", () => {
  it("leaves a credit CB behind when the account has no trustline for it", () => {
    const audit = makeAudit({ claimableBalances: [usdcCb("cbSpam", "5")] });
    const ops = allOps(batchClassicDemolition(audit, directOptions));
    expect(ops.some(isClaim)).toBe(false);
    expect(planClaimableBalances(audit, undefined).leftBehind).toEqual([
      { balance: audit.claimableBalances[0], reason: "no_trustline" },
    ]);
  });

  it("leaves a credit CB behind when its trustline is not authorized", () => {
    const audit = makeAudit({
      balances: [usdcLine("0", { isAuthorized: false })],
      claimableBalances: [usdcCb("cbFrozen", "5")],
    });
    expect(allOps(batchClassicDemolition(audit, directOptions)).some(isClaim)).toBe(false);
    expect(planClaimableBalances(audit, undefined).leftBehind[0]!.reason).toBe("not_authorized");
  });

  it("raises the limit of a line that can't take every claim, instead of overfilling it", () => {
    const audit = makeAudit({
      balances: [usdcLine("5", { limit: "10" })],
      claimableBalances: [usdcCb("cbFits", "3"), usdcCb("cbOver", "3")],
    });
    const plan = planClaimableBalances(audit, undefined);
    expect(plan.claimed.map((c) => c.id)).toEqual(["cbFits", "cbOver"]);
    expect(plan.leftBehind).toEqual([]);
    expect(plan.trustlineChanges).toEqual([{ asset: USDC, change: "raise" }]);
    const ops = allOps(batchClassicDemolition(audit, directOptions));
    const kinds = ops.map((o) => o.kind);
    expect(kinds.indexOf("change_trust_add")).toBeLessThan(
      kinds.indexOf("claim_claimable_balance"),
    );
    expect(ops.filter(isClaim).map((c) => c.metadata.balanceId)).toEqual(["cbFits", "cbOver"]);
  });
});

describe("H-10: a credit claim lands before its asset is converted or its trustline removed", () => {
  it("claims into a positive balance in an earlier batch than the conversion", () => {
    const audit = makeAudit({
      balances: [usdcLine("10")],
      claimableBalances: [usdcCb("cb1", "5")],
    });
    const paths = new Map([[USDC_KEY, pricedPath("10", "40")]]);
    const batches = batchClassicDemolition(audit, directOptions, paths);
    const claimAt = batchWith(batches, isClaim);
    const convertAt = batchWith(batches, (o) => o.kind === "path_payment_strict_send");
    expect(claimAt).toBeGreaterThanOrEqual(0);
    expect(convertAt).toBeGreaterThan(claimAt);
    // the claim's batch never removes the trustline it credits, nor merges
    const claimKinds = batches[claimAt]!.operations;
    expect(claimKinds.some(isUsdcRemoval)).toBe(false);
    expect(claimKinds.some((o) => o.kind === "account_merge")).toBe(false);
  });

  it("claims into a zero-balance trustline without removing it in the same transaction", () => {
    const audit = makeAudit({
      balances: [usdcLine("0")],
      claimableBalances: [usdcCb("cb1", "5")],
    });
    const batches = batchClassicDemolition(audit, directOptions);
    const claimAt = batchWith(batches, isClaim);
    expect(batches[claimAt]!.operations.some(isUsdcRemoval)).toBe(false);
    expect(batches[claimAt]!.operations.some((o) => o.kind === "account_merge")).toBe(false);
    // and the preview reports the claimed asset as needing a disposal
    expect(unroutableCredits(audit, undefined)).toEqual([
      expect.objectContaining({ key: USDC_KEY, amount: "5.0000000", reason: "no_path" }),
    ]);
  });

  it("sizes an explicit disposal with the claimed amount and keeps it in one transaction", () => {
    const audit = makeAudit({
      balances: [usdcLine("5")],
      claimableBalances: [usdcCb("cb1", "3")],
    });
    const batches = batchClassicDemolition(audit, {
      ...directOptions,
      returnToIssuerAssetKeys: [USDC_KEY],
    });
    expect(batches).toHaveLength(1);
    const kinds = batches[0]!.operations.map((o) => o.kind);
    expect(kinds.indexOf("claim_claimable_balance")).toBeLessThan(
      kinds.indexOf("return_residue_to_issuer"),
    );
    expect(kinds.indexOf("return_residue_to_issuer")).toBeLessThan(
      kinds.indexOf("change_trust_remove"),
    );
    const payment = batches[0]!.operations.find((o) => o.kind === "return_residue_to_issuer")!;
    expect(payment.metadata.amount).toBe("8.0000000");
  });
});

describe("H-11: claimable-balance selection", () => {
  it("claims a self-sponsored claimable CB even when it is not selected", () => {
    const audit = makeAudit({
      claimableBalances: [
        {
          id: "cbMine",
          asset: { kind: "native" },
          amount: "2",
          sponsor: ACC,
          predicate: {},
          claimants: [ACC],
          claimableNow: true,
        },
      ],
      sponsorship: { numSponsoring: 1, numSponsored: 0, coverable: 1 },
    });
    const claims = allOps(
      batchClassicDemolition(audit, { ...directOptions, claimableBalanceIds: [] }),
    ).filter(isClaim);
    expect(claims.map((c) => c.metadata.balanceId)).toEqual(["cbMine"]);
  });
});

describe("H-14: residue sent to the destination", () => {
  const residue = makeAudit({ balances: [usdcLine("10")] });

  it("refuses send-to-destination on a mediator close", () => {
    expect(() =>
      batchClassicDemolition(residue, {
        destination: DEST,
        useMediator: true,
        mediatorPublicKey: MED,
        sendToDestinationAssetKeys: [USDC_KEY],
      }),
    ).toThrow(/not available on an exchange/);
  });

  it("keeps the payment in the memo-carrying final batch of a multi-batch direct close", () => {
    const audit = makeAudit({
      balances: [usdcLine("10")],
      data: Array.from({ length: 150 }, (_, i) => ({ name: `k${i}`, value: "dg==" })),
    });
    const memo = { type: "id", value: "42" } as const;
    const batches = batchClassicDemolition(audit, {
      ...directOptions,
      memo,
      sendToDestinationAssetKeys: [USDC_KEY],
    });
    expect(batches.length).toBeGreaterThan(1);
    const final = batches[batches.length - 1]!;
    expect(final.memo).toEqual(memo);
    const sendAt = batchWith(batches, (o) => o.kind === "send_residue_to_destination");
    expect(sendAt).toBe(batches.length - 1);
    // and its trustline removal follows it in that batch
    const kinds = final.operations.map((o) => o.kind);
    expect(final.operations.findIndex(isUsdcRemoval)).toBeGreaterThan(
      kinds.indexOf("send_residue_to_destination"),
    );
  });
});

describe("H-16: the mediator is funded right before the merge", () => {
  const opts: BatchOptions = { destination: DEST, useMediator: true, mediatorPublicKey: MED };

  it("places create_account_mediator after the ops that free reserves", () => {
    const audit = makeAudit({
      balances: [nativeLine("3"), usdcLine("0")],
      offers: [
        {
          id: "7",
          selling: { kind: "native" },
          buying: USDC,
          amount: "1",
          priceR: { n: 1, d: 1 },
        },
      ],
      data: [{ name: "k", value: "dg==" }],
    });
    const batches = batchClassicDemolition(audit, opts);
    const final = batches[batches.length - 1]!.operations.map((o) => o.kind);
    expect(final.slice(-2)).toEqual(["create_account_mediator", "account_merge"]);
    expect(allOps(batches).filter((o) => o.kind === "create_account_mediator")).toHaveLength(1);
  });

  it("reports whether the account can fund the mediator", () => {
    const short = makeAudit({ balances: [nativeLine("2.5")] });
    const shortCheck = mediatorFundingCheck(short, batchClassicDemolition(short, opts), 100);
    expect(shortCheck?.sufficient).toBe(false);
    expect(shortCheck?.requiredStroops).toBe(20_000_000n);

    const enough = makeAudit({ balances: [nativeLine("3.5")] });
    expect(
      mediatorFundingCheck(enough, batchClassicDemolition(enough, opts), 100)?.sufficient,
    ).toBe(true);
    // no mediator in the plan: nothing to check
    expect(
      mediatorFundingCheck(enough, batchClassicDemolition(enough, directOptions), 100),
    ).toBeNull();
  });

  it("counts native claims and path-payment floors toward the funding", () => {
    const audit = makeAudit({
      balances: [nativeLine("1.5"), usdcLine("10")],
      claimableBalances: [
        {
          id: "cbX",
          asset: { kind: "native" },
          amount: "1",
          sponsor: OTHER,
          predicate: {},
          claimants: [ACC],
          claimableNow: true,
        },
      ],
    });
    const paths = new Map([[USDC_KEY, pricedPath("10", "1")]]);
    const check = mediatorFundingCheck(audit, batchClassicDemolition(audit, opts, paths), 100);
    // 1.5 + 1 (claim) + 0.99 (destMin) - fees - 1 reserve >= 2
    expect(check?.sufficient).toBe(true);
  });

  it("subtracts what the steps before the classic batches spend", () => {
    const audit = makeAudit({ balances: [nativeLine("3.5")] });
    const batches = batchClassicDemolition(audit, opts);
    expect(mediatorFundingCheck(audit, batches, 100)?.sufficient).toBe(true);
    // 0.6 XLM of soroban fees ahead of the merge leaves less than 2 XLM free
    const check = mediatorFundingCheck(audit, batches, 100, 6_000_000n);
    expect(check?.sufficient).toBe(false);
    // four ops at 100 stroops: the close marker pair, the funding and the merge
    expect(check?.availableStroops).toBe(35_000_000n - 400n - 10_000_000n - 6_000_000n);
  });
});

describe("L-18: threshold reset, signer removals and merge share the final batch", () => {
  it("keeps the whole merge group in the last batch, reset first", () => {
    const signers = Array.from({ length: 3 }, () => ({
      key: Keypair.random().publicKey(),
      type: "ed25519_public_key" as const,
      weight: 1,
    }));
    const audit = makeAudit({
      thresholds: { low: 2, medium: 2, high: 2, masterWeight: 1 },
      signers: [...signers, { key: ACC, type: "ed25519_public_key", weight: 1 }],
      data: Array.from({ length: 98 }, (_, i) => ({ name: `k${i}`, value: "dg==" })),
    });
    const batches = batchClassicDemolition(audit, directOptions);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(b.operations.length).toBeLessThanOrEqual(MAX_OPS_PER_TX);
    const last = batches[batches.length - 1]!.operations;
    const tail = last.filter(
      (o) => o.kind === "set_options_clear_signers" || o.kind === "account_merge",
    );
    expect(tail).toHaveLength(5);
    expect(tail[0]!.metadata.thresholds).toBeDefined();
    expect(tail.slice(1, 4).every((o) => o.metadata.signerKey !== undefined)).toBe(true);
    expect(tail[4]!.kind).toBe("account_merge");
    for (const b of batches.slice(0, -1)) {
      expect(b.operations.some((o) => o.kind === "set_options_clear_signers")).toBe(false);
    }
  });
});

describe("L-31: an explicit disposal choice wins over a market path", () => {
  it("sends to the destination although a path exists", () => {
    const audit = makeAudit({ balances: [usdcLine("10")] });
    const paths = new Map([[USDC_KEY, pricedPath("10", "40")]]);
    const kinds = allOps(
      batchClassicDemolition(
        audit,
        { ...directOptions, sendToDestinationAssetKeys: [USDC_KEY] },
        paths,
      ),
    ).map((o) => o.kind);
    expect(kinds).toContain("send_residue_to_destination");
    expect(kinds).not.toContain("path_payment_strict_send");
  });
});

describe("M-18: classic conversions are capped against a reference price", () => {
  const audit = makeAudit({ balances: [usdcLine("1000000")] });
  // mainnet example from the audit: 3.694 XLM/USDC at full size vs 4.416 at 100 USDC
  const impacted: PathResultRef = {
    sourceAmount: "1000000",
    destinationAmount: "3694000",
    path: [],
    reference: { sourceAmount: "100", destinationAmount: "441.6" },
  };

  it("does not sell over the cap and reports the impact", () => {
    const paths = new Map([[USDC_KEY, impacted]]);
    const kinds = allOps(batchClassicDemolition(audit, directOptions, paths)).map((o) => o.kind);
    expect(kinds).not.toContain("path_payment_strict_send");
    expect(kinds).not.toContain("change_trust_remove");
    const [blocked] = unroutableCredits(audit, paths);
    expect(blocked?.reason).toBe("price_impact");
    expect(blocked?.priceImpactBps).toBe(1635);
  });

  it("sells over the cap only with an explicit per-asset confirmation", () => {
    const paths = new Map([[USDC_KEY, impacted]]);
    const opts: BatchOptions = { ...directOptions, acceptedPriceImpactAssetKeys: [USDC_KEY] };
    const kinds = allOps(batchClassicDemolition(audit, opts, paths)).map((o) => o.kind);
    expect(kinds).toContain("path_payment_strict_send");
    expect(
      unroutableCredits(audit, paths, undefined, undefined, {
        acceptedPriceImpactAssetKeys: [USDC_KEY],
      }),
    ).toEqual([]);
  });

  it("treats a quote without a reference as unpriced", () => {
    const paths = new Map<string, PathResultRef>([
      [USDC_KEY, { sourceAmount: "1000000", destinationAmount: "4000000", path: [] }],
    ]);
    const kinds = allOps(batchClassicDemolition(audit, directOptions, paths)).map((o) => o.kind);
    expect(kinds).not.toContain("path_payment_strict_send");
    expect(unroutableCredits(audit, paths)[0]?.reason).toBe("unpriced");
  });

  it("blocks a re-quote whose reference rate fell below the reviewed one", () => {
    const paths = new Map([[USDC_KEY, pricedPath("1000000", "3500000")]]);
    const reviewed = { [USDC_KEY]: { sourceAmount: "1000000", destinationAmount: "4000000" } };
    const opts: BatchOptions = { ...directOptions, reviewedReferenceQuotes: reviewed };
    const kinds = allOps(batchClassicDemolition(audit, opts, paths)).map((o) => o.kind);
    expect(kinds).not.toContain("path_payment_strict_send");
    expect(
      unroutableCredits(audit, paths, undefined, undefined, {
        reviewedReferenceQuotes: reviewed,
      })[0]?.reason,
    ).toBe("requote_worse");
  });
});

describe("L-32: amounts are parsed strictly", () => {
  it("rejects more than 7 decimals instead of truncating", () => {
    expect(() => applySlippage("1.12345678")).toThrow(/malformed amount/);
  });

  it("rejects padded input", () => {
    expect(() => applySlippage(" 5")).toThrow(/malformed amount/);
  });
});

// a real envelope for one batch, so the ops the batcher emits are proven to build
function built(batch: ClassicBatch): Transaction {
  return buildClassicTransaction(
    batch,
    new Account(ACC, "100") as unknown as Horizon.AccountResponse,
    TESTNET,
  ).transaction as Transaction;
}

const CB_ID = (n: number): string => "00000000" + n.toString(16).padStart(64, "0");

describe("H-09: claimable balances of untrusted assets are collected with a new trustline", () => {
  const untrusted = (over: Partial<ClaimableBalanceEntry> = {}): ClaimableBalanceEntry =>
    usdcCb(CB_ID(1), "5", { issuerAuthRequired: false, ...over });

  it("opens the trustline and claims in the leading phase, before the merge batch", () => {
    const audit = makeAudit({ balances: [nativeLine("10")], claimableBalances: [untrusted()] });
    const plan = planClaimableBalances(audit, undefined);
    expect(plan.claimed.map((c) => c.id)).toEqual([CB_ID(1)]);
    expect(plan.trustlineChanges).toEqual([{ asset: USDC, change: "add" }]);

    const batches = batchClassicDemolition(audit, directOptions);
    expect(batches.length).toBeGreaterThan(1);
    const lead = batches[0]!.operations;
    expect(lead.map((o) => o.kind)).toEqual(["change_trust_add", "claim_claimable_balance"]);
    expect(lead[0]!.metadata.asset).toEqual(USDC);
    expect(lead[0]!.metadata.limit).toBeUndefined();
    // the merge batch is rebuilt after a re-audit sees the new balance
    const final = batches[batches.length - 1]!.operations;
    expect(final.some(isClaim)).toBe(false);
    expect(final.some(isUsdcRemoval)).toBe(false);

    const tx = built(batches[0]!);
    expect(tx.operations.map((o) => o.type)).toEqual(["changeTrust", "claimClaimableBalance"]);
    expect((tx.operations[0] as { limit: string }).limit).toBe("922337203685.4775807");
  });

  it("asks for a disposal of the collected asset at review", () => {
    const audit = makeAudit({ balances: [nativeLine("10")], claimableBalances: [untrusted()] });
    expect(unroutableCredits(audit, undefined)).toEqual([
      expect.objectContaining({ key: USDC_KEY, amount: "5.0000000", reason: "no_path" }),
    ]);
    expect(unroutableCredits(audit, undefined, [USDC_KEY])).toEqual([]);
  });

  it("leaves the balance behind when the account can't fund the trustline reserve", () => {
    // 1.4 XLM against a 1 XLM minimum: 0.4 free, short of the 0.5 XLM reserve
    const audit = makeAudit({ balances: [nativeLine("1.4")], claimableBalances: [untrusted()] });
    const plan = planClaimableBalances(audit, undefined);
    expect(plan.claimed).toEqual([]);
    expect(plan.leftBehind.map((l) => l.reason)).toEqual(["reserve"]);
    const kinds = allOps(batchClassicDemolition(audit, directOptions)).map((o) => o.kind);
    expect(kinds).not.toContain("change_trust_add");
    expect(kinds).not.toContain("claim_claimable_balance");
  });

  it("counts the reserve once per asset and the fee of the ops it adds", () => {
    const audit = makeAudit({
      balances: [nativeLine("1.6")],
      claimableBalances: [
        untrusted({ id: CB_ID(1) }),
        untrusted({ id: CB_ID(2) }),
        usdcCb(CB_ID(3), "1", {
          asset: { kind: "credit", code: "EURC", issuer: ISSUER },
          issuerAuthRequired: false,
        }),
      ],
    });
    const plan = planClaimableBalances(audit, undefined, { feePerOpStroops: 100 });
    expect(plan.claimed.map((c) => c.id)).toEqual([CB_ID(1), CB_ID(2)]);
    expect(plan.leftBehind.map((l) => [l.balance.id, l.reason])).toEqual([[CB_ID(3), "reserve"]]);
  });

  it("leaves it behind when the issuer requires authorization or is unknown", () => {
    for (const flag of [true, undefined]) {
      const audit = makeAudit({
        balances: [nativeLine("10")],
        claimableBalances: [
          usdcCb(CB_ID(1), "5", flag === undefined ? {} : { issuerAuthRequired: flag }),
        ],
      });
      expect(planClaimableBalances(audit, undefined).leftBehind.map((l) => l.reason)).toEqual([
        "no_trustline",
      ]);
    }
  });

  it("claims a balance of the account's own asset without opening a trustline", () => {
    const own = { kind: "credit", code: "MINE", issuer: ACC } as const;
    const audit = makeAudit({
      balances: [nativeLine("10")],
      // the audit tags the account's own auth_required flag; an issuer never
      // needs a line, and change_trust on its own asset is op_malformed
      claimableBalances: [usdcCb(CB_ID(4), "5", { asset: own, issuerAuthRequired: true })],
    });
    const plan = planClaimableBalances(audit, undefined);
    expect(plan.claimed.map((c) => c.id)).toEqual([CB_ID(4)]);
    expect(plan.trustlineChanges).toEqual([]);
    const ops = allOps(batchClassicDemolition(audit, directOptions));
    expect(ops.map((o) => o.kind)).not.toContain("change_trust_add");
    expect(ops.some(isClaim)).toBe(true);
    expect(unroutableCredits(audit, undefined)).toEqual([]);
  });

  it("raises a full trustline to the maximum limit before claiming into it", () => {
    const audit = makeAudit({
      balances: [nativeLine("10"), usdcLine("5", { limit: "6" })],
      claimableBalances: [usdcCb(CB_ID(5), "3")],
    });
    const plan = planClaimableBalances(audit, undefined);
    expect(plan.claimed.map((c) => c.id)).toEqual([CB_ID(5)]);
    expect(plan.trustlineChanges).toEqual([{ asset: USDC, change: "raise" }]);
    const ops = allOps(batchClassicDemolition(audit, directOptions)).map((o) => o.kind);
    expect(ops.indexOf("change_trust_add")).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf("change_trust_add")).toBeLessThan(ops.indexOf("claim_claimable_balance"));
  });
});

describe("H-13: a frozen balance blocks the classic close", () => {
  it("throws on a positive balance on a deauthorized trustline", () => {
    const audit = makeAudit({ balances: [usdcLine("7", { isAuthorized: false })] });
    const paths = new Map([[USDC_KEY, pricedPath("7", "28")]]);
    expect(() => batchClassicDemolition(audit, directOptions, paths)).toThrow(/FROZEN_TRUSTLINE/);
  });

  it("still removes a zero-balance deauthorized trustline", () => {
    const audit = makeAudit({ balances: [usdcLine("0", { isAuthorized: false })] });
    const ops = allOps(batchClassicDemolition(audit, directOptions));
    expect(ops.some(isUsdcRemoval)).toBe(true);
  });
});

describe("M-52: the merge transaction carries the close marker", () => {
  it("sets then deletes the marker right before the merge, and it builds", () => {
    const audit = makeAudit({ balances: [nativeLine("10")] });
    const batches = batchClassicDemolition(audit, directOptions);
    const final = batches[batches.length - 1]!;
    expect(final.operations.map((o) => [o.kind, o.metadata.action])).toEqual([
      ["close_marker", "set"],
      ["close_marker", "delete"],
      ["account_merge", undefined],
    ]);
    expect(closeMarkerPlanned(batches)).toBe(true);
    const ops = built(final).operations as unknown as {
      type: string;
      name?: string;
      value?: Uint8Array;
    }[];
    expect(ops.map((o) => o.type)).toEqual(["manageData", "manageData", "accountMerge"]);
    expect(ops[0]!.name).toBe(CLOSE_MARKER_NAME);
    expect(Buffer.from(ops[0]!.value!).toString()).toBe(CLOSE_MARKER_VALUE);
    expect(ops[1]!.name).toBe(CLOSE_MARKER_NAME);
    expect(ops[1]!.value).toBeUndefined();
  });

  it("puts the marker before the mediator funding on an exchange close", () => {
    const audit = makeAudit({ balances: [nativeLine("10")] });
    const batches = batchClassicDemolition(audit, {
      destination: DEST,
      useMediator: true,
      mediatorPublicKey: MED,
    });
    expect(batches[batches.length - 1]!.operations.map((o) => o.kind)).toEqual([
      "close_marker",
      "close_marker",
      "create_account_mediator",
      "account_merge",
    ]);
  });

  it("leaves the marker out, and says so, when the account can't spare the reserve", () => {
    const audit = makeAudit({ balances: [nativeLine("1.2")] });
    const batches = batchClassicDemolition(audit, directOptions);
    expect(allOps(batches).map((o) => o.kind)).toEqual(["account_merge"]);
    expect(closeMarkerPlanned(batches)).toBe(false);
  });

  it("counts the fee of every op at the bid it is given", () => {
    const audit = makeAudit({ balances: [nativeLine("1.6")] });
    // at the 0.1 XLM per-op ceiling three ops leave 0.3 XLM, short of 0.5
    expect(closeMarkerPlanned(batchClassicDemolition(audit, directOptions))).toBe(false);
    expect(
      closeMarkerPlanned(batchClassicDemolition(audit, { ...directOptions, feePerOpStroops: 100 })),
    ).toBe(true);
  });
});

describe("M-18: a conversion is bound to the full-size quote the user reviewed", () => {
  const audit = makeAudit({ balances: [usdcLine("1000000")] });
  const reviewed = { [USDC_KEY]: { sourceAmount: "1000000", destinationAmount: "3694000" } };
  const quoted = (destinationAmount: string): Map<string, PathResultRef> =>
    new Map([
      [
        USDC_KEY,
        {
          sourceAmount: "1000000",
          destinationAmount,
          path: [],
          reference: { sourceAmount: "100", destinationAmount: "441.6" },
        },
      ],
    ]);
  const opts: BatchOptions = {
    ...directOptions,
    acceptedPriceImpactAssetKeys: [USDC_KEY],
    reviewedConversionQuotes: reviewed,
  };

  it("refuses an accepted conversion whose full-size quote collapsed after review", () => {
    // the reference is unchanged, but selling the whole balance now returns 3%
    const paths = quoted("110820");
    const kinds = allOps(batchClassicDemolition(audit, opts, paths)).map((o) => o.kind);
    expect(kinds).not.toContain("path_payment_strict_send");
    expect(
      unroutableCredits(audit, paths, undefined, undefined, {
        acceptedPriceImpactAssetKeys: [USDC_KEY],
        reviewedConversionQuotes: reviewed,
      })[0]?.reason,
    ).toBe("requote_worse");
  });

  it("still sells within the slippage tolerance of the reviewed quote", () => {
    const kinds = allOps(batchClassicDemolition(audit, opts, quoted("3680000"))).map((o) => o.kind);
    expect(kinds).toContain("path_payment_strict_send");
  });
});
