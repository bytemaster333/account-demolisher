import { describe, it, expect } from "vitest";
import {
  Address,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";

import {
  BackstopClaimUnavailableError,
  BlndTrustlineMissingError,
  buildBackstopClaimTx,
  buildBackstopQueueTx,
  buildBackstopWithdrawTx,
  buildBlendClaimTx,
  buildBlendRepayTx,
  buildBlendWithdrawTx,
  buildExitSequence,
  type BuildExitSequenceDeps,
} from "@/lib/adapters/blend/exit";
import type {
  BackstopDepositLoader,
  BackstopUserState,
  BlendUserPositions,
} from "@/lib/adapters/blend/client";
import {
  BACKSTOP_QUEUE_DURATION_SECONDS,
  BACKSTOP_V1_QUEUE_DURATION_SECONDS,
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_V1_MAINNET_ID,
  I128_MAX,
  blndTokenForNetwork,
} from "@/lib/adapters/blend/constants";
import { MAINNET } from "@/lib/config/networks";

import { horizonAccount, loaderFor, makePool, supplyEmissions } from "./blend-fixtures";

const USER = Keypair.random().publicKey();
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const XLM_SAC = Asset.native().contractId(MAINNET.passphrase);
const USDC_SAC = new Asset("USDC", USDC_ISSUER).contractId(MAINNET.passphrase);
const BLND = blndTokenForNetwork(MAINNET);

// registry pools: FixedV2 (v2, v2 backstop) and Fixed (v1, v1 backstop)
const POOL_V2 = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const POOL_V1 = "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";

const V2_RATE_1 = 10n ** 12n;
const V1_RATE_1 = 10n ** 9n;

// prepareTransaction stand-in: no RPC; returns the built tx unchanged
const assemble = async (
  _server: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
): Promise<Transaction | FeeBumpTransaction> => tx;

// prepareTransaction stand-in that charges a resource fee like a real
// simulation would, so the native-repay fee headroom is exercised
function assembleWithFee(totalFee: string) {
  return async (_server: rpc.Server, tx: Transaction | FeeBumpTransaction) => {
    const inner = tx as Transaction;
    return TransactionBuilder.cloneFrom(inner, { fee: totalFee }).build();
  };
}

function account(balances: Parameters<typeof horizonAccount>[0]["balances"], subentryCount = 0) {
  return horizonAccount({ accountId: USER, sequence: "1000", balances, subentryCount });
}

function deps(extra: Partial<BuildExitSequenceDeps> = {}): BuildExitSequenceDeps {
  return { assemble, server: {} as rpc.Server, ...extra };
}

// the shape hydration synthesizes for one plan node: every position is labelled
// "V2" and carries a placeholder amount, so the builders must read the truth
function hydrationPosition(
  poolId: string,
  buckets: { liabilities?: string; collateral?: string } = {},
): BlendUserPositions {
  return {
    poolId,
    poolName: poolId,
    poolVersion: "V2",
    liabilities: new Map(buckets.liabilities ? [[buckets.liabilities, 1n]] : []),
    collateral: new Map(buckets.collateral ? [[buckets.collateral, 1n]] : []),
    supply: new Map(),
    emissions: new Map(),
  };
}

interface DecodedRequest {
  readonly address: string;
  readonly amount: bigint;
  readonly request_type: number;
}

function invocation(tx: Transaction): { contract: string; fn: string; args: xdr.ScVal[] } {
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction") throw new Error("not a host function op");
  const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
  return {
    contract: Address.fromScAddress(call.contractAddress).toString(),
    fn: call.functionName.toString(),
    args: call.args,
  };
}

function submitRequest(tx: Transaction): DecodedRequest {
  const { fn, args } = invocation(tx);
  expect(fn).toBe("submit");
  const requests = scValToNative(args[3]!) as DecodedRequest[];
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe("Blend repay amount (H-22)", () => {
  const pool = () =>
    makePool({
      version: "V2",
      poolId: POOL_V2,
      backstop: BLEND_BACKSTOP_MAINNET_ID,
      // dRate 1.2: 100 dTokens owe 120 underlying
      reserves: [{ assetId: USDC_SAC, index: 0, dRate: (V2_RATE_1 * 12n) / 10n, bRate: V2_RATE_1 }],
      user: { liabilities: [[0, 100_0000000n]] },
    });

  it("repays the buffered underlying debt, never i128::MAX", async () => {
    const built = await buildBlendRepayTx(
      MAINNET,
      { poolId: POOL_V2, asset: USDC_SAC },
      USER,
      account([
        { balance: "50.0000000" },
        { code: "USDC", issuer: USDC_ISSUER, balance: "500.0000000" },
      ]),
      deps({ poolLoader: loaderFor(pool()) }),
    );
    expect(built.debt).toBe(120_0000000n);
    const req = submitRequest(built.transaction);
    expect(req.request_type).toBe(5);
    expect(req.amount).toBe(built.amount);
    // debt plus a 10 bps accrual buffer, rounded up
    expect(req.amount).toBe(120_1200000n);
    expect(req.amount).toBeLessThan(2n ** 63n);
  });

  it("buildExitSequence (the hydration entry point) repays a finite amount", async () => {
    const steps = await buildExitSequence(
      MAINNET,
      hydrationPosition(POOL_V2, { liabilities: USDC_SAC }),
      USER,
      account([
        { balance: "50.0000000" },
        { code: "USDC", issuer: USDC_ISSUER, balance: "500.0000000" },
      ]),
      deps({ poolLoader: loaderFor(pool()) }),
    );
    const step = steps.find((s) => s.kind === "repay");
    if (!step || step.kind !== "repay") throw new Error("missing repay step");
    const amount = submitRequest(step.transaction).amount;
    expect(amount).toBeLessThan(2n ** 63n);
    expect(amount).toBe(120_1200000n);
  });

  it("caps the repay at the spendable balance of the borrowed asset", async () => {
    const built = await buildBlendRepayTx(
      MAINNET,
      { poolId: POOL_V2, asset: USDC_SAC },
      USER,
      account([
        { balance: "50.0000000" },
        // 120.05 held, 0.01 locked in an open offer
        {
          code: "USDC",
          issuer: USDC_ISSUER,
          balance: "120.0500000",
          sellingLiabilities: "0.0100000",
        },
      ]),
      deps({ poolLoader: loaderFor(pool()) }),
    );
    expect(submitRequest(built.transaction).amount).toBe(120_0400000n);
  });

  it("refuses to build when the account holds none of the borrowed asset", async () => {
    await expect(
      buildBlendRepayTx(
        MAINNET,
        { poolId: POOL_V2, asset: USDC_SAC },
        USER,
        account([
          { balance: "50.0000000" },
          { code: "USDC", issuer: USDC_ISSUER, balance: "0.0000000" },
        ]),
        deps({ poolLoader: loaderFor(pool()) }),
      ),
    ).rejects.toThrow(/no spendable/);
  });

  it("keeps a native repay above the minimum reserve and the transaction fee", async () => {
    const xlmPool = makePool({
      version: "V2",
      poolId: POOL_V2,
      backstop: BLEND_BACKSTOP_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V2_RATE_1, bRate: V2_RATE_1 }],
      user: { liabilities: [[0, 120_0000000n]] },
    });
    // 121 XLM, no subentries: 1 XLM reserve, 0.5 XLM fee -> 119.5 can go to the pool
    const source = account([{ balance: "121.0000000" }]);
    const built = await buildBlendRepayTx(
      MAINNET,
      { poolId: POOL_V2, asset: XLM_SAC },
      USER,
      source,
      deps({ poolLoader: loaderFor(xlmPool), assemble: assembleWithFee("5000000") }),
    );
    expect(submitRequest(built.transaction).amount).toBe(119_5000000n);
    expect(built.transaction.fee).toBe("5000000");
    // the caller's account is not advanced by the two builds
    expect(source.sequenceNumber()).toBe("1000");
    expect(built.transaction.sequence).toBe("1001");
  });

  it("subtracts the reserve for subentries and sponsorships", async () => {
    const xlmPool = makePool({
      version: "V2",
      poolId: POOL_V2,
      backstop: BLEND_BACKSTOP_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V2_RATE_1, bRate: V2_RATE_1 }],
      user: { liabilities: [[0, 200_0000000n]] },
    });
    const source = horizonAccount({
      accountId: USER,
      sequence: "7",
      balances: [{ balance: "100.0000000", sellingLiabilities: "3.0000000" }],
      subentryCount: 3,
      numSponsoring: 1,
      numSponsored: 2,
    });
    const built = await buildBlendRepayTx(
      MAINNET,
      { poolId: POOL_V2, asset: XLM_SAC },
      USER,
      source,
      deps({ poolLoader: loaderFor(xlmPool) }),
    );
    // reserve (2 + 3 + 1 - 2) * 0.5 = 2 XLM, liabilities 3 XLM, fee 0.01 XLM
    expect(submitRequest(built.transaction).amount).toBe(94_9900000n);
  });
});

