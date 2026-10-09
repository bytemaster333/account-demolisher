import { describe, it, expect, afterEach } from "vitest";

import { SecretKeyConnector } from "@/lib/wallet/secret-key";

import {
  accountExists,
  confirm,
  outcomeSummary,
  startFlow,
  waitForOutcome,
  type FlowActor,
} from "../helpers/headless-close";
import {
  fundedPair,
  node,
  retryToSuccess,
  reviewed,
  ScriptedWallet,
  withAllowance,
} from "../helpers/retry-flow";
import { horizon } from "../helpers/testnet-seed";

// RETRY after the failures that re-run the reviewed plan, caused for real on
// testnet and run through the app's own state machine and executor: a wallet
// that declines, the user pressing stop, and Horizon not answering. after each
// failure the test asserts the failure kind and what landed, then retries with
// an honest wallet and checks the close finished on chain without running a
// landed step twice. close-retry-race.test.ts and close-rebuild.test.ts cover
// the other kinds.

let actor: FlowActor | null = null;
let ejectInterceptor: (() => void) | null = null;
afterEach(() => {
  actor?.stop();
  actor = null;
  ejectInterceptor?.();
  ejectInterceptor = null;
});

describe("integration: RETRY after a failed close (testnet)", () => {
  it("signing: the wallet declines, nothing lands, a retry closes the account", async () => {
    const f = await fundedPair();
    actor = startFlow();
    const declining = new ScriptedWallet(f.kp.secret(), async (i) => {
      if (i === 0) throw new Error("User declined the request");
    });
    await reviewed(actor, f, declining);
    confirm(actor);
    const failed = await waitForOutcome(actor);
    expect(failed.matches("failed"), outcomeSummary(failed)).toBe(true);
    expect(failed.context.failureKind).toBe("signing");
    expect(failed.context.error).toContain("User declined");
    expect(failed.context.landedPhases).toEqual([]);
    expect(await accountExists(horizon, f.kp.publicKey())).toBe(true);

    await retryToSuccess(actor, f);
  });

  it("interrupted: stop during the first step keeps it, a retry runs only the rest", async () => {
    const f = await fundedPair();
    await withAllowance(f);
    actor = startFlow();
    const run = actor;
    // the user presses stop while the wallet is showing the first step
    const stopping = new ScriptedWallet(f.kp.secret(), async (i) => {
      if (i === 0) run.send({ type: "CANCEL" });
    });
    await reviewed(actor, f, stopping);
    confirm(actor);
    const failed = await waitForOutcome(actor);
    expect(failed.matches("failed"), outcomeSummary(failed)).toBe(true);
    expect(failed.context.failureKind).toBe("interrupted");
    const revoke = node(failed, "RevokeAllowance");
    expect(revoke.status).toBe("confirmed");
    const revokeHash = revoke.executed?.txHash;
    expect(revokeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(node(failed, "FinalClassicTx").status).not.toBe("confirmed");
    expect(await accountExists(horizon, f.kp.publicKey())).toBe(true);

    const done = await retryToSuccess(actor, f);
    // the revoke was not signed or sent again
    expect(node(done, "RevokeAllowance").executed?.txHash).toBe(revokeHash);
  });

  it("network: Horizon stops answering after confirm, a retry once it is back closes", async () => {
    const f = await fundedPair();
    actor = startFlow();
    await reviewed(actor, f, new SecretKeyConnector(f.kp.secret()));

    // Horizon's fee endpoint goes down between the review and the run
    let outage = true;
    const client = horizon.httpClient;
    const id = client.interceptors.request.use((config) => {
      if (outage && String(config.url).includes("fee_stats")) {
        throw new Error("connect ECONNREFUSED horizon-testnet.stellar.org (outage)");
      }
      return config;
    });
    ejectInterceptor = () => client.interceptors.request.eject(id);

    confirm(actor);
    const failed = await waitForOutcome(actor);
    expect(failed.matches("failed"), outcomeSummary(failed)).toBe(true);
    expect(failed.context.failureKind).toBe("network");
    expect(failed.context.error).toContain("network fees could not be read");
    expect(failed.context.landedPhases).toEqual([]);
    expect(await accountExists(horizon, f.kp.publicKey())).toBe(true);

    outage = false;
    await retryToSuccess(actor, f);
  });
});
