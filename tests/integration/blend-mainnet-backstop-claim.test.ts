import { describe, it, expect } from "vitest";
import { Address, Horizon, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";

import { defaultBackstopDepositLoader, withBlendFailover } from "@/lib/adapters/blend/client";
import {
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_V1_MAINNET_ID,
  resolveKnownBackstop,
} from "@/lib/adapters/blend/constants";
import {
  BackstopClaimUnavailableError,
  buildBackstopClaimTx,
  buildExitSequence,
} from "@/lib/adapters/blend/exit";
import { MAINNET } from "@/lib/config/networks";

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

// depositors holding active shares and accrued emissions on 2026-10-06 (read
// from the backstops' UserBalance and UEmisData entries)
const CASES = [
  {
    label: "v2 backstop, FixedV2",
    poolId: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    user: "GBCRDN4B6KY456PNKGPTB7OJXEHOBMMZ6EQ23TIRBMIXZUUJODL5RDYM",
    backstopId: BLEND_BACKSTOP_MAINNET_ID,
  },
  {
    label: "v1 backstop, Fixed",
    poolId: "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP",
    user: "GCGZAO7KGSJFYO2O5ZJHCNDRFXHXUN7X7A5N3EXW4S2QXIZPZ37OXO4R",
    backstopId: BLEND_BACKSTOP_V1_MAINNET_ID,
  },
] as const;

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
      const state = await withBlendFailover(MAINNET, (sdkNetwork) =>
        defaultBackstopDepositLoader.loadUser(sdkNetwork, backstop, c.poolId, c.user),
      );
      if (state.shares <= 0n || state.accruedEmissions <= 0n) {
        throw new Error(
          `precondition: ${c.user} no longer holds shares with accrued emissions in the ` +
            `${c.label} backstop (shares ${state.shares}, accrued ${state.accruedEmissions}); ` +
            `pick a current holder`,
        );
      }
      const account = await new Horizon.Server(MAINNET.horizon).loadAccount(c.user);

      const outcome = await buildBackstopClaimTx(MAINNET, { poolId: c.poolId }, c.user, account)
        .then((built) => ({ built }))
        .catch((e: unknown) => ({ error: e }));
      if ("error" in outcome) {
        expect(outcome.error).toBeInstanceOf(BackstopClaimUnavailableError);
        const e = outcome.error as BackstopClaimUnavailableError;
        expect(e.poolId).toBe(c.poolId);
        expect(e.backstopId).toBe(c.backstopId);
        expect(e.accruedEmissions).toBeGreaterThan(0n);
        expect(e.simulationError).toMatch(/HostError/);
      } else {
        const claim = call(outcome.built.transaction);
        expect([claim.contract, claim.fn]).toEqual([c.backstopId, "claim"]);
        expect(scValToNative(claim.args[1]!)).toEqual([c.poolId]);
      }

      // the queue is built on its own and never waits on the claim
      const steps = await buildExitSequence(
        MAINNET,
        { poolId: c.poolId, liabilities: new Map(), collateral: new Map(), supply: new Map() },
        c.user,
        account,
        { backstopShares: state.shares },
      );
      expect(steps.map((s) => s.kind)).toEqual(["backstop_queue_withdrawal"]);
      const queue = call(steps[0]!.transaction);
      expect([queue.contract, queue.fn]).toEqual([c.backstopId, "queue_withdrawal"]);
    });
  }
});
