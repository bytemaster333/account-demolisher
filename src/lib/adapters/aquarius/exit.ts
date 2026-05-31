/**
 * aquarius exit sequencer. emits withdraw + claim steps per pool.
 */

import type { Horizon, Transaction, rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { assembleSubmittable } from "@/lib/soroban/simulate";

import { claim, withdraw } from "./client";
import { poolIndexHexToBytes, type AquariusPool } from "./pools";

// one step in the exit sequence
export type AquariusExitStep =
  | {
      readonly kind: "withdraw";
      readonly poolIndex: string;
      readonly shareAmount: bigint;
      readonly transaction: Transaction;
    }
  | {
      readonly kind: "claim";
      readonly poolIndex: string;
      readonly transaction: Transaction;
    };

export interface BuildAquariusExitDeps {
  // gate claim emission per pool. defaults to always emit so AQUA isn't dropped.
  readonly claimWhen?: (pool: AquariusPool) => boolean;
  readonly server?: rpc.Server;
  readonly assemble?: typeof assembleSubmittable;
  // lower bound on shareBalance for emitting a withdraw step
  readonly minShareBalance?: bigint;
  // per-token minimums for withdraw. defaults to all zeros.
  readonly minAmountsFor?: (pool: AquariusPool) => readonly bigint[];
}

// build ordered unsigned exit steps for a user across pools
export async function buildAquariusExit(
  pools: readonly AquariusPool[],
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  network: NetworkConfig,
  deps: BuildAquariusExitDeps = {},
): Promise<{ steps: readonly AquariusExitStep[] }> {
  const server = deps.server ?? getRpc(network);
  const assemble = deps.assemble ?? assembleSubmittable;
  const claimWhen = deps.claimWhen ?? (() => true);
  const minBalance = deps.minShareBalance ?? 0n;
  const minAmountsFor = deps.minAmountsFor ?? ((pool: AquariusPool) => pool.tokens.map(() => 0n));

  const steps: AquariusExitStep[] = [];

  for (const pool of pools) {
    if (pool.shareBalance <= minBalance) continue;

    // discovery hands us hex, router wants raw bytes
    const poolIndexBytes = poolIndexHexToBytes(pool.poolIndex);

    const withdrawTx = await withdraw(
      {
        user: userPublicKey,
        tokens: pool.tokens,
        poolIndex: poolIndexBytes,
        shareAmount: pool.shareBalance,
        minAmounts: minAmountsFor(pool),
        sourceAccount,
        network,
      },
      { server, assemble },
    );
    steps.push({
      kind: "withdraw",
      poolIndex: pool.poolIndex,
      shareAmount: pool.shareBalance,
      transaction: withdrawTx,
    });

    if (claimWhen(pool)) {
      const claimTx = await claim(
        {
          user: userPublicKey,
          poolIndex: poolIndexBytes,
          sourceAccount,
          network,
        },
        { server, assemble },
      );
      steps.push({
        kind: "claim",
        poolIndex: pool.poolIndex,
        transaction: claimTx,
      });
    }
  }

  return { steps };
}
