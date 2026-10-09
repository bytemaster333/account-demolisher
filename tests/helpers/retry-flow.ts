// shared by the live RETRY tests: a wallet the test scripts, a funded account
// and destination, and the steps a user takes after a failed close. the close
// itself runs through the app's own state machine (see headless-close.ts).

import { expect } from "vitest";
import {
  Asset,
  Contract,
  Keypair,
  nativeToScVal,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { waitFor } from "xstate";

import { TESTNET } from "@/lib/config/networks";
import { address as addr, i128 } from "@/lib/soroban/scval";
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
  waitForOutcome,
  type FlowActor,
  type FlowSnapshot,
} from "./headless-close";
import { horizon, rpc, submitSorobanAs } from "./testnet-seed";

const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);

// a wallet whose behaviour the test scripts; it signs with the real key
export class ScriptedWallet implements Connector {
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

export interface Fixture {
  readonly kp: Keypair;
  readonly destination: string;
}

export async function fundedPair(): Promise<Fixture> {
  const kp = Keypair.random();
  const destination = Keypair.random().publicKey();
  await friendbotFund(TESTNET, kp.publicKey());
  await friendbotFund(TESTNET, destination);
  return { kp, destination };
}

// a live allowance on the XLM SAC, so the plan has a soroban step ahead of the
// merge and a failure can fall between two steps
export async function withAllowance(f: Fixture): Promise<void> {
  const latest = await rpc.getLatestLedger();
  await submitSorobanAs(
    f.kp,
    new Contract(XLM_SAC).call(
      "approve",
      addr(f.kp.publicKey()),
      addr(Keypair.random().publicKey()),
      i128(5_0000000n),
      nativeToScVal(latest.sequence + 100_000, { type: "u32" }),
    ),
  );
}

export async function reviewed(
  actor: FlowActor,
  f: Fixture,
  connector: Connector,
): Promise<FlowSnapshot> {
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

export function node(s: FlowSnapshot, kind: string) {
  const found = [...(s.context.tree?.allNodes.values() ?? [])].find((n) => n.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} step in the plan`);
  return found;
}

export async function retryToSuccess(actor: FlowActor, f: Fixture): Promise<FlowSnapshot> {
  retry(actor, new SecretKeyConnector(f.kp.secret()));
  const done = await waitForOutcome(actor);
  expect(done.matches("succeeded"), outcomeSummary(done)).toBe(true);
  expect(await accountExists(horizon, f.kp.publicKey())).toBe(false);
  return done;
}

// a failure that is not retryable rebuilds the plan from fresh discovery on
// RETRY and stops at the review again, which the user confirms. returns that
// rebuilt review.
export async function rebuildToSuccess(actor: FlowActor, f: Fixture): Promise<FlowSnapshot> {
  retry(actor, new SecretKeyConnector(f.kp.secret()));
  const again = await waitFor(
    actor,
    (s) => s.matches("awaiting_confirmation") || s.matches("failed"),
    { timeout: 240_000 },
  );
  expect(reviewProblems(again)).toEqual([]);
  confirm(actor);
  const done = await waitForOutcome(actor);
  expect(done.matches("succeeded"), outcomeSummary(done)).toBe(true);
  expect(await accountExists(horizon, f.kp.publicKey())).toBe(false);
  return again;
}
