import { describe, it, expect } from "vitest";
import {
  Asset,
  AuthRequiredFlag,
  AuthRevocableFlag,
  BASE_FEE,
  Claimant,
  getLiquidityPoolId,
  Keypair,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  Operation,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  assessMergeability,
  auditAccount,
  collectableClaimableBalanceIds,
} from "@/lib/stellar/account-audit";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { DEFAULT_TX_VALIDITY_SECONDS, fetchLedgerClock } from "@/lib/stellar/ledger-clock";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { planClaimableBalances } from "@/lib/plan/classic-batcher";
import type { BatchedOperation } from "@/lib/types/plan";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { TESTNET } from "@/lib/config/networks";
import { fundWithFriendbot } from "../helpers/friendbot";

// live testnet checks that the audit's merge verdicts match what core actually
// does: each blocked case also submits the merge and expects the matching
// on-chain failure code.

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  await fundWithFriendbot(pk);
}

async function submitAs(kp: Keypair, ops: readonly xdr.Operation[]): Promise<void> {
  const account = await server.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(120).build();
  tx.sign(kp);
  await server.submitTransaction(tx, { skipMemoRequiredCheck: true });
}

// submit a bare merge and return horizon's operation result codes
async function mergeResultCodes(kp: Keypair, destination: string): Promise<unknown> {
  try {
    await submitAs(kp, [Operation.accountMerge({ destination })]);
    return "success";
  } catch (err) {
    const e = err as { response?: { data?: { extras?: { result_codes?: unknown } } } };
    return e.response?.data?.extras?.result_codes;
  }
}

