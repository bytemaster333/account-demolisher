// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";
import {
  Account,
  BadResponseError,
  Keypair,
  NotFoundError,
  Operation,
  TransactionBuilder,
  TransactionFailedError,
  type Transaction,
} from "@stellar/stellar-sdk";

import { AccountNotFoundError } from "@/lib/stellar/account-audit";
import { BackstopClaimUnavailableError } from "@/lib/adapters/blend/exit";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";
import type { DemolishProgressEvent } from "@/lib/types/plan";
import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";

import {
  DEST,
  ATTACKER,
  EXCHANGE,
  HOSTILE_TOKEN,
  MEDIATOR_A,
  MEDIATOR_B,
  NETWORK,
  PASS,
  USDC_ISSUER,
  USDC_SAC,
  USER,
  USER_KP,
  allowlisted,
  makeAudit,
  signingConnector,
} from "./orchestrator-fixtures";

// the real discover, preview and execute actors inside the real machine. only
// the network leaves are doubles: horizon, the soroban rpc, the mediator mint
// and forward endpoints, and the discovery scans. the pending-forward record is
// the real one in (happy-dom) localStorage.

const net = {
  horizon: null as unknown as ReturnType<typeof horizonDouble>,
  rpc: null as unknown as Record<string, unknown>,
};
const auditAccount = vi.fn();
const startMediatorFlow = vi.fn();
const submitMediatorForward = vi.fn();
const getPositions = vi.fn();
const scanAllowances = vi.fn();
const confirmAllowancesOnChain = vi.fn();
const discoverHeldTokens = vi.fn();

vi.mock("@/lib/stellar/horizon-client", () => ({ getHorizon: () => net.horizon }));
vi.mock("@/lib/soroban/rpc-client", () => ({ getRpc: () => net.rpc }));
vi.mock("@/lib/stellar/account-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/account-audit")>(
    "@/lib/stellar/account-audit",
  );
  return { ...actual, auditAccount: (...a: unknown[]) => auditAccount(...a) };
});
const resolveCreditPaths = vi.fn();
vi.mock("@/lib/stellar/path-finder", () => ({
  resolveCreditPaths: (...a: unknown[]) => resolveCreditPaths(...a),
}));
vi.mock("@/lib/mediator/client", () => ({
  startMediatorFlow: (...a: unknown[]) => startMediatorFlow(...a),
}));
vi.mock("@/lib/mediator/forward", () => ({
  submitMediatorForward: (...a: unknown[]) => submitMediatorForward(...a),
}));
vi.mock("@/lib/adapters/positions/direct", () => ({
  DirectContractProvider: class {
    getPositions(...a: unknown[]) {
      return getPositions(...a);
    }
  },
}));
vi.mock("@/lib/soroban/allowances", async () => {
  const actual = await vi.importActual<typeof import("@/lib/soroban/allowances")>(
    "@/lib/soroban/allowances",
  );
  return {
    ...actual,
    scanAllowances: (...a: unknown[]) => scanAllowances(...a),
    confirmAllowancesOnChain: (...a: unknown[]) => confirmAllowancesOnChain(...a),
  };
});
// the blend exit builders read pools through the blend sdk's own rpc client, so
// they are a network leaf here too
const buildExitSequence = vi.fn();
const buildBackstopClaimTx = vi.fn();
const buildBackstopQueueTx = vi.fn();
vi.mock("@/lib/adapters/blend/exit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/adapters/blend/exit")>(
    "@/lib/adapters/blend/exit",
  );
  return {
    ...actual,
    buildExitSequence: (...a: unknown[]) => buildExitSequence(...a),
    buildBackstopClaimTx: (...a: unknown[]) => buildBackstopClaimTx(...a),
    buildBackstopQueueTx: (...a: unknown[]) => buildBackstopQueueTx(...a),
  };
});
vi.mock("@/lib/soroban/held-tokens", async () => {
  const actual = await vi.importActual<typeof import("@/lib/soroban/held-tokens")>(
    "@/lib/soroban/held-tokens",
  );
  return { ...actual, discoverHeldTokens: (...a: unknown[]) => discoverHeldTokens(...a) };
});

import {
  fetchDestinationUsableKeys,
  pageFlowMachine,
  type PageFlowInput,
} from "@/lib/orchestrator/page-flow-machine";
import { latestPendingForward, savePendingForward } from "@/lib/mediator/pending-flow";
import { simulatePreviewTree } from "@/lib/orchestrator/actors/preview";

const RUN = { publicKey: USER, networkId: NETWORK.id };
const recordFor = () => latestPendingForward(USER, NETWORK.id);