describe("Blend v1 pools get finite request amounts (H-23)", () => {
  const v1Pool = () =>
    makePool({
      version: "V1",
      poolId: POOL_V1,
      backstop: BLEND_BACKSTOP_V1_MAINNET_ID,
      reserves: [
        // bRate 1.05, dRate 1.1
        {
          assetId: XLM_SAC,
          index: 0,
          dRate: (V1_RATE_1 * 11n) / 10n,
          bRate: (V1_RATE_1 * 105n) / 100n,
        },
        { assetId: USDC_SAC, index: 1, dRate: V1_RATE_1, bRate: V1_RATE_1 },
      ],
      user: {
        collateral: [[0, 1000_0000000n]],
        supply: [[1, 10_0000000n]],
        liabilities: [[1, 5_0000000n]],
      },
    });

  it("withdraws collateral with the buffered underlying amount", async () => {
    const built = await buildBlendWithdrawTx(
      MAINNET,
      { poolId: POOL_V1, asset: XLM_SAC, bucket: "collateral" },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({ poolLoader: loaderFor(v1Pool()) }),
    );
    const req = submitRequest(built.transaction);
    expect(req.request_type).toBe(3);
    // 1000 bTokens * 1.05 = 1050, plus 10 bps
    expect(req.amount).toBe(1051_0500000n);
    expect(req.amount).toBeLessThan(2n ** 63n);
  });

  it("withdraws supply with a finite amount", async () => {
    const built = await buildBlendWithdrawTx(
      MAINNET,
      { poolId: POOL_V1, asset: USDC_SAC, bucket: "supply" },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({ poolLoader: loaderFor(v1Pool()) }),
    );
    const req = submitRequest(built.transaction);
    expect(req.request_type).toBe(1);
    expect(req.amount).toBe(10_0100000n);
  });

  it("repays a v1 loan with a finite amount", async () => {
    const built = await buildBlendRepayTx(
      MAINNET,
      { poolId: POOL_V1, asset: USDC_SAC },
      USER,
      account([
        { balance: "10.0000000" },
        { code: "USDC", issuer: USDC_ISSUER, balance: "100.0000000" },
      ]),
      deps({ poolLoader: loaderFor(v1Pool()) }),
    );
    expect(submitRequest(built.transaction).amount).toBe(5_0050000n);
  });

  it("keeps i128::MAX for v2 withdrawals, which the v2 pool caps", async () => {
    const v2 = makePool({
      version: "V2",
      poolId: POOL_V2,
      backstop: BLEND_BACKSTOP_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V2_RATE_1, bRate: V2_RATE_1 }],
      user: { collateral: [[0, 10n]] },
    });
    const built = await buildBlendWithdrawTx(
      MAINNET,
      { poolId: POOL_V2, asset: XLM_SAC, bucket: "collateral" },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({ poolLoader: loaderFor(v2) }),
    );
    expect(submitRequest(built.transaction).amount).toBe(I128_MAX);
  });

  it("buildExitSequence decides the version from chain, not from the caller's label", async () => {
    // hydration labels every synthesized position "V2"; the pool on chain is v1
    const steps = await buildExitSequence(
      MAINNET,
      hydrationPosition(POOL_V1, { collateral: XLM_SAC }),
      USER,
      account([{ balance: "10.0000000" }]),
      deps({ poolLoader: loaderFor(v1Pool()) }),
    );
    expect(steps.map((s) => s.kind)).toEqual(["withdraw_collateral"]);
    const step = steps[0]!;
    if (step.kind !== "withdraw_collateral") throw new Error("unreachable");
    expect(submitRequest(step.transaction).amount).toBe(1051_0500000n);
  });
});

