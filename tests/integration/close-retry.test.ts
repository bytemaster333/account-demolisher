import { describe, it, expect, afterEach } from "vitest";
import {
  Asset,
  Keypair,
  Operation,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { buildApprove } from "@/lib/soroban/sep41";
import type { Connector } from "@/lib/wallet/connector";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

import {
  accountExists,
  confirm,
  friendbotFund,
  outcomeSummary,
  reachReview,
  retry,
  reviewProblems,
  startFlow,
  waitForOutcome,
  type FlowActor,
  type FlowSnapshot,
} from "../helpers/headless-close";
import { horizon, rpc, submitClassicAs } from "../helpers/testnet-seed";

// RETRY after each failure kind that can be caused for real on testnet, run
// through the app's own state machine and executor. the faults come from where
// they come from in production: a wallet that declines or is slow, a second
// device that moves the account's sequence, the user pressing stop, and Horizon
// not answering. after each failure the test asserts the failure kind and what
// landed, then retries with an honest wallet and checks the close finished on
// chain without running a landed step twice.

const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);

// a wallet whose behaviour the test scripts; it signs with the real key
class ScriptedWallet implements Connector {
  readonly kind = "secret" as const;
  readonly #inner: SecretKeyConnector;
  constructor(
    secret: string,
    private readonly beforeSign: (callIndex: number) => Promise<void>,
  ) {
    this.#inner = new SecretKeyConnector(secret);
  }
  #calls = 0;
  connect() {
    return this.#inner.connect();
  }
  disconnect() {
    return this.#inner.disconnect();
  }
  getPublicKey() {
    return this.#inner.getPublicKey();
  }
  async signTransaction(tx: Transaction | FeeBumpTransaction, passphrase: string) {
    await this.beforeSign(this.#calls++);
    return this.#inner.signTransaction(tx, passphrase);
  }
}

interface Fixture {
  readonly kp: Keypair;
  readonly destination: string;
}

async function fundedPair(): Promise<Fixture> {
  const kp = Keypair.random();
  const destination = Keypair.random().publicKey();
  await friendbotFund(TESTNET, kp.publicKey());
  await friendbotFund(TESTNET, destination);
  return { kp, destination };
}

// a live allowance on the XLM SAC, so the plan has a soroban step ahead of the
// merge and a failure can fall between two steps
async function withAllowance(f: Fixture): Promise<void> {
  const latest = await rpc.getLatestLedger();
  const approve = await buildApprove(
    rpc,
    XLM_SAC,
    f.kp.publicKey(),
    Keypair.random().publicKey(),
    5_0000000n,
    latest.sequence + 100_000,
    TESTNET,
    await horizon.loadAccount(f.kp.publicKey()),
  );
  approve.sign(f.kp);
  const sent = await rpc.sendTransaction(approve);
  if (sent.status !== "PENDING") throw new Error(`approve not queued: ${sent.status}`);
  const res = await rpc.pollTransaction(sent.hash, { attempts: 60 });
  if (res.status !== "SUCCESS") throw new Error(`approve ${sent.hash}: ${res.status}`);
}

async function reviewed(actor: FlowActor, f: Fixture, connector: Connector): Promise<FlowSnapshot> {
  const review = await reachReview(actor, {
    publicKey: f.kp.publicKey(),
    network: TESTNET,
    connector,
    destination: f.destination,
    useMediator: false,
  });
  expect(reviewProblems(review)).toEqual([]);
  return review;
}

function node(s: FlowSnapshot, kind: string) {
  const found = [...(s.context.tree?.allNodes.values() ?? [])].find((n) => n.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} step in the plan`);
  return found;
}

async function retryToSuccess(actor: FlowActor, f: Fixture): Promise<FlowSnapshot> {
  retry(actor, new SecretKeyConnector(f.kp.secret()));
  const done = await waitForOutcome(actor);
  expect(done.matches("succeeded"), outcomeSummary(done)).toBe(true);
  expect(await accountExists(horizon, f.kp.publicKey())).toBe(false);
  return done;
}

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
});