// a horizon whose account table follows the batches that land. `replyTimeout`
// lands the transaction but answers the submit with a 504 and then stays down
// (every read a 503) until the test brings it back.
function horizonDouble() {
  const accounts = new Map<string, bigint>([[USER, 100n]]);
  const landed = new Map<string, number>();
  const submitted: Transaction[] = [];
  const state = { down: false, replyTimeout: false, ledger: 50 };
  const unavailable = () =>
    new BadResponseError("down", { status: 503, statusText: "Service Unavailable", data: {} });
  const notFound = () =>
    new NotFoundError("not found", { status: 404, statusText: "Not Found", data: {} });
  const self = {
    accounts,
    landed,
    submitted,
    state,
    signers: [{ type: "ed25519_public_key", key: USER, weight: 1 }] as {
      type: string;
      key: string;
      weight: number;
    }[],
    loadAccount: vi.fn(async (id: string) => {
      const seq = accounts.get(id);
      if (seq === undefined) throw notFound();
      return Object.assign(new Account(id, seq.toString()), {
        account_id: id,
        balances: [] as unknown[],
        signers: id === USER ? self.signers : [{ type: "ed25519_public_key", key: id, weight: 1 }],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        data_attr: {},
      });
    }),
    offers: () => ({
      forAccount: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }),
    }),
    submitTransaction: vi.fn(async (tx: Transaction) => {
      submitted.push(tx);
      const hash = Buffer.from(tx.hash()).toString("hex");
      state.ledger += 1;
      landed.set(hash, state.ledger);
      accounts.set(USER, BigInt(tx.sequence));
      for (const op of tx.operations) {
        if (op.type === "createAccount") {
          accounts.set((op as Operation.CreateAccount).destination, 1n);
        }
        if (op.type === "accountMerge") accounts.delete(USER);
      }
      if (state.replyTimeout) {
        state.down = true;
        throw new BadResponseError("timeout", {
          status: 504,
          statusText: "Gateway Timeout",
          data: { title: "Timeout" },
        });
      }
      return { hash, ledger: state.ledger };
    }),
    transactions: () => ({
      transaction: (hash: string) => ({
        call: async () => {
          if (state.down) throw unavailable();
          const ledger = landed.get(hash);
          if (ledger === undefined) throw notFound();
          return { successful: true, ledger_attr: ledger, hash };
        },
      }),
      forAccount: () => ({
        order: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }),
      }),
    }),
    operations: () => ({
      forAccount: () => ({
        order: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }),
      }),
    }),
    ledgers: () => ({
      order: () => ({
        limit: () => ({
          call: async () => {
            if (state.down) throw unavailable();
            return {
              records: [
                {
                  base_reserve_in_stroops: 5_000_000,
                  sequence: state.ledger,
                  closed_at: new Date(Date.now()).toISOString(),
                },
              ],
            };
          },
        }),
      }),
    }),
  };
  return self;
}

function tree(...nodes: PlanNode[]): PlanTree {
  return {
    rootNodes: nodes.filter((n) => n.dependencies.length === 0),
    allNodes: new Map(nodes.map((n) => [n.id, n])),
  };
}

function mediatorPlan(): PlanTree {
  return tree(
    {
      id: "final-classic-tx",
      kind: "FinalClassicTx",
      dependencies: [],
      description: "close account",
      status: "simulated",
      metadata: {
        kind: "FinalClassicTx",
        batches: [],
        destination: EXCHANGE,
        useMediator: true,
        mediatorPublicKey: MEDIATOR_A,
      },
    } as PlanNode,
    {
      id: "mediator-forward",
      kind: "MediatorForward",
      dependencies: ["final-classic-tx"],
      description: "forward to the exchange",
      status: "simulated",
      metadata: {
        kind: "MediatorForward",
        mediatorPublicKey: MEDIATOR_A,
        flowToken: "PREVIEW-TOKEN",
        ultimateDestination: EXCHANGE,
      },
    } as PlanNode,
  );
}

const discovered = {
  audit: makeAudit(),
  positions: EMPTY_POSITIONS,
  allowances: [],
  heldTokens: [],
  unreadableHeldTokens: [],
  heldTokenScanFailed: false,
  discoveryWarnings: [],
  discoveryDiagnostics: [],
};

function input(over: Partial<PageFlowInput> = {}): PageFlowInput {
  return {
    publicKey: USER,
    network: NETWORK,
    connector: signingConnector(),
    destination: EXCHANGE,
    useMediator: true,
    ...over,
  } as PageFlowInput;
}

// the real execute actor; discover and preview hand it a fixed plan
function withPlan(plan: () => PlanTree, i: PageFlowInput = input()) {
  const machine = pageFlowMachine.provide({
    actors: {
      discover: fromPromise(async () => discovered) as never,
      preview: fromPromise(async () => ({
        tree: plan(),
        unroutableCredits: [],
        heldTokenWarnings: [],
      })) as never,
    },
  });
  const actor = createActor(machine).start();
  actor.send({ type: "START", input: i });
  return actor;
}

function progressKinds(actor: ReturnType<typeof withPlan>): DemolishProgressEvent["kind"][] {
  return actor.getSnapshot().context.progress.map((p) => p.kind);
}

type FlowState = Parameters<ReturnType<ReturnType<typeof withPlan>["getSnapshot"]>["matches"]>[0];

async function settle(actor: ReturnType<typeof withPlan>, state: FlowState) {
  const done = waitFor(actor, (s) => s.matches(state), { timeout: 3_600_000 });
  await vi.runAllTimersAsync();
  return done;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: false });
  window.localStorage.clear();
  net.horizon = horizonDouble();
  net.rpc = {
    getLatestLedger: vi.fn(async () => ({ sequence: 1000 })),
  };
  // the audit reads the same account table horizon serves
  auditAccount.mockImplementation(async (pk: string) => {
    if (!net.horizon.accounts.has(pk)) throw new AccountNotFoundError(pk);
    return makeAudit();
  });
  startMediatorFlow.mockResolvedValue({
    ok: true,
    mediatorPublicKey: MEDIATOR_B,
    flowToken: "TOKEN-1",
    expiresAt: Date.now() + 15 * 60_000,
  });
  getPositions.mockResolvedValue(EMPTY_POSITIONS);
  scanAllowances.mockResolvedValue({ records: [], incomplete: null, overflow: [] });
  confirmAllowancesOnChain.mockImplementation(async (_s, _o, records: unknown[]) =>
    records.map((r) => ({ ...(r as object), onChainAmount: 5n })),
  );
  discoverHeldTokens.mockResolvedValue({ held: [], unreadable: [], incomplete: null });
  resolveCreditPaths.mockResolvedValue(new Map());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("an exchange close is not complete until the forward lands", () => {
  it("fails as forward_pending, keeps the recovery record, and RETRY re-runs only the forward", async () => {
    submitMediatorForward.mockResolvedValueOnce({
      ok: false,
      error: "HTTP 503 from horizon",
      flowToken: "TOKEN-1",
    });
    const actor = withPlan(mediatorPlan);
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: EXCHANGE.slice(-4), expected: RUN });
    await settle(actor, "failed");

    const failed = actor.getSnapshot().context;
    expect(failed.failureKind).toBe("forward_pending");
    expect(failed.result?.ok).toBe(false);
    expect(progressKinds(actor)).not.toContain("complete");
    expect(net.horizon.accounts.has(USER)).toBe(false);
    expect(recordFor()).toMatchObject({
      mediatorPublicKey: MEDIATOR_B,
      flowToken: "TOKEN-1",
    });

    submitMediatorForward.mockResolvedValueOnce({
      ok: true,
      txHash: "FWD",
      ledger: 60,
      alreadyDelivered: false,
      flowToken: "TOKEN-1",
    });
    actor.send({ type: "RETRY", connector: signingConnector() });
    await settle(actor, "succeeded");
    expect(submitMediatorForward).toHaveBeenCalledTimes(2);
    expect(submitMediatorForward.mock.calls[1]![0]).toMatchObject({
      mediatorPublicKey: MEDIATOR_B,
      flowToken: "TOKEN-1",
    });
    // the merge was not signed or submitted again, and no second flow was minted
    expect(net.horizon.submitted).toHaveLength(1);
    expect(startMediatorFlow).toHaveBeenCalledTimes(1);
    expect(actor.getSnapshot().context.result).toMatchObject({ ok: true, forwardTxHash: "FWD" });
    expect(recordFor()).toBeNull();
    actor.stop();
  });

  it("stays failed while the forward keeps failing", async () => {
    submitMediatorForward.mockResolvedValue({
      ok: false,
      error: "HTTP 503 from horizon",
      flowToken: "TOKEN-1",
    });
    const actor = withPlan(mediatorPlan);
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: EXCHANGE.slice(-4), expected: RUN });
    await settle(actor, "failed");
    actor.send({ type: "RETRY", connector: signingConnector() });
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.failureKind).toBe("forward_pending");
    expect(progressKinds(actor)).not.toContain("complete");
    actor.stop();
  });
});