function backstopLoader(state: Partial<BackstopUserState>): BackstopDepositLoader {
  return {
    async loadUser() {
      return {
        shares: 0n,
        totalQ4W: 0n,
        unlockedQ4W: 0n,
        accruedEmissions: 0n,
        ...state,
      };
    },
  };
}

// simulate stand-ins for the backstop claim probe
function simulateMint(lpOut: bigint): NonNullable<BuildExitSequenceDeps["simulate"]> {
  return async () => ({
    ok: true,
    retval: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: lpOut })),
    transactionData: undefined as never,
    minResourceFee: "0",
    auth: [],
    latestLedger: 1,
  });
}

// what mainnet rpc returned on 2026-10-06 for every backstop claim: the
// BLND-USDC comet traps inside dep_tokn_amt_in_get_lp_tokns_out
const COMET_TRAP = "HostError: Error(WasmVm, InvalidAction)";
const simulateTrap: NonNullable<BuildExitSequenceDeps["simulate"]> = async () => ({
  ok: false,
  error: COMET_TRAP,
  diagnostic: [],
  latestLedger: 1,
});

describe("Blend backstop exits target the pool's own backstop (C-07)", () => {
  const v1Pool = () =>
    makePool({
      version: "V1",
      poolId: POOL_V1,
      backstop: BLEND_BACKSTOP_V1_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V1_RATE_1, bRate: V1_RATE_1 }],
    });

  it("queues every current share on the v1 backstop with the v1 21-day lock", async () => {
    const now = new Date(Date.UTC(2026, 9, 2));
    const built = await buildBackstopQueueTx(
      MAINNET,
      { poolId: POOL_V1 },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v1Pool()),
        backstopLoader: backstopLoader({ shares: 35_126_739_517n }),
        now: () => now,
      }),
    );
    const { contract, fn, args } = invocation(built.transaction);
    expect(contract).toBe(BLEND_BACKSTOP_V1_MAINNET_ID);
    expect(fn).toBe("queue_withdrawal");
    expect(scValToNative(args[1]!)).toBe(POOL_V1);
    expect(scValToNative(args[2]!)).toBe(35_126_739_517n);
    expect(built.backstop.version).toBe("V1");
    expect(built.queueEndsAt.getTime()).toBe(
      now.getTime() + BACKSTOP_V1_QUEUE_DURATION_SECONDS * 1000,
    );
    expect(BACKSTOP_V1_QUEUE_DURATION_SECONDS).toBe(21 * 24 * 60 * 60);
  });

  it("withdraws the unlocked queue from the pool's backstop", async () => {
    const built = await buildBackstopWithdrawTx(
      MAINNET,
      { poolId: POOL_V1 },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v1Pool()),
        backstopLoader: backstopLoader({ totalQ4W: 500n, unlockedQ4W: 300n }),
      }),
    );
    const { contract, fn, args } = invocation(built.transaction);
    expect(contract).toBe(BLEND_BACKSTOP_V1_MAINNET_ID);
    expect(fn).toBe("withdraw");
    expect(scValToNative(args[2]!)).toBe(300n);
  });

  it("refuses a pool whose metadata names an unknown backstop", async () => {
    const rogue = makePool({
      version: "V2",
      poolId: POOL_V2,
      backstop: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V2_RATE_1, bRate: V2_RATE_1 }],
    });
    await expect(
      buildBackstopQueueTx(
        MAINNET,
        { poolId: POOL_V2 },
        USER,
        account([{ balance: "10.0000000" }]),
        deps({ poolLoader: loaderFor(rogue), backstopLoader: backstopLoader({ shares: 5n }) }),
      ),
    ).rejects.toThrow(/not a known Blend backstop/);
  });

  it("buildExitSequence queues on the v1 backstop for a v1 pool", async () => {
    const steps = await buildExitSequence(
      MAINNET,
      hydrationPosition(POOL_V1),
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v1Pool()),
        backstopLoader: backstopLoader({ shares: 42n }),
        backstopShares: 42n,
      }),
    );
    const step = steps.find((s) => s.kind === "backstop_queue_withdrawal");
    if (!step || step.kind !== "backstop_queue_withdrawal") throw new Error("missing step");
    expect(invocation(step.transaction).contract).toBe(BLEND_BACKSTOP_V1_MAINNET_ID);
    expect(step.shares).toBe(42n);
  });

  it("buildExitSequence claims backstop emissions before the queue, then withdraws the unlocked part (L-49, M-25)", async () => {
    const steps = await buildExitSequence(
      MAINNET,
      hydrationPosition(POOL_V1),
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v1Pool()),
        backstopLoader: backstopLoader({
          shares: 42n,
          totalQ4W: 500n,
          unlockedQ4W: 300n,
          accruedEmissions: 7n,
        }),
        simulate: simulateMint(1n),
        claimBackstopEmissions: true,
        backstopShares: 42n,
        backstopWithdrawAmount: 1n,
      }),
    );
    expect(steps.map((s) => s.kind)).toEqual([
      "backstop_claim_emissions",
      "backstop_queue_withdrawal",
      "backstop_withdraw",
    ]);
    const calls = steps.map((s) => invocation(s.transaction));
    expect(calls.map((c) => [c.contract, c.fn])).toEqual([
      [BLEND_BACKSTOP_V1_MAINNET_ID, "claim"],
      [BLEND_BACKSTOP_V1_MAINNET_ID, "queue_withdrawal"],
      [BLEND_BACKSTOP_V1_MAINNET_ID, "withdraw"],
    ]);
    const withdraw = steps[2];
    if (withdraw?.kind !== "backstop_withdraw") throw new Error("missing withdraw step");
    // the amount is what is unlocked on chain now, not the planned figure
    expect(withdraw.amount).toBe(300n);
    expect(scValToNative(calls[2]!.args[2]!)).toBe(300n);
  });

  it("buildExitSequence builds only the backstop withdraw for a fully queued deposit (M-25)", async () => {
    const steps = await buildExitSequence(
      MAINNET,
      hydrationPosition(POOL_V1),
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v1Pool()),
        backstopLoader: backstopLoader({ totalQ4W: 300n, unlockedQ4W: 300n }),
        backstopWithdrawAmount: 300n,
      }),
    );
    expect(steps.map((s) => s.kind)).toEqual(["backstop_withdraw"]);
  });

  it("uses the 17-day lock for the v2 backstop", async () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const v2 = makePool({
      version: "V2",
      poolId: POOL_V2,
      backstop: BLEND_BACKSTOP_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V2_RATE_1, bRate: V2_RATE_1 }],
    });
    const built = await buildBackstopQueueTx(
      MAINNET,
      { poolId: POOL_V2 },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v2),
        backstopLoader: backstopLoader({ shares: 9n }),
        now: () => now,
      }),
    );
    expect(invocation(built.transaction).contract).toBe(BLEND_BACKSTOP_MAINNET_ID);
    expect(built.queueEndsAt.getTime()).toBe(
      now.getTime() + BACKSTOP_QUEUE_DURATION_SECONDS * 1000,
    );
  });
});

