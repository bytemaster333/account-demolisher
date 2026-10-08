import { describe, it, expect } from "vitest";
import { Address, Horizon, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";

import {
  defaultBackstopDepositLoader,
  withBlendFailover,
  type BackstopUserState,
} from "@/lib/adapters/blend/client";
import {
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_V1_MAINNET_ID,
  resolveKnownBackstop,
  type BlendBackstopRef,
} from "@/lib/adapters/blend/constants";
import {
  BackstopClaimUnavailableError,
  buildBackstopClaimTx,
  buildExitSequence,
} from "@/lib/adapters/blend/exit";
import { BLEND_MAINNET_POOL_IDS } from "@/lib/adapters/blend/pools";
import { MAINNET } from "@/lib/config/networks";

import { backstopBalance, findInContractData } from "./blend-mainnet-holders";

// read-only: the backstop emissions claim is built by the app's own builder and
// simulated against live mainnet state. nothing is signed or submitted.
//
// on 2026-10-06 every mainnet backstop claim trapped inside the BLND-USDC comet
// (UnreachableCodeReached in dep_tokn_amt_in_get_lp_tokns_out), on both
// backstops. the owner decision for that case: show the accrued BLND, ask for
// a forfeit acknowledgement, and queue without the claim. so the builder must
// report the trap as BackstopClaimUnavailableError (never a generic error, and
// never a silent skip), and the queue must still build without it. if the
// comet is fixed, the claim builds instead, and that is checked as well.

const CASES = [
  { label: "v2 backstop", backstopId: BLEND_BACKSTOP_MAINNET_ID },
  { label: "v1 backstop", backstopId: BLEND_BACKSTOP_V1_MAINNET_ID },
] as const;

// the depositor is picked at run time (see blend-mainnet-holders): a
// balance with active shares in a pool the app supports, whose accrued
// emissions the app's own loader reads as above zero
const MAX_CANDIDATES = 10;

async function holderWithAccrual(backstop: BlendBackstopRef): Promise<{
  readonly poolId: string;
  readonly user: string;
  readonly state: BackstopUserState;
}> {
  const candidates = await findInContractData(
    backstop.id,
    (entry) => {
      const b = backstopBalance(entry);
      if (b === undefined || !BLEND_MAINNET_POOL_IDS.includes(b.pool)) return undefined;
      return b.shares > 0n ? b : undefined;
    },
    MAX_CANDIDATES,
  );
  const passedOver: string[] = [];
  for (const c of candidates) {
    const state = await withBlendFailover(MAINNET, (sdkNetwork) =>
      defaultBackstopDepositLoader.loadUser(sdkNetwork, backstop, c.pool, c.user),
    );
    if (state.shares > 0n && state.accruedEmissions > 0n) {
      return { poolId: c.pool, user: c.user, state };
    }
    passedOver.push(`${c.user} (shares ${state.shares}, accrued ${state.accruedEmissions})`);
  }
  throw new Error(
    `precondition: none of ${candidates.length} indexed depositors of ${backstop.id} holds ` +
      `shares with accrued emissions: ${passedOver.join(", ")}`,
  );
}

function call(tx: Transaction): { contract: string; fn: string; args: xdr.ScVal[] } {
  const op = tx.operations[0];
  if (op?.type !== "invokeHostFunction") throw new Error("not a host function op");
  const c = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
  return {
    contract: Address.fromScAddress(c.contractAddress).toString(),
    fn: c.functionName.toString(),
    args: c.args,
  };
}

describe("integration: blend backstop emissions claim against mainnet (L-49)", () => {
  for (const c of CASES) {
    it(`reports a claim that cannot run as forfeitable and still queues (${c.label})`, async () => {
      const backstop = resolveKnownBackstop(MAINNET, c.backstopId);
      const { poolId, user, state } = await holderWithAccrual(backstop);
      const account = await new Horizon.Server(MAINNET.horizon).loadAccount(user);

      const outcome = await buildBackstopClaimTx(MAINNET, { poolId }, user, account)
        .then((built) => ({ built }))
        .catch((e: unknown) => ({ error: e }));
      if ("error" in outcome) {
        expect(outcome.error).toBeInstanceOf(BackstopClaimUnavailableError);
        const e = outcome.error as BackstopClaimUnavailableError;
        expect(e.poolId).toBe(poolId);
        expect(e.backstopId).toBe(c.backstopId);
        expect(e.accruedEmissions).toBeGreaterThan(0n);
        expect(e.simulationError).toMatch(/HostError/);
        // the event log stays out of the message the review shows
        expect(e.message).not.toMatch(/\n|Diagnostic Event/u);
        expect(e.simulationLog).toMatch(/Diagnostic Event/u);
      } else {
        const claim = call(outcome.built.transaction);
        expect([claim.contract, claim.fn]).toEqual([c.backstopId, "claim"]);
        expect(scValToNative(claim.args[1]!)).toEqual([poolId]);
      }

      // the queue is built on its own and never waits on the claim
      const steps = await buildExitSequence(
        MAINNET,
        { poolId, liabilities: new Map(), collateral: new Map(), supply: new Map() },
        user,
        account,
        { backstopShares: state.shares },
      );
      expect(steps.map((s) => s.kind)).toEqual(["backstop_queue_withdrawal"]);
      const queue = call(steps[0]!.transaction);
      expect([queue.contract, queue.fn]).toEqual([c.backstopId, "queue_withdrawal"]);
    });
  }
});