describe("a merge whose reply was lost is never re-minted around", () => {
  it("keeps the first flow and its record, confirms the merge from the chain on RETRY, then forwards", async () => {
    net.horizon.state.replyTimeout = true;
    submitMediatorForward.mockResolvedValue({
      ok: true,
      txHash: "FWD",
      ledger: 60,
      alreadyDelivered: false,
      flowToken: "TOKEN-1",
    });
    const actor = withPlan(mediatorPlan);
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: EXCHANGE.slice(-4), expected: RUN });
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.failureKind).toBe("ambiguous");
    expect(recordFor()).toMatchObject({ mediatorPublicKey: MEDIATOR_B });

    // horizon is back and shows the merge landed
    net.horizon.state.down = false;
    net.horizon.state.replyTimeout = false;
    const signer = signingConnector();
    actor.send({ type: "RETRY", connector: signer });
    await settle(actor, "succeeded");
    expect(startMediatorFlow).toHaveBeenCalledTimes(1);
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(net.horizon.submitted).toHaveLength(1);
    expect(submitMediatorForward.mock.calls[0]![0]).toMatchObject({
      mediatorPublicKey: MEDIATOR_B,
      flowToken: "TOKEN-1",
    });
    actor.stop();
  });
});

describe("the bundle path submits only what everyone signed", () => {
  const snapshot = {
    signers: [{ key: USER, weight: 1 }],
    thresholds: { low: 0, med: 0, high: 0 },
  };
  function signedBundle(opts: { maxTime?: number; signers?: Keypair[]; fee?: string } = {}): {
    signedXdr: string;
    planId: string;
  } {
    const tx = new TransactionBuilder(new Account(USER, "100"), {
      fee: opts.fee ?? "100",
      networkPassphrase: PASS,
      timebounds: { minTime: 0, maxTime: opts.maxTime ?? Math.floor(Date.now() / 1000) + 3600 },
    })
      .addOperation(Operation.accountMerge({ destination: DEST }))
      .build();
    for (const kp of opts.signers ?? [USER_KP]) tx.sign(kp);
    return {
      signedXdr: tx.toEnvelope().toXdr("base64"),
      planId: Buffer.from(tx.hash()).toString("hex"),
    };
  }
  const submitBundle = (b = signedBundle()) => ({
    type: "SUBMIT_BUNDLE" as const,
    ...b,
    typed: DEST.slice(-4),
    expected: RUN,
    snapshot,
  });
  function plan(extra: PlanNode[] = []): PlanTree {
    return tree(...extra, {
      id: "final-classic-tx",
      kind: "FinalClassicTx",
      dependencies: extra.map((n) => n.id),
      description: "close account",
      status: "simulated",
      metadata: { kind: "FinalClassicTx", batches: [], destination: DEST, useMediator: false },
    } as PlanNode);
  }

  it("refuses a plan carrying a soroban step, whatever its status, before submitting", async () => {
    for (const status of ["simulated", "failed", "skipped"] as const) {
      net.horizon = horizonDouble();
      const held = {
        id: "drain",
        kind: "TransferAsIs",
        dependencies: [],
        description: "send token",
        status,
        metadata: {
          kind: "TransferAsIs",
          asset: { kind: "contract", contractId: HOSTILE_TOKEN },
          amount: 5n,
          destination: DEST,
        },
      } as PlanNode;
      const actor = withPlan(() => plan([held]), input({ destination: DEST, useMediator: false }));
      await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
      actor.send(submitBundle());
      await settle(actor, "failed");
      expect(actor.getSnapshot().context.error).toMatch(/TransferAsIs/);
      expect(net.horizon.submitTransaction).not.toHaveBeenCalled();
      expect(held.status).not.toBe("confirmed");
      actor.stop();
    }
  });

  it("stamps only the merge step with the bundle's receipt", async () => {
    const actor = withPlan(() => plan(), input({ destination: DEST, useMediator: false }));
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send(submitBundle());
    await settle(actor, "succeeded");
    const final = actor.getSnapshot().context.tree!.allNodes.get("final-classic-tx")!;
    expect(final.status).toBe("confirmed");
    expect(final.executed?.txHash).toBe(
      Buffer.from(net.horizon.submitted[0]!.hash()).toString("hex"),
    );
    actor.stop();
  });

  it("marks a refused bundle stale so RETRY asks for new signatures instead of resubmitting", async () => {
    net.horizon.submitTransaction.mockRejectedValueOnce(
      new TransactionFailedError("failed", {
        status: 400,
        statusText: "Bad Request",
        data: { extras: { result_codes: { transaction: "tx_too_late" } } },
      }),
    );
    const actor = withPlan(() => plan(), input({ destination: DEST, useMediator: false }));
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send(submitBundle());
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.failureKind).toBe("bundle_stale");
    actor.send({ type: "RETRY", connector: signingConnector() });
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(actor.getSnapshot().context.signedBundle).toBeNull();
    expect(net.horizon.submitTransaction).toHaveBeenCalledTimes(1);
    actor.stop();
  });
});