describe("Blend emissions claims (M-26, L-49)", () => {
  // user index 0, reserve index 2e14 on 50 bTokens: 100 BLND accrued (7 decimals)
  const emissionsPool = () =>
    makePool({
      version: "V2",
      poolId: POOL_V2,
      backstop: BLEND_BACKSTOP_MAINNET_ID,
      reserves: [
        {
          assetId: XLM_SAC,
          index: 0,
          dRate: V2_RATE_1,
          bRate: V2_RATE_1,
          supplyEmissions: supplyEmissions(2n * 10n ** 14n),
        },
      ],
      user: { supply: [[0, 50_0000000n]], emissions: [[1, 0n, 0n]] },
    });

  it("refuses to claim accrued BLND without a BLND trustline, naming the fix", async () => {
    const err: unknown = await buildBlendClaimTx(
      MAINNET,
      { poolId: POOL_V2 },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({ poolLoader: loaderFor(emissionsPool()) }),
    ).catch((e: unknown) => e);
    // a typed error, so hydration can tell "trustline not opened yet" apart
    // from a broken claim and build the node after the change_trust step
    expect(err).toBeInstanceOf(BlndTrustlineMissingError);
    expect((err as BlndTrustlineMissingError).reason).toBe("missing");
    expect((err as BlndTrustlineMissingError).poolId).toBe(POOL_V2);
    expect((err as Error).message).toMatch(/BLND trustline/);
  });

  it("refuses to claim into a BLND trustline the issuer has not authorized", async () => {
    const err: unknown = await buildBlendClaimTx(
      MAINNET,
      { poolId: POOL_V2 },
      USER,
      account([
        { balance: "10.0000000" },
        { code: "BLND", issuer: BLND.issuer, balance: "0.0000000", authorized: false },
      ]),
      deps({ poolLoader: loaderFor(emissionsPool()) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlndTrustlineMissingError);
    expect((err as BlndTrustlineMissingError).reason).toBe("unauthorized");
  });

  it("claims the reserve token ids that actually accrued when the trustline exists", async () => {
    const built = await buildBlendClaimTx(
      MAINNET,
      { poolId: POOL_V2 },
      USER,
      account([
        { balance: "10.0000000" },
        { code: "BLND", issuer: BLND.issuer, balance: "0.0000000" },
      ]),
      deps({ poolLoader: loaderFor(emissionsPool()) }),
    );
    const { contract, fn, args } = invocation(built.transaction);
    expect(contract).toBe(POOL_V2);
    expect(fn).toBe("claim");
    expect(scValToNative(args[1]!)).toEqual([1]);
    expect(built.reserveTokenIds).toEqual([1]);
  });

  it("claims v1 backstop emissions to the user", async () => {
    const v1 = makePool({
      version: "V1",
      poolId: POOL_V1,
      backstop: BLEND_BACKSTOP_V1_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V1_RATE_1, bRate: V1_RATE_1 }],
    });
    const built = await buildBackstopClaimTx(
      MAINNET,
      { poolId: POOL_V1 },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v1),
        backstopLoader: backstopLoader({ accruedEmissions: 7n }),
        simulate: simulateMint(1n),
      }),
    );
    const { contract, fn, args } = invocation(built.transaction);
    expect(contract).toBe(BLEND_BACKSTOP_V1_MAINNET_ID);
    expect(fn).toBe("claim");
    expect(scValToNative(args[1]!)).toEqual([POOL_V1]);
    expect(scValToNative(args[2]!)).toBe(USER);
  });

  it("claims v2 backstop emissions with a slippage floor from the simulated LP mint", async () => {
    const v2 = makePool({
      version: "V2",
      poolId: POOL_V2,
      backstop: BLEND_BACKSTOP_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V2_RATE_1, bRate: V2_RATE_1 }],
    });
    const mins: bigint[] = [];
    const built = await buildBackstopClaimTx(
      MAINNET,
      { poolId: POOL_V2 },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v2),
        backstopLoader: backstopLoader({ shares: 1n, accruedEmissions: 7n }),
        simulate: async (_server, tx) => {
          mins.push(scValToNative(invocation(tx as Transaction).args[2]!) as bigint);
          return {
            ok: true,
            retval: xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 1_000_000n })),
            transactionData: undefined as never,
            minResourceFee: "0",
            auth: [],
            latestLedger: 1,
          };
        },
      }),
    );
    const { contract, args } = invocation(built.transaction);
    expect(contract).toBe(BLEND_BACKSTOP_MAINNET_ID);
    // probe with 0, then 1% default slippage below the simulated 1_000_000
    expect(mins).toEqual([0n]);
    expect(scValToNative(args[2]!)).toBe(990_000n);
  });

  it("refuses a backstop claim when nothing has accrued", async () => {
    await expect(
      buildBackstopClaimTx(
        MAINNET,
        { poolId: POOL_V2 },
        USER,
        account([{ balance: "10.0000000" }]),
        deps({
          poolLoader: loaderFor(
            makePool({
              version: "V2",
              poolId: POOL_V2,
              backstop: BLEND_BACKSTOP_MAINNET_ID,
              reserves: [{ assetId: XLM_SAC, index: 0, dRate: V2_RATE_1, bRate: V2_RATE_1 }],
            }),
          ),
          backstopLoader: backstopLoader({}),
        }),
      ),
    ).rejects.toThrow(/no accrued backstop emissions/);
  });
});

