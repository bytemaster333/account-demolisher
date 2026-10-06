// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";
import {
  Account,
  BadResponseError,
  NotFoundError,
  Operation,
  TransactionBuilder,
  TransactionFailedError,
  type Transaction,
} from "@stellar/stellar-sdk";

import { AccountNotFoundError } from "@/lib/stellar/account-audit";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";
import type { DemolishProgressEvent } from "@/lib/types/plan";
import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";

import {
  DEST,
  EXCHANGE,
  HOSTILE_TOKEN,
  MEDIATOR_A,
  MEDIATOR_B,
  NETWORK,
  PASS,
  USDC_ISSUER,
  USER,
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
const enumerateAllowances = vi.fn();
const discoverHeldTokens = vi.fn();

vi.mock("@/lib/stellar/horizon-client", () => ({ getHorizon: () => net.horizon }));
vi.mock("@/lib/soroban/rpc-client", () => ({ getRpc: () => net.rpc }));
vi.mock("@/lib/stellar/account-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/account-audit")>(
    "@/lib/stellar/account-audit",
  );
  return { ...actual, auditAccount: (...a: unknown[]) => auditAccount(...a) };
});
vi.mock("@/lib/stellar/path-finder", () => ({ resolveCreditPaths: async () => new Map() }));
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
  return { ...actual, enumerateAllowances: (...a: unknown[]) => enumerateAllowances(...a) };
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
import { loadPendingForward } from "@/lib/mediator/pending-flow";

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
    loadAccount: vi.fn(async (id: string) => {
      const seq = accounts.get(id);
      if (seq === undefined) throw notFound();
      return Object.assign(new Account(id, seq.toString()), { balances: [] as unknown[] });
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
  });
  getPositions.mockResolvedValue(EMPTY_POSITIONS);
  enumerateAllowances.mockResolvedValue([]);
  discoverHeldTokens.mockResolvedValue({ held: [], unreadable: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("an exchange close is not complete until the forward lands", () => {
  it("fails as forward_pending, keeps the recovery record, and RETRY re-runs only the forward", async () => {
    submitMediatorForward.mockResolvedValueOnce({ ok: false, error: "HTTP 503 from horizon" });
    const actor = withPlan(mediatorPlan);
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: EXCHANGE.slice(-4) });
    await settle(actor, "failed");

    const failed = actor.getSnapshot().context;
    expect(failed.failureKind).toBe("forward_pending");
    expect(failed.result?.ok).toBe(false);
    expect(progressKinds(actor)).not.toContain("complete");
    expect(net.horizon.accounts.has(USER)).toBe(false);
    expect(loadPendingForward(USER)).toMatchObject({
      mediatorPublicKey: MEDIATOR_B,
      flowToken: "TOKEN-1",
    });

    submitMediatorForward.mockResolvedValueOnce({ ok: true, txHash: "FWD" });
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
    expect(loadPendingForward(USER)).toBeNull();
    actor.stop();
  });

  it("stays failed while the forward keeps failing", async () => {
    submitMediatorForward.mockResolvedValue({ ok: false, error: "HTTP 503 from horizon" });
    const actor = withPlan(mediatorPlan);
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: EXCHANGE.slice(-4) });
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
    submitMediatorForward.mockResolvedValue({ ok: true, txHash: "FWD" });
    const actor = withPlan(mediatorPlan);
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: EXCHANGE.slice(-4) });
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.failureKind).toBe("ambiguous");
    expect(loadPendingForward(USER)).toMatchObject({ mediatorPublicKey: MEDIATOR_B });

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
  function bundleXdr(maxTime = Math.floor(Date.now() / 1000) + 3600): string {
    const tx = new TransactionBuilder(new Account(USER, "100"), {
      fee: "100",
      networkPassphrase: PASS,
      timebounds: { minTime: 0, maxTime },
    })
      .addOperation(Operation.accountMerge({ destination: DEST }))
      .build();
    return tx.toEnvelope().toXdr("base64");
  }
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
      actor.send({ type: "SUBMIT_BUNDLE", signedXdr: bundleXdr(), typed: DEST.slice(-4) });
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
    actor.send({ type: "SUBMIT_BUNDLE", signedXdr: bundleXdr(), typed: DEST.slice(-4) });
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
    actor.send({ type: "SUBMIT_BUNDLE", signedXdr: bundleXdr(), typed: DEST.slice(-4) });
    await settle(actor, "failed");
    expect(actor.getSnapshot().context.failureKind).toBe("bundle_stale");
    actor.send({ type: "RETRY", connector: signingConnector() });
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(actor.getSnapshot().context.signedBundleXdr).toBeNull();
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
    enumerateAllowances.mockResolvedValue([
      { contractId: HOSTILE_TOKEN, spender, amount: 5n, expirationLedger: 5000 },
    ]);
    net.rpc = {
      getLatestLedger: vi.fn(async () => ({ sequence: 1000 })),
      prepareTransaction: vi.fn(async () => {
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
    enumerateAllowances.mockRejectedValue({ code: -32001, message: "processing limit" });
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
    actor.send({ type: "CONFIRM", typed: DEST.slice(-4) });
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
    net.horizon.loadAccount.mockImplementationOnce(async (id: string) =>
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
      }),
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