describe("the real preview surfaces what it could not build", () => {
  function realActors(i: PageFlowInput) {
    const actor = createActor(pageFlowMachine).start();
    actor.send({ type: "START", input: i });
    return actor;
  }

  it("fails the preview when the ledger read fails, instead of skipping hydration", async () => {
    net.rpc = {
      getLatestLedger: vi
        .fn()
        .mockResolvedValueOnce({ sequence: 1000 })
        .mockResolvedValueOnce({ sequence: 1000 })
        .mockRejectedValue(new Error("fetch failed")),
    };
    const actor = realActors(input({ destination: DEST, useMediator: false }));
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.error).toMatch(/fetch failed/);
    expect(actor.getSnapshot().context.tree).toBeNull();
    actor.stop();
  });

  it("keeps a step's real hydration error and failed status", async () => {
    const spender = allowlisted("soroswap", "SoroswapRouter");
    scanAllowances.mockResolvedValue({
      records: [
        {
          contractId: HOSTILE_TOKEN,
          spender,
          amount: 5n,
          live_until_ledger: 5000,
          lastSeenLedger: 900,
          expired: false,
        },
      ],
      incomplete: null,
      overflow: [],
    });
    net.rpc = {
      getLatestLedger: vi.fn(async () => ({ sequence: 1000 })),
      simulateTransaction: vi.fn(async () => {
        throw new Error("contract code entry is archived");
      }),
    };
    const actor = realActors(input({ destination: DEST, useMediator: false }));
    await settle(actor, "awaiting_confirmation");
    const revoke = [...actor.getSnapshot().context.tree!.allNodes.values()].find(
      (n) => n.kind === "RevokeAllowance",
    )!;
    expect(revoke.status).toBe("failed");
    expect(revoke.error).toMatch(/contract code entry is archived/);
    actor.stop();
  });
});

describe("discovery keeps its detail and never reads a timeout as an empty account", () => {
  it("records an unfinished position scan as an error with its detail, without console noise", async () => {
    const warn = vi.spyOn(console, "warn");
    getPositions.mockImplementation(() => new Promise(() => {}));
    scanAllowances.mockRejectedValue({ code: -32001, message: "processing limit" });
    const actor = createActor(
      pageFlowMachine.provide({
        actors: {
          preview: fromPromise(() => new Promise(() => {})) as never,
        },
      }),
    ).start();
    actor.send({ type: "START", input: input({ destination: DEST, useMediator: false }) });
    await settle(actor, "previewing");
    const ctx = actor.getSnapshot().context;
    expect(ctx.positions.errors).toEqual([
      { protocol: "all", message: "getPositions timed out after 30000ms" },
    ]);
    expect(ctx.discoveryWarnings.join(" ")).toMatch(/couldn't finish checking for DeFi positions/);
    expect(ctx.discoveryDiagnostics).toEqual(
      expect.arrayContaining([
        "allowance scan: processing limit",
        "position discovery: getPositions timed out after 30000ms",
      ]),
    );
    expect(warn).not.toHaveBeenCalled();
    actor.stop();
  });
});

describe("a running close stops when the page goes away", () => {
  it("signs nothing after the actor is stopped mid-close", async () => {
    const connector = signingConnector();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // the audit for the merge is in flight when the user navigates away
    auditAccount.mockImplementation(async () => {
      await gate;
      return makeAudit();
    });
    const actor = withPlan(
      () =>
        tree({
          id: "final-classic-tx",
          kind: "FinalClassicTx",
          dependencies: [],
          description: "close account",
          status: "simulated",
          metadata: { kind: "FinalClassicTx", batches: [], destination: DEST, useMediator: false },
        } as PlanNode),
      input({ destination: DEST, useMediator: false, connector }),
    );
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: DEST.slice(-4), expected: RUN });
    await vi.advanceTimersByTimeAsync(10);
    actor.stop();
    release();
    await vi.runAllTimersAsync();
    expect(connector.signTransaction).not.toHaveBeenCalled();
    expect(net.horizon.submitTransaction).not.toHaveBeenCalled();
  });
});

describe("send-to-destination is offered only where the payment can land", () => {
  const issuer = USDC_ISSUER;
  const line = (code: string, over: Record<string, unknown>) => ({
    asset_type: "credit_alphanum4",
    asset_code: code,
    asset_issuer: issuer,
    balance: "0.0000000",
    limit: "1000.0000000",
    buying_liabilities: "0.0000000",
    is_authorized: true,
    ...over,
  });

  it("needs an authorized line with room for the whole residue", async () => {
    // only the destination's balance lines matter here
    net.horizon.loadAccount.mockImplementationOnce(
      async (id: string) =>
        Object.assign(new Account(id, "1"), {
          balances: [
            line("USDC", {}),
            line("EURC", { is_authorized: false }),
            line("GBPC", { limit: "10.0000000", balance: "9.5000000" }),
            line("JPYC", {
              limit: "10.0000000",
              balance: "8.0000000",
              buying_liabilities: "1.5000000",
            }),
          ],
        }) as never,
    );
    const usable = await fetchDestinationUsableKeys(DEST, NETWORK, [
      { key: `USDC:${issuer}`, amount: "5.0000000" },
      { key: `EURC:${issuer}`, amount: "1.0000000" },
      { key: `GBPC:${issuer}`, amount: "1.0000000" },
      { key: `JPYC:${issuer}`, amount: "1.0000000" },
      { key: `BRLC:${issuer}`, amount: "1.0000000" },
    ]);
    expect([...usable]).toEqual([`USDC:${issuer}`]);
  });

  it("offers nothing when the destination account does not exist", async () => {
    const usable = await fetchDestinationUsableKeys(MEDIATOR_A, NETWORK, [
      { key: `USDC:${issuer}`, amount: "1.0000000" },
    ]);
    expect(usable.size).toBe(0);
  });
});