describe("a backstop claim that cannot run is reported, never swallowed (L-49)", () => {
  const v2 = () =>
    makePool({
      version: "V2",
      poolId: POOL_V2,
      backstop: BLEND_BACKSTOP_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V2_RATE_1, bRate: V2_RATE_1 }],
    });
  const v1 = () =>
    makePool({
      version: "V1",
      poolId: POOL_V1,
      backstop: BLEND_BACKSTOP_V1_MAINNET_ID,
      reserves: [{ assetId: XLM_SAC, index: 0, dRate: V1_RATE_1, bRate: V1_RATE_1 }],
    });

  it("turns a trapping v2 claim simulation into a typed error carrying the accrued BLND", async () => {
    const err: unknown = await buildBackstopClaimTx(
      MAINNET,
      { poolId: POOL_V2 },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v2()),
        backstopLoader: backstopLoader({
          shares: 4_629_467_817n,
          accruedEmissions: 7_114_578_242n,
        }),
        simulate: simulateTrap,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackstopClaimUnavailableError);
    const e = err as BackstopClaimUnavailableError;
    expect(e.poolId).toBe(POOL_V2);
    expect(e.backstopId).toBe(BLEND_BACKSTOP_MAINNET_ID);
    expect(e.accruedEmissions).toBe(7_114_578_242n);
    expect(e.simulationError).toBe(COMET_TRAP);
    expect(e.message).toContain("711.4578242 BLND");
  });

  it("probes the v1 claim too, so its trap is typed the same way", async () => {
    let probed = 0;
    const err: unknown = await buildBackstopClaimTx(
      MAINNET,
      { poolId: POOL_V1 },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v1()),
        backstopLoader: backstopLoader({ shares: 68_959_544n, accruedEmissions: 292_690_900n }),
        simulate: async (server, tx) => {
          probed += 1;
          const { contract, fn, args } = invocation(tx as Transaction);
          expect([contract, fn]).toEqual([BLEND_BACKSTOP_V1_MAINNET_ID, "claim"]);
          expect(scValToNative(args[2]!)).toBe(USER);
          return simulateTrap(server, tx);
        },
      }),
    ).catch((e: unknown) => e);
    expect(probed).toBe(1);
    expect(err).toBeInstanceOf(BackstopClaimUnavailableError);
    expect((err as BackstopClaimUnavailableError).backstopId).toBe(BLEND_BACKSTOP_V1_MAINNET_ID);
    expect((err as BackstopClaimUnavailableError).accruedEmissions).toBe(292_690_900n);
  });

  it("lets an rpc transport failure through as itself, never as a forfeitable claim", async () => {
    const down = new Error("fetch failed: ECONNRESET");
    const err: unknown = await buildBackstopClaimTx(
      MAINNET,
      { poolId: POOL_V2 },
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v2()),
        backstopLoader: backstopLoader({ shares: 1n, accruedEmissions: 7n }),
        simulate: async () => {
          throw down;
        },
      }),
    ).catch((e: unknown) => e);
    expect(err).toBe(down);
    expect(err).not.toBeInstanceOf(BackstopClaimUnavailableError);
  });

  it("buildExitSequence surfaces the typed error instead of dropping the claim", async () => {
    const err: unknown = await buildExitSequence(
      MAINNET,
      hydrationPosition(POOL_V2),
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v2()),
        backstopLoader: backstopLoader({ shares: 9n, accruedEmissions: 7n }),
        simulate: simulateTrap,
        claimBackstopEmissions: true,
        backstopShares: 9n,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackstopClaimUnavailableError);
  });

  it("queues the shares without the claim when the claim is left out, so the queue never waits on it", async () => {
    const steps = await buildExitSequence(
      MAINNET,
      hydrationPosition(POOL_V2),
      USER,
      account([{ balance: "10.0000000" }]),
      deps({
        poolLoader: loaderFor(v2()),
        backstopLoader: backstopLoader({ shares: 9n, accruedEmissions: 7n }),
        simulate: simulateTrap,
        backstopShares: 9n,
      }),
    );
    expect(steps.map((s) => s.kind)).toEqual(["backstop_queue_withdrawal"]);
  });
});

describe("allow-list gate", () => {
  it("refuses to build against a non-allow-listed pool", async () => {
    await expect(
      buildBlendRepayTx(
        MAINNET,
        { poolId: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF", asset: XLM_SAC },
        USER,
        account([{ balance: "10.0000000" }]),
        deps(),
      ),
    ).rejects.toThrow(/not on the mainnet allow-list/);
  });
});