describe("integration: audit merge verdicts (testnet)", () => {
  it("blocks a sponsoring account that also holds data entries (op_is_sponsor)", async () => {
    const kp = Keypair.random();
    const other = Keypair.random();
    await friendbotFund(kp.publicKey());
    await friendbotFund(other.publicKey());

    // a claimable balance created for someone else is sponsored by its creator
    await submitAs(kp, [
      Operation.manageData({ name: "k1", value: "v1" }),
      Operation.manageData({ name: "k2", value: "v2" }),
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: "1",
        claimants: [new Claimant(other.publicKey(), Claimant.predicateUnconditional())],
      }),
    ]);

    const audit = await auditAccount(kp.publicKey(), TESTNET);
    expect(audit.sponsorship.numSponsoring).toBe(1);
    expect(audit.data).toHaveLength(2);
    expect(audit.sponsorship.coverable).toBe(0);
    expect(
      assessMergeability(audit, {
        ledger: audit.ledger,
        claimedBalanceIds: [],
        transactionsBeforeMerge: 2,
      }),
    ).toMatchObject({ mergeable: false, reason: "IS_SPONSOR" });

    // clear the data entries so the only obstacle left is the sponsorship
    await submitAs(kp, [
      Operation.manageData({ name: "k1", value: null }),
      Operation.manageData({ name: "k2", value: null }),
    ]);
    expect(await mergeResultCodes(kp, other.publicKey())).toMatchObject({
      operations: ["op_is_sponsor"],
    });
  });

  it("treats a self-claimable balance as released only when it is claimed", async () => {
    const kp = Keypair.random();
    await friendbotFund(kp.publicKey());
    await submitAs(kp, [
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: "1",
        claimants: [new Claimant(kp.publicKey(), Claimant.predicateUnconditional())],
      }),
    ]);
    const audit = await auditAccount(kp.publicKey(), TESTNET);
    const own = audit.claimableBalances.find((c) => c.sponsor === kp.publicKey());
    expect(own?.claimableNow).toBe(true);
    const claimed = planClaimableBalances(audit, []).claimed.map((c) => c.id);
    expect(claimed).toEqual([own?.id]);
    const opts = { ledger: audit.ledger, transactionsBeforeMerge: 1 };
    expect(assessMergeability(audit, { ...opts, claimedBalanceIds: claimed })).toEqual({
      mergeable: true,
    });
    expect(assessMergeability(audit, { ...opts, claimedBalanceIds: [] })).toMatchObject({
      mergeable: false,
      reason: "IS_SPONSOR",
    });
  });

  it("blocks a positive balance frozen by its issuer and does not path it", async () => {
    const issuer = Keypair.random();
    const holder = Keypair.random();
    await friendbotFund(issuer.publicKey());
    await friendbotFund(holder.publicKey());

    const frz = new Asset("FRZ", issuer.publicKey());
    await submitAs(issuer, [Operation.setOptions({ setFlags: AuthRevocableFlag })]);
    await submitAs(holder, [Operation.changeTrust({ asset: frz })]);
    // an xlm market for FRZ so a path would exist if the freeze were ignored
    await submitAs(issuer, [
      Operation.payment({ destination: holder.publicKey(), asset: frz, amount: "100" }),
      Operation.manageBuyOffer({
        selling: Asset.native(),
        buying: frz,
        buyAmount: "1000",
        price: "1",
      }),
    ]);
    await submitAs(issuer, [
      Operation.setTrustLineFlags({
        trustor: holder.publicKey(),
        asset: frz,
        flags: { authorized: false },
      }),
    ]);

    const audit = await auditAccount(holder.publicKey(), TESTNET);
    const line = audit.balances.find((b) => b.asset.kind === "credit");
    expect(line?.isAuthorized).toBe(false);
    const verdict = assessMergeability(audit, {
      ledger: audit.ledger,
      claimedBalanceIds: [],
      transactionsBeforeMerge: 1,
    });
    expect(verdict).toMatchObject({ mergeable: false, reason: "FROZEN_TRUSTLINE" });

    const paths = await resolveCreditPaths(audit, TESTNET);
    expect(paths.size).toBe(0);

    // on chain the frozen balance cannot be sold
    await expect(
      submitAs(holder, [
        Operation.pathPaymentStrictSend({
          sendAsset: frz,
          sendAmount: "100",
          destination: holder.publicKey(),
          destAsset: Asset.native(),
          destMin: "0.0000001",
          path: [],
        }),
      ]),
    ).rejects.toMatchObject({
      response: { data: { extras: { result_codes: { operations: ["op_src_not_authorized"] } } } },
    });
  });

  it("evaluates far-future abs_before balances as claimable, and not() of them as not", async () => {
    const kp = Keypair.random();
    await friendbotFund(kp.publicKey());
    const int64Max = "9223372036854775807";
    const year10000 = "253402300800";
    await submitAs(kp, [
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: "1",
        claimants: [new Claimant(kp.publicKey(), Claimant.predicateBeforeAbsoluteTime(int64Max))],
      }),
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: "2",
        claimants: [new Claimant(kp.publicKey(), Claimant.predicateBeforeAbsoluteTime(year10000))],
      }),
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: "3",
        claimants: [
          new Claimant(
            kp.publicKey(),
            Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(year10000)),
          ),
        ],
      }),
    ]);

    const audit = await auditAccount(kp.publicKey(), TESTNET);
    const byAmount = new Map(
      audit.claimableBalances.map((c) => [Number.parseFloat(c.amount), c.claimableNow]),
    );
    expect(byAmount.get(1)).toBe(true);
    expect(byAmount.get(2)).toBe(true);
    expect(byAmount.get(3)).toBe(false);
    // all three are self-sponsored, the not() one cannot be claimed
    expect(audit.sponsorship.numSponsoring).toBe(3);
    expect(audit.sponsorship.coverable).toBe(2);
  });

  it("blocks an account whose sequence was bumped past the merge ceiling", async () => {
    const kp = Keypair.random();
    const dest = Keypair.random();
    await friendbotFund(kp.publicKey());
    await friendbotFund(dest.publicKey());
    const latest = await server.ledgers().order("desc").limit(1).call();
    const far = (BigInt(latest.records[0]!.sequence) + 100_000n) << 32n;
    await submitAs(kp, [Operation.bumpSequence({ bumpTo: far.toString() })]);

    const audit = await auditAccount(kp.publicKey(), TESTNET);
    const verdict = assessMergeability(audit, {
      ledger: audit.ledger,
      claimedBalanceIds: [],
      transactionsBeforeMerge: 1,
    });
    expect(verdict).toMatchObject({ mergeable: false, reason: "SEQNUM_TOO_FAR" });
    expect(await mergeResultCodes(kp, dest.publicKey())).toMatchObject({
      operations: ["op_seq_num_too_far"],
    });
  });

  // a claimable balance of an untrusted asset: claimable after change_trust_add
  // when the issuer does not require authorization, never when it does
  it("tags untrusted claimable balances by issuer auth and collects the open one", async () => {
    const holder = Keypair.random();
    const open = Keypair.random();
    const gated = Keypair.random();
    await friendbotFund(holder.publicKey());
    await friendbotFund(open.publicKey());
    await friendbotFund(gated.publicKey());
    await submitAs(gated, [Operation.setOptions({ setFlags: AuthRequiredFlag })]);

    const openAsset = new Asset("OPEN", open.publicKey());
    const gatedAsset = new Asset("GATED", gated.publicKey());
    for (const [issuer, asset] of [
      [open, openAsset],
      [gated, gatedAsset],
    ] as const) {
      await submitAs(issuer, [
        Operation.createClaimableBalance({
          asset,
          amount: "5",
          claimants: [new Claimant(holder.publicKey(), Claimant.predicateUnconditional())],
        }),
      ]);
    }

    const audit = await auditAccount(holder.publicKey(), TESTNET);
    const byCode = new Map(
      audit.claimableBalances.map((c) => [c.asset.kind === "credit" ? c.asset.code : "", c]),
    );
    expect(byCode.get("OPEN")?.issuerAuthRequired).toBe(false);
    expect(byCode.get("GATED")?.issuerAuthRequired).toBe(true);

    // the gated one: the trustline is added but the claim is refused
    const claimOf = (id: string): BatchedOperation => ({
      kind: "claim_claimable_balance",
      summary: "claim",
      metadata: { balanceId: id },
    });
    const addLine = (asset: Asset): BatchedOperation =>
      ({
        kind: "change_trust_add",
        summary: "add trustline",
        metadata: { asset: { kind: "credit", code: asset.code, issuer: asset.issuer } },
      }) as unknown as BatchedOperation;
    const submitBatch = async (operations: BatchedOperation[]): Promise<void> => {
      const source = await server.loadAccount(holder.publicKey());
      const clock = await fetchLedgerClock(TESTNET);
      const built = buildClassicTransaction(
        { operations, destination: holder.publicKey() },
        source,
        TESTNET,
        Number(BASE_FEE),
        DEFAULT_TX_VALIDITY_SECONDS,
        clock.closedAt,
      );
      const tx = built.transaction as Transaction;
      tx.sign(holder);
      await server.submitTransaction(tx, { skipMemoRequiredCheck: true });
    };
    await expect(
      submitBatch([addLine(gatedAsset), claimOf(byCode.get("GATED")!.id)]),
    ).rejects.toMatchObject({
      response: {
        data: { extras: { result_codes: { operations: ["op_success", "op_not_authorized"] } } },
      },
    });

    await submitBatch([addLine(openAsset), claimOf(byCode.get("OPEN")!.id)]);
    const after = await auditAccount(holder.publicKey(), TESTNET);
    const line = after.balances.find((b) => b.asset.kind === "credit" && b.asset.code === "OPEN");
    expect(line?.amount).toBe("5.0000000");
    expect(after.claimableBalances.map((c) => c.id)).toEqual([byCode.get("GATED")!.id]);
  });

  // the closing account issued the asset: it claims the balance with no trustline
  // even with auth_required set, and change_trust on its own asset is op_malformed
  it("collects a balance of the account's own asset directly", async () => {
    const issuer = Keypair.random();
    const holder = Keypair.random();
    await friendbotFund(issuer.publicKey());
    await friendbotFund(holder.publicKey());
    const own = new Asset("OWN", issuer.publicKey());
    await submitAs(holder, [Operation.changeTrust({ asset: own })]);
    await submitAs(issuer, [
      Operation.payment({ destination: holder.publicKey(), asset: own, amount: "10" }),
      Operation.setOptions({ setFlags: AuthRequiredFlag }),
    ]);
    await submitAs(holder, [
      Operation.createClaimableBalance({
        asset: own,
        amount: "5",
        claimants: [new Claimant(issuer.publicKey(), Claimant.predicateUnconditional())],
      }),
    ]);

    const audit = await auditAccount(issuer.publicKey(), TESTNET);
    expect(audit.flags.authRequired).toBe(true);
    expect(audit.claimableBalances).toHaveLength(1);
    const cb = audit.claimableBalances[0]!;
    expect(cb).toMatchObject({ issuedByAccount: true, claimableNow: true });
    expect(cb).not.toHaveProperty("issuerAuthRequired");

    const source = await server.loadAccount(issuer.publicKey());
    const built = buildClassicTransaction(
      {
        operations: [
          { kind: "claim_claimable_balance", summary: "claim", metadata: { balanceId: cb.id } },
        ],
        destination: issuer.publicKey(),
      },
      source,
      TESTNET,
      Number(BASE_FEE),
      DEFAULT_TX_VALIDITY_SECONDS,
      audit.ledger.closedAt,
    );
    const tx = built.transaction as Transaction;
    tx.sign(issuer);
    await server.submitTransaction(tx, { skipMemoRequiredCheck: true });
    const after = await auditAccount(issuer.publicKey(), TESTNET);
    expect(after.claimableBalances).toEqual([]);
  });

  // the close withdraws pool shares before it claims, in one transaction. the
  // withdraw credits the reserve asset's trustline, so on a custom limit it uses
  // up the room a same-asset claim was counted against
  it("counts a pool withdraw against a custom trustline limit before a claim", async () => {
    const issuer = Keypair.random();
    const holder = Keypair.random();
    await friendbotFund(issuer.publicKey());
    await friendbotFund(holder.publicKey());
    const cap = new Asset("CAP", issuer.publicKey());
    const poolAsset = new LiquidityPoolAsset(Asset.native(), cap, LiquidityPoolFeeV18);
    const poolId = Buffer.from(
      getLiquidityPoolId("constant_product", poolAsset.getLiquidityPoolParameters()),
    ).toString("hex");
    await submitAs(holder, [Operation.changeTrust({ asset: cap, limit: "100" })]);
    await submitAs(issuer, [
      Operation.payment({ destination: holder.publicKey(), asset: cap, amount: "70" }),
      Operation.createClaimableBalance({
        asset: cap,
        amount: "50",
        claimants: [new Claimant(holder.publicKey(), Claimant.predicateUnconditional())],
      }),
    ]);
    await submitAs(holder, [
      Operation.changeTrust({ asset: poolAsset }),
      Operation.liquidityPoolDeposit({
        liquidityPoolId: poolId,
        maxAmountA: "30",
        maxAmountB: "30",
        minPrice: "0.9",
        maxPrice: "1.1",
      }),
    ]);

    const audit = await auditAccount(holder.publicKey(), TESTNET);
    const capLine = audit.balances.find((b) => b.asset.kind === "credit");
    expect(capLine).toMatchObject({ amount: "40.0000000", limit: "100.0000000" });
    expect(audit.poolShares).toHaveLength(1);
    const cb = audit.claimableBalances[0]!;
    // 60 of room before the withdraw, 30 after it: the 50 does not fit
    expect(
      collectableClaimableBalanceIds(audit.balances, audit.claimableBalances, audit.poolShares),
    ).toEqual([]);

    const shares = audit.poolShares[0]!.shareBalance;
    await expect(
      submitAs(holder, [
        Operation.liquidityPoolWithdraw({
          liquidityPoolId: poolId,
          amount: shares,
          minAmountA: "0",
          minAmountB: "0",
        }),
        Operation.claimClaimableBalance({ balanceId: cb.id }),
      ]),
    ).rejects.toMatchObject({
      response: {
        data: { extras: { result_codes: { operations: ["op_success", "op_line_full"] } } },
      },
    });
  });
});