describe("a signed bundle is checked against the account as it is now", () => {
  const OTHER_KP = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(31));
  const snapshot = {
    signers: [{ key: USER, weight: 1 }],
    thresholds: { low: 0, med: 0, high: 0 },
  };
  function signedBundle(signers: Keypair[] = [USER_KP], fee = "100") {
    const tx = new TransactionBuilder(new Account(USER, "100"), {
      fee,
      networkPassphrase: PASS,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 3600 },
    })
      .addOperation(Operation.accountMerge({ destination: DEST }))
      .build();
    for (const kp of signers) tx.sign(kp);
    return {
      signedXdr: tx.toEnvelope().toXdr("base64"),
      planId: Buffer.from(tx.hash()).toString("hex"),
    };
  }
  const event = (b = signedBundle(), snap = snapshot) => ({
    type: "SUBMIT_BUNDLE" as const,
    ...b,
    typed: DEST.slice(-4),
    expected: RUN,
    snapshot: snap,
  });
  const mergeOnly = () =>
    tree({
      id: "final-classic-tx",
      kind: "FinalClassicTx",
      dependencies: [],
      description: "close account",
      status: "simulated",
      metadata: { kind: "FinalClassicTx", batches: [], destination: DEST, useMediator: false },
    } as PlanNode);
  const direct = () => input({ destination: DEST, useMediator: false });

  it("refuses to submit while a defi position is open", async () => {
    getPositions.mockResolvedValue({
      ...EMPTY_POSITIONS,
      backstop: [{ poolId: "CPOOL", shares: 5n, queuedForWithdrawal: 0n }],
    });
    const actor = withPlan(mergeOnly, direct());
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send(event());
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.error).toMatch(
      /DeFi positions the signed close does not unwind/,
    );
    expect(net.horizon.submitTransaction).not.toHaveBeenCalled();
    actor.stop();
  });

  it("refuses a bundle the account moved past, naming why, instead of submitting it", async () => {
    // another transaction from the account landed since the request was built
    net.horizon.accounts.set(USER, 105n);
    const actor = withPlan(mergeOnly, direct());
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send(event());
    await settle(actor, "failed");
    const ctx = actor.getSnapshot().context;
    expect(ctx.failureKind).toBe("bundle_stale");
    expect(ctx.error).toMatch(/sequence number moved/);
    expect(net.horizon.submitTransaction).not.toHaveBeenCalled();
    actor.stop();
  });

  it("submits only the signatures the account's current signers need", async () => {
    // a signer was removed after it signed: its signature would fail the
    // transaction as tx_bad_auth_extra
    const actor = withPlan(mergeOnly, direct());
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send(event(signedBundle([OTHER_KP, USER_KP])));
    await settle(actor, "succeeded");
    const sent = net.horizon.submitted[0]!;
    expect(sent.signatures).toHaveLength(1);
    expect(USER_KP.verify(sent.hash(), sent.signatures[0]!.signature.toBytes())).toBe(true);
    actor.stop();
  });

  it("refuses when the collected signatures no longer meet the account's threshold", async () => {
    net.horizon.signers.push({ type: "ed25519_public_key", key: OTHER_KP.publicKey(), weight: 1 });
    const twoOfTwo = {
      signers: [
        { key: USER, weight: 1 },
        { key: OTHER_KP.publicKey(), weight: 1 },
      ],
      thresholds: { low: 0, med: 0, high: 0 },
    };
    const realLoad = net.horizon.loadAccount.getMockImplementation()!;
    net.horizon.loadAccount.mockImplementation(async (id: string) => {
      const acct = await realLoad(id);
      return id === USER
        ? Object.assign(acct, {
            thresholds: { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
          })
        : acct;
    });
    const actor = withPlan(mergeOnly, direct());
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send(
      event(signedBundle([USER_KP]), { ...twoOfTwo, thresholds: { low: 2, med: 2, high: 2 } }),
    );
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.error).toMatch(/Not enough signatures/);
    expect(net.horizon.submitTransaction).not.toHaveBeenCalled();
    actor.stop();
  });

  it("offers a fee bump from the connected wallet when the network asks a higher fee", async () => {
    const realSubmit = net.horizon.submitTransaction.getMockImplementation()!;
    net.horizon.submitTransaction.mockImplementationOnce(async () => {
      throw new TransactionFailedError("failed", {
        status: 400,
        statusText: "Bad Request",
        data: { extras: { result_codes: { transaction: "tx_insufficient_fee" } } },
      });
    });
    net.horizon.submitTransaction.mockImplementation(async (tx: Transaction) =>
      realSubmit(
        "innerTransaction" in tx
          ? (tx as unknown as { innerTransaction: Transaction }).innerTransaction
          : tx,
      ),
    );
    const connector = signingConnector();
    const actor = withPlan(mergeOnly, direct());
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    // the run's wallet is the one that pays the bump
    actor.send({ type: "CANCEL" });
    actor.stop();
    const again = withPlan(mergeOnly, input({ destination: DEST, useMediator: false, connector }));
    await waitFor(again, (s) => s.matches("awaiting_confirmation"));
    again.send(event());
    await settle(again, "succeeded");
    expect(connector.signTransaction).toHaveBeenCalledTimes(1);
    const bump = connector.signTransaction.mock.calls[0]![0] as unknown as { feeSource: string };
    expect(bump.feeSource).toBe(USER);
    again.stop();
  });
});

