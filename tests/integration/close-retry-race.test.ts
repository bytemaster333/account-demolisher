import { describe, it, expect, afterEach } from "vitest";
import { Operation } from "@stellar/stellar-sdk";

import { SecretKeyConnector } from "@/lib/wallet/secret-key";

import {
  accountExists,
  confirm,
  outcomeSummary,
  startFlow,
  waitForOutcome,
  type FlowActor,
} from "../helpers/headless-close";
import { fundedPair, retryToSuccess, reviewed, ScriptedWallet } from "../helpers/retry-flow";
import { horizon, submitClassicAs } from "../helpers/testnet-seed";

// RETRY after a close raced by something else using the same account, on
// testnet through the app's own state machine and executor: another device
// that keeps moving the sequence, and a second run of the same close started
// while the first is still signing. both re-run the reviewed plan on RETRY.

let actor: FlowActor | null = null;
afterEach(() => {
  actor?.stop();
  actor = null;
});

describe("integration: RETRY after a raced close (testnet)", () => {
  it("bad_seq: another device keeps moving the sequence, a retry after it stops closes", async () => {
    const f = await fundedPair();
    actor = startFlow();
    // every signature is overtaken by a transaction from the same account sent
    // elsewhere, so each signed close carries a used sequence number
    const raced = new ScriptedWallet(f.kp.secret(), async () => {
      await submitClassicAs(f.kp, (b) => b.addOperation(Operation.bumpSequence({ bumpTo: "0" })));
    });
    await reviewed(actor, f, raced);
    confirm(actor);
    const failed = await waitForOutcome(actor);
    expect(failed.matches("failed"), outcomeSummary(failed)).toBe(true);
    expect(failed.context.failureKind).toBe("bad_seq");
    expect(await accountExists(horizon, f.kp.publicKey())).toBe(true);

    await retryToSuccess(actor, f);
  });

  it("close_running: a second run of the same close is refused while the first signs, then retries", async () => {
    const f = await fundedPair();
    let entered!: () => void;
    const signing = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // the first run's wallet holds its prompt open until the second run has been
    // refused, then the user declines it, so nothing of the first run lands
    const slow = new ScriptedWallet(f.kp.secret(), async (i) => {
      if (i !== 0) return;
      entered();
      await released;
      throw new Error("User declined the request");
    });
    const first = startFlow();
    const second = startFlow();
    actor = second;
    try {
      await reviewed(first, f, slow);
      await reviewed(second, f, new SecretKeyConnector(f.kp.secret()));

      confirm(first);
      await signing;
      confirm(second);
      const refused = await waitForOutcome(second);
      expect(refused.matches("failed"), outcomeSummary(refused)).toBe(true);
      expect(refused.context.failureKind).toBe("close_running");
      expect(refused.context.error).toContain("still running");
      expect(refused.context.landedPhases).toEqual([]);

      release();
      const declined = await waitForOutcome(first);
      expect(declined.matches("failed"), outcomeSummary(declined)).toBe(true);
      expect(declined.context.failureKind).toBe("signing");
      expect(await accountExists(horizon, f.kp.publicKey())).toBe(true);

      // the first run is over, so the refused one now runs its reviewed plan
      await retryToSuccess(second, f);
    } finally {
      release();
      first.stop();
    }
  });
});
