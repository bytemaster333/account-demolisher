import { describe, it, expect } from "vitest";
import { Address, Horizon, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";

import {
  defaultBackstopDepositLoader,
  withBlendFailover,
  type BackstopUserState,
} from "@/lib/adapters/blend/client";
import {
  BLEND_BACKSTOP_MAINNET_ID,
  resolveKnownBackstop,
  type BlendBackstopRef,
} from "@/lib/adapters/blend/constants";
import { buildExitSequence } from "@/lib/adapters/blend/exit";
import { BLEND_MAINNET_POOL_IDS } from "@/lib/adapters/blend/pools";
import { MAINNET } from "@/lib/config/networks";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";

import { backstopBalance, findInContractData } from "./blend-mainnet-holders";
import { fetchLedgerClock } from "@/lib/stellar/ledger-clock";

// read-only checks against live mainnet state: the backstop steps are built by
// the app's own builders and run through prepareTransaction (simulation).
// nothing is signed or submitted.

// the depositor is picked at run time (see blend-mainnet-holders): a v2
// backstop balance in a pool the app supports, with active shares and a queue
// entry already past its unlock, confirmed by the app's own loader.
const MAX_CANDIDATES = 10;

async function holderWithUnlockedQueue(backstop: BlendBackstopRef): Promise<{
  readonly poolId: string;
  readonly user: string;
  readonly state: BackstopUserState;
}> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const candidates = await findInContractData(
    backstop.id,
    (entry) => {
      const b = backstopBalance(entry);
      if (b === undefined || !BLEND_MAINNET_POOL_IDS.includes(b.pool) || b.shares <= 0n) {
        return undefined;
      }
      return b.q4w.some((q) => q.exp < now) ? b : undefined;
    },
    MAX_CANDIDATES,
  );
  const passedOver: string[] = [];
  for (const c of candidates) {
    const state = await withBlendFailover(MAINNET, (sdkNetwork) =>
      defaultBackstopDepositLoader.loadUser(sdkNetwork, backstop, c.pool, c.user),
    );
    if (state.shares > 0n && state.unlockedQ4W > 0n) {
      return { poolId: c.pool, user: c.user, state };
    }
    passedOver.push(`${c.user} (shares ${state.shares}, unlocked ${state.unlockedQ4W})`);
  }
  throw new Error(
    `precondition: none of ${candidates.length} indexed v2 backstop depositors still holds ` +
      `both active shares and an unlocked queue: ${passedOver.join(", ")}`,
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

describe("integration: blend backstop exits simulate against mainnet (M-25)", () => {
  it("builds and simulates the queue and the unlocked withdraw on the pool's own backstop", async () => {
    const backstop = resolveKnownBackstop(MAINNET, BLEND_BACKSTOP_MAINNET_ID);
    const { poolId, user, state } = await holderWithUnlockedQueue(backstop);

    const account = await new Horizon.Server(MAINNET.horizon).loadAccount(user);
    const steps = await buildExitSequence(
      MAINNET,
      { poolId, liabilities: new Map(), collateral: new Map(), supply: new Map() },
      user,
      account,
      // the emissions claim is covered by blend-mainnet-backstop-claim; the
      // queue and the withdraw never wait on it
      {
        backstopShares: state.shares,
        backstopWithdrawAmount: state.unlockedQ4W,
        ledgerCloseTime: (await fetchLedgerClock(MAINNET)).closedAt,
      },
    );

    expect(steps.map((s) => s.kind)).toEqual(["backstop_queue_withdrawal", "backstop_withdraw"]);

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
        expect(scValToNative(c.args[1]!)).toBe(poolId);
        expect(scValToNative(c.args[2]!)).toBe(state.unlockedQ4W);
        expect(step.amount).toBe(state.unlockedQ4W);
      }
    }
  });
});