describe("the exchange-forward flow is bound to its terms and its own record", () => {
  it("mints with the network and the deposit memo, in preview and at execute", async () => {
    submitMediatorForward.mockResolvedValue({
      ok: true,
      txHash: "FWD",
      ledger: 60,
      alreadyDelivered: false,
      flowToken: "TOKEN-1",
    });
    const memo = { type: "id" as const, value: "4242" };
    const plan = () => {
      const t = mediatorPlan();
      (t.allNodes.get("mediator-forward")!.metadata as { memo?: unknown }).memo = memo;
      return t;
    };
    const actor = withPlan(plan, input({ memo }));
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: EXCHANGE.slice(-4), expected: RUN });
    await settle(actor, "succeeded");
    expect(startMediatorFlow).toHaveBeenCalledWith(EXCHANGE, { network: NETWORK.id, memo });
    actor.stop();
  });

  it("refuses to start an exchange close it can't record for recovery, before signing", async () => {
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    const connector = signingConnector();
    const actor = withPlan(mediatorPlan, input({ connector }));
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: EXCHANGE.slice(-4), expected: RUN });
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.error).toMatch(/recovery record/);
    expect(connector.signTransaction).not.toHaveBeenCalled();
    setItem.mockRestore();
    actor.stop();
  });

  it("removes only its own recovery record once its forward landed", async () => {
    // a record another close left for a different temporary account
    savePendingForward({
      publicKey: USER,
      mediatorPublicKey: MEDIATOR_A,
      flowToken: "OTHER",
      ultimateDestination: EXCHANGE,
      networkId: NETWORK.id,
      savedAt: Date.now() - 60_000,
    });
    submitMediatorForward.mockResolvedValue({
      ok: true,
      txHash: "FWD",
      ledger: 60,
      alreadyDelivered: false,
      flowToken: "TOKEN-1",
    });
    const actor = withPlan(mediatorPlan);
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: EXCHANGE.slice(-4), expected: RUN });
    await settle(actor, "succeeded");
    expect(recordFor()).toMatchObject({ mediatorPublicKey: MEDIATOR_A, flowToken: "OTHER" });
    actor.stop();
  });
});

