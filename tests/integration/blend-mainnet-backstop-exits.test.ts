import { describe, it, expect } from "vitest";
import { Address, Horizon, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";

import { defaultBackstopDepositLoader, withBlendFailover } from "@/lib/adapters/blend/client";
import { BLEND_BACKSTOP_MAINNET_ID, resolveKnownBackstop } from "@/lib/adapters/blend/constants";
import { buildExitSequence } from "@/lib/adapters/blend/exit";
import { MAINNET } from "@/lib/config/networks";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";

// read-only checks against live mainnet state: the backstop steps are built by
// the app's own builders and run through prepareTransaction (simulation).
// nothing is signed or submitted.

// FixedV2 and a depositor who held active shares and an unlocked queue on
// 2026-10-06 (found in the v2 backstop's UserBalance entries). if they have
// since withdrawn, pick another holder; the precondition below says so.
const FIXED_V2 = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const DEPOSITOR = "GASIB4EFSNE5DJIZJ5UTFJKR7RPNKKWXPXBQ2RRPWASOCGGKJSCUMHVB";

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

describe("integration: blend backstop exits simulate against mainnet (M-25, L-49)", () => {
  it("builds and simulates the queue and the unlocked withdraw on the pool's own backstop", async () => {
    const backstop = resolveKnownBackstop(MAINNET, BLEND_BACKSTOP_MAINNET_ID);
    const state = await withBlendFailover(MAINNET, (sdkNetwork) =>
      defaultBackstopDepositLoader.loadUser(sdkNetwork, backstop, FIXED_V2, DEPOSITOR),
    );
    if (state.shares <= 0n || state.unlockedQ4W <= 0n) {
      throw new Error(
        `precondition: ${DEPOSITOR} no longer holds both active shares and an unlocked queue ` +
          `in the FixedV2 backstop (shares ${state.shares}, unlocked ${state.unlockedQ4W}); ` +
          `pick a current holder`,
      );
    }

    const account = await new Horizon.Server(MAINNET.horizon).loadAccount(DEPOSITOR);
    const steps = await buildExitSequence(
      MAINNET,
      { poolId: FIXED_V2, liabilities: new Map(), collateral: new Map(), supply: new Map() },
      DEPOSITOR,
      account,
      {
        claimBackstopEmissions: state.accruedEmissions > 0n,
        backstopShares: state.shares,
        backstopWithdrawAmount: state.unlockedQ4W,
      },
    );

    const kinds = steps.map((s) => s.kind);
    expect(kinds.slice(-2)).toEqual(["backstop_queue_withdrawal", "backstop_withdraw"]);
    if (state.accruedEmissions > 0n) expect(kinds[0]).toBe("backstop_claim_emissions");

    for (const step of steps) {
      const c = call(step.transaction);
      expect(c.contract).toBe(backstop.id);
      // prepareTransaction added the simulated resource fee on top of the bid
      expect(BigInt(step.transaction.fee)).toBeGreaterThan(BigInt(SOROBAN_INCLUSION_FEE));
      if (step.kind === "backstop_queue_withdrawal") {
        expect(c.fn).toBe("queue_withdrawal");
        expect(scValToNative(c.args[2]!)).toBe(state.shares);
        expect(step.shares).toBe(state.shares);
      }
      if (step.kind === "backstop_withdraw") {
        expect(c.fn).toBe("withdraw");
        expect(scValToNative(c.args[1]!)).toBe(FIXED_V2);
        expect(scValToNative(c.args[2]!)).toBe(state.unlockedQ4W);
        expect(step.amount).toBe(state.unlockedQ4W);
      }
    }
  });
});
