import { describe, it, expect } from "vitest";
import {
  Account,
  FeeBumpTransaction,
  Transaction,
  type Horizon,
  type rpc,
} from "@stellar/stellar-sdk";

import { buildExitSequence, type BlendExitStep } from "@/lib/adapters/blend/exit";
import type { BlendUserPositions } from "@/lib/adapters/blend/client";
import type { PoolUserEmissionData } from "@blend-capital/blend-sdk";
import { MAINNET } from "@/lib/config/networks";
import { BACKSTOP_QUEUE_DURATION_SECONDS } from "@/lib/adapters/blend/constants";

// buildExitSequence orders the unwind steps for one pool and only emits an
// acquire marker for liabilities the caller doesn't already hold. Both are
// pure/DI-friendly (deps.assemble, deps.holdsAtLeast, deps.now, ...), so we
// exercise them with a stubbed assemble — no RPC — and assert the step order,
// marker gating, and backstop lock.

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

// a mainnet-allow-listed pool id (blend FixedV2) so isAllowedContract and the
// post-build assertTransactionAllowed both pass on the stubbed tx.
const POOL_ID = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";

// real mainnet SAC contract ids used as reserve asset addresses (they only need
// to be valid C... strkeys — the allow-list checks the invoked pool, not args).
const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const BLND_SAC = "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY";

// TransactionBuilder only reads accountId()/sequenceNumber() off the source.
function sourceAccount(): Horizon.AccountResponse {
  return new Account(USER, "1") as unknown as Horizon.AccountResponse;
}

// assemble stub: prepareTransaction normally runs simulation and returns a real
// Transaction; here we echo the input tx (a Transaction, never a FeeBump) so the
// `"innerTransaction" in prepared` guard passes and no RPC is touched.
const assemble = async (
  _server: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
): Promise<Transaction | FeeBumpTransaction> => tx;

function positions(overrides: Partial<BlendUserPositions> = {}): BlendUserPositions {
  return {
    poolId: POOL_ID,
    poolName: "FixedV2",
    poolVersion: "V2",
    liabilities: new Map<string, bigint>(),
    collateral: new Map<string, bigint>(),
    supply: new Map<string, bigint>(),
    emissions: new Map<number, PoolUserEmissionData>(),
    ...overrides,
  };
}

function kinds(steps: readonly BlendExitStep[]): readonly string[] {
  return steps.map((s) => s.kind);
}

describe("buildExitSequence ordering", () => {
  it("refuses to build against a non-allow-listed pool", async () => {
    await expect(
      buildExitSequence(
        MAINNET,
        positions({ poolId: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF" }),
        USER,
        sourceAccount(),
        { assemble, server: {} as rpc.Server },
      ),
    ).rejects.toThrow(/not on the mainnet allow-list/);
  });

  it("emits acquire_repay_asset, repay, withdraw_collateral, withdraw_supply, claim_emissions in order", async () => {
    const steps = await buildExitSequence(
      MAINNET,
      positions({
        liabilities: new Map([[USDC_SAC, 1_000_0000000n]]),
        collateral: new Map([[XLM_SAC, 500_0000000n]]),
        supply: new Map([[BLND_SAC, 250_0000000n]]),
        emissions: new Map<number, PoolUserEmissionData>([[0, {} as PoolUserEmissionData]]),
      }),
      USER,
      sourceAccount(),
      {
        assemble,
        server: {} as rpc.Server,
        // user does not hold the liability asset -> acquire marker is emitted
        holdsAtLeast: () => false,
        // resolver keeps inferAssetIdentifier off the network passphrase path
        resolveAssetIdentifier: () => ({ kind: "native" }),
      },
    );

    expect(kinds(steps)).toEqual([
      "acquire_repay_asset",
      "repay",
      "withdraw_collateral",
      "withdraw_supply",
      "claim_emissions",
    ]);
  });

  it("suppresses the acquire marker when the user already holds the liability asset", async () => {
    const steps = await buildExitSequence(
      MAINNET,
      positions({ liabilities: new Map([[USDC_SAC, 1_000_0000000n]]) }),
      USER,
      sourceAccount(),
      { assemble, server: {} as rpc.Server, holdsAtLeast: () => true },
    );

    expect(kinds(steps)).toEqual(["repay"]);
    expect(steps.some((s) => s.kind === "acquire_repay_asset")).toBe(false);
  });

  it("skips zero-amount liabilities/collateral/supply buckets", async () => {
    const steps = await buildExitSequence(
      MAINNET,
      positions({
        liabilities: new Map([[USDC_SAC, 0n]]),
        collateral: new Map([[XLM_SAC, 0n]]),
        supply: new Map([[BLND_SAC, 0n]]),
      }),
      USER,
      sourceAccount(),
      { assemble, server: {} as rpc.Server, holdsAtLeast: () => false },
    );

    expect(steps).toHaveLength(0);
  });
});

describe("buildExitSequence backstop queue withdrawal", () => {
  it("emits no backstop step when backstopShares is 0", async () => {
    const steps = await buildExitSequence(MAINNET, positions(), USER, sourceAccount(), {
      assemble,
      server: {} as rpc.Server,
      backstopShares: 0n,
    });

    expect(steps.some((s) => s.kind === "backstop_queue_withdrawal")).toBe(false);
  });

  it("emits exactly one locked backstop step with queueEndsAt = now + queue duration", async () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const steps = await buildExitSequence(MAINNET, positions(), USER, sourceAccount(), {
      assemble,
      server: {} as rpc.Server,
      backstopShares: 42n,
      now: () => new Date(nowMs),
    });

    const backstop = steps.filter((s) => s.kind === "backstop_queue_withdrawal");
    expect(backstop).toHaveLength(1);
    const step = backstop[0]!;
    if (step.kind !== "backstop_queue_withdrawal") throw new Error("unreachable");
    expect(step.manualReturnRequired).toBe(true);
    expect(step.queueEndsAt.getTime()).toBe(nowMs + BACKSTOP_QUEUE_DURATION_SECONDS * 1000);
  });
});