describe("one close per account runs in a tab", () => {
  it("refuses a second execute for the same account while the first is still running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    auditAccount.mockImplementation(async () => {
      await gate;
      return makeAudit();
    });
    const plan = () =>
      tree({
        id: "final-classic-tx",
        kind: "FinalClassicTx",
        dependencies: [],
        description: "close account",
        status: "simulated",
        metadata: { kind: "FinalClassicTx", batches: [], destination: DEST, useMediator: false },
      } as PlanNode);
    const first = withPlan(plan, input({ destination: DEST, useMediator: false }));
    const second = withPlan(plan, input({ destination: DEST, useMediator: false }));
    await waitFor(first, (s) => s.matches("awaiting_confirmation"));
    await waitFor(second, (s) => s.matches("awaiting_confirmation"));
    first.send({ type: "CONFIRM", typed: DEST.slice(-4), expected: RUN });
    await vi.advanceTimersByTimeAsync(10);
    second.send({ type: "CONFIRM", typed: DEST.slice(-4), expected: RUN });
    await settle(second, "failed");
    expect(second.getSnapshot().context.failureKind).toBe("close_running");
    release();
    await settle(first, "succeeded");
    expect(net.horizon.submitted).toHaveLength(1);
    first.stop();
    second.stop();
  });

  it("says so at once when another tab holds the close, instead of waiting on its lock", async () => {
    // another tab's close holds the exclusive lock; a request for it would never
    // be granted while that close runs
    const request = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        query: async () => ({ held: [{ name: `account-demolisher:close:${USER}` }], pending: [] }),
        request,
      },
    });
    try {
      const actor = withPlan(
        () =>
          tree({
            id: "final-classic-tx",
            kind: "FinalClassicTx",
            dependencies: [],
            description: "close account",
            status: "simulated",
            metadata: {
              kind: "FinalClassicTx",
              batches: [],
              destination: DEST,
              useMediator: false,
            },
          } as PlanNode),
        input({ destination: DEST, useMediator: false }),
      );
      await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
      actor.send({ type: "CONFIRM", typed: DEST.slice(-4), expected: RUN });
      await settle(actor, "failed");
      expect(actor.getSnapshot().context.failureKind).toBe("close_running");
      expect(actor.getSnapshot().context.error).toMatch(/another tab/);
      expect(request).not.toHaveBeenCalled();
      actor.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("discovery reports partial scans and drops spent allowances", () => {
  function discoverOnly() {
    const actor = createActor(
      pageFlowMachine.provide({
        actors: { preview: fromPromise(() => new Promise(() => {})) as never },
      }),
    ).start();
    actor.send({ type: "START", input: input({ destination: DEST, useMediator: false }) });
    return actor;
  }
  const incomplete = {
    reason: "budget" as const,
    coveredFromLedger: 900,
    rangeStartLedger: 1,
    lastLedger: 1000,
    detail: "ran out of time after 20000ms",
  };

  it("keeps what a partial held-token scan found and says how much it covered", async () => {
    discoverHeldTokens.mockResolvedValue({
      held: [{ contractId: HOSTILE_TOKEN, balance: 5n }],
      unreadable: [],
      incomplete,
    });
    const actor = discoverOnly();
    await settle(actor, "previewing");
    const ctx = actor.getSnapshot().context;
    expect(ctx.heldTokens).toHaveLength(1);
    expect(ctx.discoveryWarnings.join(" ")).toMatch(
      /standalone \(custom SEP-41\) tokens checked only/,
    );
    expect(ctx.discoveryDiagnostics).toContain("held-token scan: ran out of time after 20000ms");
    actor.stop();
  });

  it("keeps what a partial allowance scan found and says so", async () => {
    const spender = allowlisted("soroswap", "SoroswapRouter");
    scanAllowances.mockResolvedValue({
      records: [
        {
          contractId: HOSTILE_TOKEN,
          spender,
          amount: 5n,
          live_until_ledger: 5000,
          lastSeenLedger: 950,
          expired: false,
        },
      ],
      incomplete,
      overflow: [],
    });
    const actor = discoverOnly();
    await settle(actor, "previewing");
    const ctx = actor.getSnapshot().context;
    expect(ctx.allowances).toHaveLength(1);
    expect(ctx.discoveryWarnings.join(" ")).toMatch(/token spending permissions checked only/);
    actor.stop();
  });

  it("leaves out an allowance that reads zero on chain, so no revoke is signed for it", async () => {
    const spender = allowlisted("soroswap", "SoroswapRouter");
    const record = (contractId: string) => ({
      contractId,
      spender,
      amount: 5n,
      live_until_ledger: 5000,
      lastSeenLedger: 950,
      expired: false,
    });
    scanAllowances.mockResolvedValue({
      records: [record(HOSTILE_TOKEN), record(USDC_SAC)],
      incomplete: null,
      overflow: [],
    });
    confirmAllowancesOnChain.mockImplementation(async (_s, _o, records: { contractId: string }[]) =>
      records.map((r) => ({ ...r, onChainAmount: r.contractId === HOSTILE_TOKEN ? 0n : 5n })),
    );
    const actor = discoverOnly();
    await settle(actor, "previewing");
    expect(actor.getSnapshot().context.allowances.map((a) => a.contractId)).toEqual([USDC_SAC]);
    actor.stop();
  });
});

describe("the real preview checks the merge before anything is signed", () => {
  function realActors(i: PageFlowInput) {
    const actor = createActor(pageFlowMachine).start();
    actor.send({ type: "START", input: i });
    return actor;
  }
  const frozen = {
    asset: { kind: "credit" as const, code: "USDC", issuer: USDC_ISSUER },
    amount: "5.0000000",
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    limit: "1000",
    isAuthorized: false,
  };

  it("offers no option for a frozen balance and blocks the close with the issuer's freeze", async () => {
    auditAccount.mockImplementation(async () =>
      makeAudit({ subentryCount: 1, balances: [...makeAudit().balances, frozen] }),
    );
    const actor = realActors(input({ destination: DEST, useMediator: false }));
    await settle(actor, "awaiting_confirmation");
    const ctx = actor.getSnapshot().context;
    expect(ctx.unroutableCredits).toEqual([]);
    expect(ctx.reviewBlockers.join(" ")).toMatch(/Frozen by the issuer/);
    actor.send({ type: "CONFIRM", typed: DEST.slice(-4), expected: RUN });
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    actor.stop();
  });

  it("never offers send-to-destination on an exchange close, and reads no destination line", async () => {
    auditAccount.mockImplementation(async () =>
      makeAudit({
        subentryCount: 1,
        balances: [...makeAudit().balances, { ...frozen, isAuthorized: true }],
      }),
    );
    const actor = realActors(input());
    await settle(actor, "awaiting_confirmation");
    const credit = actor.getSnapshot().context.unroutableCredits[0];
    expect(credit).toMatchObject({ code: "USDC", destinationTrusts: false });
    expect(net.horizon.loadAccount).not.toHaveBeenCalledWith(EXCHANGE);
    actor.stop();
  });
});

describe("the preview leaves a step built after earlier ones pending", () => {
  it("does not fail or skip a deferred step, and keeps a real hydration error on a failed one", async () => {
    const deferred = {
      id: "withdraw",
      kind: "WithdrawBlend",
      dependencies: ["claim"],
      description: "withdraw collateral",
      status: "pending",
      deferred: { after: ["claim"], reason: "health factor below 1 until the claim lands" },
      metadata: {
        kind: "WithdrawBlend",
        poolId: allowlisted("blend", "BlendPool::"),
        asset: USDC_SAC,
        bucket: "collateral",
      },
    } as PlanNode;
    const unbuilt = {
      id: "claim",
      kind: "ClaimBlendEmissions",
      dependencies: [],
      description: "claim emissions",
      status: "pending",
      metadata: { kind: "ClaimBlendEmissions", poolId: ATTACKER, reserveTokenIds: [1] },
    } as unknown as PlanNode;
    const t = tree(unbuilt, deferred);
    await simulatePreviewTree(t, new Map([["claim", "pool is not on the allow-list"]]), {
      server: net.rpc as never,
      network: NETWORK,
      userPublicKey: USER,
      fetchSourceAccount: async () => {
        throw new Error("not used");
      },
    });
    expect(deferred.status).toBe("pending");
    expect(deferred.error).toBeUndefined();
    expect(unbuilt.status).toBe("failed");
    expect(unbuilt.error).toBe("pool is not on the allow-list");
  });
});

describe("a run that only prepares the close never reads as a closed account", () => {
  const unlocksAt = new Date("2026-10-28T00:00:00Z");
  // a plan with no merge: a backstop queue stays locked after this run. the
  // unwind step finds nothing to do, so the run needs no signature.
  const preparePlan = (): PlanTree => ({
    ...tree({
      id: "classic-unwind",
      kind: "ClassicUnwind",
      dependencies: [],
      description: "unwind offers",
      status: "simulated",
      metadata: {
        kind: "ClassicUnwind",
        batches: [{ operations: [], destination: DEST }],
        offerIds: [],
        poolIds: [],
        repayAssets: [USDC_SAC],
      },
    } as unknown as PlanNode),
    prepareOnly: { unlocksAt, reason: "A Blend backstop withdrawal stays locked." },
  });

  it("ends in prepared with the unlock date, never in succeeded or as a finished demolition", async () => {
    const actor = withPlan(preparePlan, input({ destination: DEST, useMediator: false }));
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: DEST.slice(-4), expected: RUN });
    await settle(actor, "prepared");
    const ctx = actor.getSnapshot().context;
    expect(ctx.preparedClose).toEqual({
      unlocksAt,
      reason: "A Blend backstop withdrawal stays locked.",
    });
    expect(ctx.result?.mergedTxHash).toBeUndefined();
    const last = ctx.progress.at(-1);
    expect(last?.message).toMatch(/^Preparation complete\. The account stays open\./);
    expect(last?.txHash).toBeUndefined();
    expect(ctx.progress.map((p) => p.message).join(" ")).not.toMatch(/Demolition complete/);
    expect(net.horizon.accounts.has(USER)).toBe(true);
    actor.send({ type: "RESET" });
    expect(actor.getSnapshot().matches("idle")).toBe(true);
    expect(actor.getSnapshot().context.preparedClose).toBeNull();
    actor.stop();
  });

  it("fails a plan that has neither a merge nor a prepare-only reason", async () => {
    const actor = withPlan(
      () => {
        const { prepareOnly: _, ...rest } = preparePlan();
        return rest;
      },
      input({ destination: DEST, useMediator: false }),
    );
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: DEST.slice(-4), expected: RUN });
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.error).toMatch(/no merge step/);
    expect(progressKinds(actor)).not.toContain("complete");
    actor.stop();
  });

  it("does not mint an exchange-forward flow for a plan that only prepares", async () => {
    const backstop = {
      poolId: allowlisted("blend", "BlendPool"),
      backstopId: "C",
      shares: 0n,
      queuedForWithdrawal: 10n,
      unlockedQueuedForWithdrawal: 0n,
    };
    getPositions.mockResolvedValue({ ...EMPTY_POSITIONS, backstop: [backstop] });
    const actor = createActor(pageFlowMachine).start();
    actor.send({ type: "START", input: input() });
    await settle(actor, "awaiting_confirmation");
    const ctx = actor.getSnapshot().context;
    expect(startMediatorFlow).not.toHaveBeenCalled();
    expect(ctx.tree?.prepareOnly).toBeDefined();
    expect([...ctx.tree!.allNodes.values()].map((n) => n.kind)).not.toContain("FinalClassicTx");
    expect(ctx.discoveryWarnings.join(" ")).toMatch(/backstop withdrawal stays locked/);
    actor.stop();
  });
});

describe("backstop emissions that can't be claimed need the user's forfeit", () => {
  const pool = allowlisted("blend", "BlendPool");
  const deposit = {
    poolId: pool,
    shares: 50n,
    queuedForWithdrawal: 0n,
    unlockedQueuedForWithdrawal: 0n,
    accruedEmissions: 7_114_578_242n,
  };

  beforeEach(() => {
    // what the adapter throws for every mainnet backstop claim today
    buildBackstopClaimTx.mockRejectedValue(
      new BackstopClaimUnavailableError(
        pool,
        "CBACKSTOP",
        7_114_578_242n,
        "HostError: VM call trapped: UnreachableCodeReached",
      ),
    );
    buildBackstopQueueTx.mockRejectedValue(new Error("the queue is not built in this test"));
  });

  it("blocks the confirm with the accrued BLND while the claim can't be built", async () => {
    getPositions.mockResolvedValue({ ...EMPTY_POSITIONS, backstop: [deposit] });
    const actor = createActor(pageFlowMachine).start();
    actor.send({ type: "START", input: input({ destination: DEST, useMediator: false }) });
    await settle(actor, "awaiting_confirmation");
    const ctx = actor.getSnapshot().context;
    expect(ctx.emissionForfeits).toEqual([
      {
        poolId: pool,
        accruedEmissions: 7_114_578_242n,
        reason: "the claim fails when simulated against the chain today",
      },
    ]);
    actor.send({ type: "CONFIRM", typed: DEST.slice(-4), expected: RUN });
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    actor.stop();
  });

  it("plans the queue without the claim once the user forfeits it, and says so", async () => {
    getPositions.mockResolvedValue({ ...EMPTY_POSITIONS, backstop: [deposit] });
    const actor = createActor(pageFlowMachine).start();
    actor.send({
      type: "START",
      input: input({
        destination: DEST,
        useMediator: false,
        forfeitBackstopEmissionPoolIds: [pool],
      }),
    });
    await settle(actor, "awaiting_confirmation");
    const ctx = actor.getSnapshot().context;
    const kinds = [...ctx.tree!.allNodes.values()].map((n) => n.kind);
    expect(kinds).toContain("BackstopQueue");
    expect(kinds).not.toContain("ClaimBackstopEmissions");
    expect(ctx.emissionForfeits).toEqual([]);
    expect(ctx.discoveryWarnings.join(" ")).toMatch(
      /711\.4578242 BLND of backstop emissions for pool .* are forfeited, as you chose/,
    );
    actor.stop();
  });
});

describe("the review quotes each credit with what the close claims into it", () => {
  it("passes the claimed balances to the path search", async () => {
    const cb = `00000000${"ee".repeat(32)}`;
    const audit = makeAudit({
      subentryCount: 1,
      balances: [
        ...makeAudit().balances,
        {
          asset: { kind: "credit", code: "USDC", issuer: USDC_ISSUER },
          amount: "0.0000000",
          buyingLiabilities: "0.0000000",
          sellingLiabilities: "0.0000000",
          limit: "1000.0000000",
        },
      ],
      claimableBalances: [
        {
          id: cb,
          asset: { kind: "credit", code: "USDC", issuer: USDC_ISSUER },
          amount: "5.0000000",
          sponsor: DEST,
          claimants: [USER],
          predicate: [{ destination: USER, predicate: { unconditional: true } }],
          claimableNow: true,
        },
      ],
    });
    auditAccount.mockResolvedValue(audit);
    const actor = createActor(pageFlowMachine).start();
    actor.send({
      type: "START",
      input: input({ destination: DEST, useMediator: false, selectedClaimableBalanceIds: [cb] }),
    });
    await settle(actor, "awaiting_confirmation");
    expect(resolveCreditPaths).toHaveBeenCalledWith(expect.anything(), NETWORK, {
      claimedBalanceIds: [cb],
    });
    actor.stop();
  });
});
