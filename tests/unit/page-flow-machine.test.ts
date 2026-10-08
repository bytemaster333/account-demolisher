import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";
import { Account, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import {
  pageFlowMachine,
  classifyFailure,
  confirmBlockers,
  discoveryWarningFor,
  heldTokenDispositionWarnings,
  isRetryableFailure,
  previewBlockers,
  type FailureKind,
  type PageFlowInput,
} from "@/lib/orchestrator/page-flow-machine";
import { CloseFailure, SubmitRejectedError } from "@/lib/orchestrator/failures";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";
import type { DemolishResult } from "@/lib/types/plan";
import type { Connector } from "@/lib/wallet/connector";
import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";
import { txHashHex } from "@/lib/orchestrator/submit";
import { journalFor, landedPhasesOf } from "@/lib/orchestrator/journal";

import { DEST, NETWORK, USER, USER_KP } from "./orchestrator-fixtures";

// the machine's transitions and guards with stand-in actors. the stand-ins keep
// the real actors' contract: execute resolves with { result, tree, failureKind,
// notes, landedPhases } on a failed close and only rejects on a bug. the real
// actors run in orchestrator-actors.test.ts.

const connector = { kind: "secret" } as unknown as Connector;
const otherConnector = { kind: "walletkit" } as unknown as Connector;

const fakeInput = {
  publicKey: "GTEST",
  network: { id: "testnet", passphrase: "Test SDF Network ; September 2015" },
  connector,
  destination: "GDEST",
  useMediator: false,
} as unknown as PageFlowInput;

const fakeAudit = { accountId: "GTEST" } as unknown as AccountAudit;
// the run the page shows, which CONFIRM and SUBMIT_BUNDLE must name
const EXPECTED = { publicKey: "GTEST", networkId: "testnet" };

function node(id: string, kind: string, over: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    kind,
    dependencies: [],
    description: id,
    status: "simulated",
    metadata: { kind },
    ...over,
  } as unknown as PlanNode;
}

function treeOf(...nodes: PlanNode[]): PlanTree {
  return {
    rootNodes: nodes.filter((n) => n.dependencies.length === 0),
    allNodes: new Map(nodes.map((n) => [n.id, n])),
  };
}

const emptyTree = (): PlanTree => ({ allNodes: new Map(), rootNodes: [] });

interface ExecuteCall {
  readonly tree: PlanTree;
  readonly connector: Connector;
  readonly bundle?: { readonly signedXdr: string };
  readonly interrupt: AbortSignal;
}

function failedOutput(tree: PlanTree, errors: string[], failureKind?: FailureKind) {
  return {
    result: { ok: false, errors } as DemolishResult,
    tree,
    ...(failureKind ? { failureKind } : {}),
    notes: [],
    landedPhases: [],
  };
}

function machineWith(opts: {
  tree?: () => PlanTree;
  discover?: () => Promise<unknown>;
  preview?: Record<string, unknown>;
  input?: PageFlowInput;
  execute: (input: ExecuteCall) => Promise<unknown>;
}) {
  const execute = vi.fn(opts.execute);
  const discover = vi.fn(
    opts.discover ??
      (async () => ({
        audit: fakeAudit,
        positions: EMPTY_POSITIONS,
        allowances: [],
        heldTokens: [],
        unreadableHeldTokens: [],
        heldTokenScanFailed: false,
        discoveryWarnings: [],
        discoveryDiagnostics: [],
      })),
  );
  const machine = pageFlowMachine.provide({
    actors: {
      discover: fromPromise(discover) as never,
      preview: fromPromise(async () => ({
        tree: (opts.tree ?? emptyTree)(),
        unroutableCredits: [],
        heldTokenWarnings: [],
        ...opts.preview,
      })) as never,
      execute: fromPromise(({ input }) => execute(input as ExecuteCall)) as never,
    },
  });
  const actor = createActor(machine).start();
  actor.send({ type: "START", input: opts.input ?? fakeInput });
  return { actor, execute, discover };
}

const hang = () => new Promise<never>(() => {});

describe("discoveryWarningFor", () => {
  it("surfaces a Blend backstop stranding warning verbatim (not a generic frame)", () => {
    const message =
      "You hold a Blend backstop deposit in pool CXXX (5 shares). The close does not unwind " +
      "backstop deposits: withdraw it (a queued, 17-day process) before closing, or those funds " +
      "will be stranded.";
    expect(discoveryWarningFor({ protocol: "blend", message })).toBe(message);
  });

  it("keeps a generic frame for a technical load failure", () => {
    const out = discoveryWarningFor({
      protocol: "blend",
      message: "pool CXXX stage=user: Positions.load failed: RPC 500",
    });
    expect(out).toContain("We couldn't check your blend positions");
    expect(out).not.toContain("stage=user");
  });
});

describe("heldTokenDispositionWarnings", () => {
  function heldNode(kind: "TransferAsIs" | "ConvertSorobanToXLM", status: PlanNode["status"]) {
    return node(`${kind}:c`, kind, {
      status,
      error: "simulation reverted",
      metadata: {
        kind,
        asset: {
          kind: "contract",
          contractId: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1",
        },
        amount: 1n,
        destination: "GDEST",
      },
    } as Partial<PlanNode>);
  }

  it("warns that selected tokens can't be forwarded on an exchange close", () => {
    const out = heldTokenDispositionWarnings(emptyTree(), { useMediator: true, selectedCount: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/can't be forwarded to an exchange/);
  });

  it("stays silent on an exchange close when nothing was selected", () => {
    expect(
      heldTokenDispositionWarnings(emptyTree(), { useMediator: true, selectedCount: 0 }),
    ).toEqual([]);
  });

  it("says a drain that failed preview is tried again, and stays behind only if it fails again", () => {
    const out = heldTokenDispositionWarnings(treeOf(heldNode("TransferAsIs", "failed")), {
      useMediator: false,
      selectedCount: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/tries it again; if it still fails, the token stays/);
    expect(out[0]).not.toMatch(/\u2014/);
  });

  it("warns about a conversion that failed preview too", () => {
    const out = heldTokenDispositionWarnings(treeOf(heldNode("ConvertSorobanToXLM", "failed")), {
      useMediator: false,
      selectedCount: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/sends the token to your destination as-is/);
  });

  it("says nothing about a drain that simulated cleanly", () => {
    expect(
      heldTokenDispositionWarnings(treeOf(heldNode("TransferAsIs", "simulated")), {
        useMediator: false,
        selectedCount: 1,
      }),
    ).toEqual([]);
  });
});

describe("the CONFIRM gate", () => {
  it("refuses a CONFIRM whose typed value does not match the destination's last 4", async () => {
    const { actor } = machineWith({ execute: hang });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "WRONG", expected: EXPECTED });
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    actor.stop();
  });

  it("executes on a CONFIRM whose typed value matches the destination's last 4", async () => {
    const { actor, execute } = machineWith({ execute: hang });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    expect(execute.mock.calls[0]![0].connector).toBe(connector);
    actor.stop();
  });

  it("refuses to confirm a plan whose merge or a required step failed preview", async () => {
    for (const failed of [
      node("final-classic-tx", "FinalClassicTx", { status: "failed", error: "fee overflow" }),
      node("withdraw", "WithdrawBlend", { status: "failed", error: "simulation reverted" }),
      node("mediator-forward", "MediatorForward", { status: "failed", error: "no flow" }),
    ]) {
      const { actor, execute } = machineWith({
        tree: () => treeOf(failed),
        execute: hang,
      });
      await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
      expect(previewBlockers(actor.getSnapshot().context.tree)).toHaveLength(1);
      actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
      expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      actor.stop();
    }
  });

  it("lets a best-effort step that failed preview through, to be tried again", async () => {
    const { actor } = machineWith({
      tree: () =>
        treeOf(
          node("drain", "TransferAsIs", { status: "failed", error: "rpc timeout" }),
          node("final-classic-tx", "FinalClassicTx", { dependencies: ["drain"] }),
        ),
      execute: hang,
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    // the executor gets it back as pending, so it runs again
    expect(actor.getSnapshot().context.tree!.allNodes.get("drain")!.status).toBe("pending");
    actor.stop();
  });
});

describe("an unfinished defi discovery blocks the close before anything is signed", () => {
  it("refuses CONFIRM and SUBMIT_BUNDLE while a protocol could not be read", async () => {
    const { actor, execute } = machineWith({
      discover: async () => ({
        audit: fakeAudit,
        positions: {
          ...EMPTY_POSITIONS,
          errors: [{ protocol: "all", message: "getPositions timed out after 30000ms" }],
        },
        allowances: [],
        heldTokens: [],
        unreadableHeldTokens: [],
        heldTokenScanFailed: false,
        discoveryWarnings: [],
        discoveryDiagnostics: [],
      }),
      execute: hang,
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    expect(confirmBlockers(actor.getSnapshot().context)).toEqual([
      expect.stringMatching(/couldn't finish checking for DeFi positions/),
    ]);
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });
});

describe("the multisig bundle is bound to the reviewed close", () => {
  const bundleInput = {
    publicKey: USER,
    network: NETWORK,
    connector,
    destination: DEST,
    useMediator: false,
  } as unknown as PageFlowInput;
  const expected = { publicKey: USER, networkId: NETWORK.id };
  const snapshot = {
    signers: [{ key: USER, weight: 1 }],
    thresholds: { low: 0, med: 0, high: 0 },
  };
  const OTHER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(21)).publicKey();

  function bundle(over: { destination?: string; opSource?: string } = {}) {
    const tx = new TransactionBuilder(new Account(USER, "100"), {
      fee: "100",
      networkPassphrase: NETWORK.passphrase,
      timebounds: { minTime: 0, maxTime: 1_900_000_000 },
    })
      .addOperation(
        Operation.manageData({
          name: "x",
          value: "y",
          ...(over.opSource ? { source: over.opSource } : {}),
        }),
      )
      .addOperation(Operation.accountMerge({ destination: over.destination ?? DEST }))
      .build();
    tx.sign(USER_KP);
    return { signedXdr: tx.toEnvelope().toXdr("base64"), planId: txHashHex(tx) };
  }
  const submit = (b: { signedXdr: string; planId: string }, over: Record<string, unknown> = {}) =>
    ({
      type: "SUBMIT_BUNDLE",
      ...b,
      typed: DEST.slice(-4),
      expected,
      snapshot,
      ...over,
    }) as const;

  async function awaiting(execute: (input: ExecuteCall) => Promise<unknown> = hang) {
    const m = machineWith({ input: bundleInput, execute });
    await waitFor(m.actor, (s) => s.matches("awaiting_confirmation"));
    return m;
  }

  it("submits the bundle and its signer snapshot once everything matches", async () => {
    const { actor, execute } = await awaiting();
    const b = bundle();
    actor.send(submit(b));
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    expect(execute.mock.calls[0]![0].bundle).toEqual({ signedXdr: b.signedXdr, snapshot });
    actor.stop();
  });

  it("refuses without the typed last 4 of the destination, or for another run", async () => {
    const { actor, execute } = await awaiting();
    actor.send(submit(bundle(), { typed: "NOPE" }));
    actor.send(submit(bundle(), { expected: { publicKey: OTHER, networkId: NETWORK.id } }));
    actor.send(submit(bundle(), { expected: { publicKey: USER, networkId: "testnet" } }));
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });

  it("refuses a bundle that is not the request the link names", async () => {
    const { actor, execute } = await awaiting();
    actor.send(submit({ ...bundle(), planId: "0".repeat(64) }));
    actor.send(submit({ signedXdr: "AAAA", planId: "0".repeat(64) }));
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });

  it("refuses a bundle that merges elsewhere or acts on another account", async () => {
    const { actor, execute } = await awaiting();
    actor.send(submit(bundle({ destination: OTHER })));
    actor.send(submit(bundle({ opSource: OTHER })));
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });

  it("drops a stale bundle: RETRY after a bundle_stale failure rebuilds instead of resubmitting", async () => {
    const { actor, execute } = await awaiting(async (input) =>
      failedOutput(
        input.tree,
        ['submitClassic rejected: {"transaction":"tx_too_late"}'],
        "bundle_stale",
      ),
    );
    actor.send(submit(bundle()));
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY", connector });
    const snap = actor.getSnapshot();
    expect(snap.matches("discovering")).toBe(true);
    expect(snap.context.signedBundle).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("refuses the bundle while discovery could not read a protocol", async () => {
    const { actor, execute } = machineWith({
      input: bundleInput,
      discover: async () => ({
        audit: fakeAudit,
        positions: { ...EMPTY_POSITIONS, errors: [{ protocol: "blend", message: "429" }] },
        allowances: [],
        heldTokens: [],
        unreadableHeldTokens: [],
        heldTokenScanFailed: false,
        discoveryWarnings: [],
        discoveryDiagnostics: [],
      }),
      execute: hang,
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send(submit(bundle()));
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });
});

describe("CONFIRM names the run it confirms", () => {
  it("refuses a CONFIRM for another account or network", async () => {
    const { actor, execute } = machineWith({ execute: hang });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: { ...EXPECTED, publicKey: "GOTHER" } });
    actor.send({ type: "CONFIRM", typed: "DEST", expected: { ...EXPECTED, networkId: "mainnet" } });
    expect(actor.getSnapshot().matches("awaiting_confirmation")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });

  it("can be cancelled while discovery or the preview is still running", async () => {
    for (const stage of ["discovering", "previewing"] as const) {
      const machine = pageFlowMachine.provide({
        actors: {
          discover: fromPromise(
            stage === "discovering"
              ? hang
              : async () => ({
                  audit: fakeAudit,
                  positions: EMPTY_POSITIONS,
                  allowances: [],
                  heldTokens: [],
                  unreadableHeldTokens: [],
                  heldTokenScanFailed: false,
                  discoveryWarnings: [],
                  discoveryDiagnostics: [],
                }),
          ) as never,
          preview: fromPromise(hang) as never,
        },
      });
      const actor = createActor(machine).start();
      actor.send({ type: "START", input: fakeInput });
      await waitFor(actor, (s) => s.matches(stage));
      actor.send({ type: "CANCEL" });
      expect(actor.getSnapshot().matches("cancelled")).toBe(true);
      expect(actor.getSnapshot().context.connector).toBeNull();
      actor.stop();
    }
  });
});

describe("what the preview found blocks the close until it is resolved", () => {
  it("refuses CONFIRM while a balance can't be disposed of as planned", async () => {
    const { actor, execute } = machineWith({
      execute: hang,
      preview: {
        unroutableCredits: [
          {
            key: "JUNK:GISSUER",
            code: "JUNK",
            issuer: "GISSUER",
            amount: "5.0000000",
            reason: "no_path",
          },
        ],
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    expect(confirmBlockers(actor.getSnapshot().context)).toEqual([
      expect.stringMatching(/5\.0000000 JUNK can't be disposed of as planned \(no market path/),
    ]);
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    expect(execute).not.toHaveBeenCalled();
    actor.stop();
  });

  it("refuses CONFIRM on a mergeability or funding blocker, a refused conversion or an unacknowledged forfeit", async () => {
    for (const preview of [
      { reviewBlockers: ["Frozen by the issuer: 5 USDC"] },
      {
        refusedConversions: [
          {
            key: "contract:CTOKEN",
            contractId: "CTOKEN",
            refusal: "price_impact",
            reason: "9.00% price impact",
          },
        ],
      },
      { emissionForfeits: [{ poolId: "CPOOL", accruedEmissions: 18_611_659n, reason: "trapped" }] },
    ]) {
      const { actor, execute } = machineWith({ execute: hang, preview });
      await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
      expect(confirmBlockers(actor.getSnapshot().context)).toHaveLength(1);
      actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
      expect(execute).not.toHaveBeenCalled();
      actor.stop();
    }
  });

  it("does not offer to accept a price for a token with no route at all", async () => {
    const { actor } = machineWith({
      execute: hang,
      preview: {
        refusedConversions: [
          {
            key: "contract:CTOKEN",
            contractId: "CTOKEN",
            refusal: "no_route",
            reason: "No Soroswap route from CTOKEN to XLM (no pair path exists)",
          },
        ],
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    expect(confirmBlockers(actor.getSnapshot().context)).toEqual([
      "Token CTOKEN can't be converted: it has no route to XLM. Send it as-is or leave it.",
    ]);
    actor.stop();
  });

  it("names the BLND an unacknowledged forfeit would leave behind, once", async () => {
    const claim = node("claim", "ClaimBackstopEmissions", {
      status: "failed",
      error: "UnreachableCodeReached",
      metadata: { kind: "ClaimBackstopEmissions", poolId: "CPOOL" },
    } as unknown as Partial<PlanNode>);
    const { actor } = machineWith({
      execute: hang,
      tree: () => treeOf(claim),
      preview: {
        emissionForfeits: [{ poolId: "CPOOL", accruedEmissions: 18_611_659n, reason: "trapped" }],
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    const blockers = confirmBlockers(actor.getSnapshot().context);
    expect(blockers).toEqual([expect.stringMatching(/leave 1\.8611659 BLND unclaimed/)]);
    actor.stop();
  });

  it("lists a refused conversion once, not again as a failed step", async () => {
    const convert = node("convert", "ConvertSorobanToXLM", {
      status: "failed",
      error: "ConvertSorobanToXLM: selling the whole balance has a 9.00% price impact",
      metadata: {
        kind: "ConvertSorobanToXLM",
        asset: { kind: "contract", contractId: "CTOKEN" },
        amount: 5n,
      },
    } as unknown as Partial<PlanNode>);
    const { actor } = machineWith({
      execute: hang,
      tree: () => treeOf(convert),
      preview: {
        refusedConversions: [
          {
            key: "contract:CTOKEN",
            contractId: "CTOKEN",
            refusal: "price_impact",
            reason: "9.00% price impact",
          },
        ],
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    expect(confirmBlockers(actor.getSnapshot().context)).toEqual([
      expect.stringMatching(/^Converting token CTOKEN was refused for its price/),
    ]);
    actor.stop();
  });

  it("hands the trustline gaps discovery found to the preview", async () => {
    const gaps = [{ contractId: "CUSDC", code: "USDC", issuer: "GISSUER", reason: "missing" }];
    const unopenable = [
      {
        contractId: "CEURT",
        code: "EURT",
        issuer: "GEURT",
        reason: "issuer_missing",
      },
    ];
    const previewInputs: Record<string, unknown>[] = [];
    const machine = pageFlowMachine.provide({
      actors: {
        discover: fromPromise(async () => ({
          audit: fakeAudit,
          positions: EMPTY_POSITIONS,
          allowances: [],
          heldTokens: [],
          unreadableHeldTokens: [],
          heldTokenScanFailed: false,
          discoveryWarnings: [],
          discoveryDiagnostics: [],
          exitTrustlineGaps: gaps,
          unopenableExitLines: unopenable,
        })) as never,
        preview: fromPromise(async ({ input }: { input: Record<string, unknown> }) => {
          previewInputs.push(input);
          return { tree: emptyTree(), unroutableCredits: [], heldTokenWarnings: [] };
        }) as never,
      },
    });
    const actor = createActor(machine).start();
    actor.send({ type: "START", input: fakeInput });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    expect(previewInputs[0]!["exitTrustlineGaps"]).toEqual(gaps);
    expect(previewInputs[0]!["unopenableExitLines"]).toEqual(unopenable);
    expect(previewInputs[0]).not.toHaveProperty("aquariusRewardToken");
    actor.stop();
  });

  it("hands the aquarius reward token discovery read to the preview", async () => {
    const previewInputs: Record<string, unknown>[] = [];
    const machine = pageFlowMachine.provide({
      actors: {
        discover: fromPromise(async () => ({
          audit: fakeAudit,
          positions: EMPTY_POSITIONS,
          allowances: [],
          heldTokens: [],
          unreadableHeldTokens: [],
          heldTokenScanFailed: false,
          discoveryWarnings: [],
          discoveryDiagnostics: [],
          exitTrustlineGaps: [],
          aquariusRewardToken: "CAQUA",
        })) as never,
        preview: fromPromise(async ({ input }: { input: Record<string, unknown> }) => {
          previewInputs.push(input);
          return { tree: emptyTree(), unroutableCredits: [], heldTokenWarnings: [] };
        }) as never,
      },
    });
    const actor = createActor(machine).start();
    actor.send({ type: "START", input: fakeInput });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    expect(previewInputs[0]!["aquariusRewardToken"]).toBe("CAQUA");
    actor.stop();
  });

  it("folds the review notes into the warnings the page shows", async () => {
    const { actor } = machineWith({
      execute: hang,
      preview: { reviewNotes: ["The close first opens a BLND trustline"] },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    expect(actor.getSnapshot().context.discoveryWarnings).toContain(
      "The close first opens a BLND trustline",
    );
    actor.stop();
  });
});

describe("RETRY", () => {
  it("re-executes the same tree with the wallet connected now, classified from the real result", async () => {
    const tree = treeOf(node("final-classic-tx", "FinalClassicTx"));
    let calls = 0;
    const { actor, execute } = machineWith({
      tree: () => tree,
      execute: async (input) => {
        calls += 1;
        if (calls === 1) return failedOutput(input.tree, ["Bad Gateway (502)"]);
        return hang();
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    await waitFor(actor, (s) => s.matches("failed"));
    const failed = actor.getSnapshot().context;
    expect(failed.failureKind).toBe("network");
    expect(failed.tree!.allNodes).toBe(tree.allNodes);
    // the close ended, so the wallet it captured is gone
    expect(failed.connector).toBeNull();

    actor.send({ type: "RETRY", connector: otherConnector });
    expect(actor.getSnapshot().matches("executing")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]![0].connector).toBe(otherConnector);
    actor.stop();
  });

  it("resets what did not land so the failed step and the merge run again", async () => {
    const landed = node("withdraw", "WithdrawBlend", {
      status: "confirmed",
      executed: { txHash: "W", ledger: 1 },
    });
    const failedExit = node("repay", "RepayBlend");
    const keptSkip = node("drain", "TransferAsIs", {
      status: "skipped",
      error: "Token drain skipped: reverted",
    });
    const final = node("final-classic-tx", "FinalClassicTx", {
      dependencies: ["withdraw", "repay", "drain"],
    });
    const tree = treeOf(landed, failedExit, keptSkip, final);
    let calls = 0;
    const seen: Record<string, string>[] = [];
    const { actor } = machineWith({
      tree: () => tree,
      execute: async (input) => {
        calls += 1;
        seen.push(
          Object.fromEntries([...input.tree.allNodes.values()].map((n) => [n.id, n.status])),
        );
        if (calls === 1) {
          failedExit.status = "failed";
          failedExit.error = "rpc timeout";
          final.status = "skipped";
          final.error = 'Skipped: dependency "repay" did not complete: rpc timeout';
          return failedOutput(input.tree, ["rpc timeout"], "network");
        }
        return hang();
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY", connector });
    expect(seen[1]).toEqual({
      withdraw: "confirmed",
      repay: "pending",
      drain: "skipped",
      "final-classic-tx": "pending",
    });
    expect(final.error).toBeUndefined();
    actor.stop();
  });

  it("rebuilds the plan when there is no wallet to sign with", async () => {
    const { actor, execute } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      execute: async (input) => failedOutput(input.tree, ["Bad Gateway (502)"], "network"),
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY" });
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(actor.getSnapshot().context.tree).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("rediscovers a diverged-state failure instead of replaying the old tree", async () => {
    const { actor, execute } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      execute: async (input) =>
        failedOutput(input.tree, ["account_merge blocked: 1 Soroban DeFi position(s) still open"]),
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    await waitFor(actor, (s) => s.matches("failed"));
    expect(actor.getSnapshot().context.failureKind).toBe("position_open");
    actor.send({ type: "RETRY", connector });
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("never executes a stale tree after a failed rediscovery", async () => {
    let discoveries = 0;
    const { actor, execute } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      discover: async () => {
        discoveries += 1;
        if (discoveries > 1) throw new Error("auditAccount timed out after 30000ms");
        return {
          audit: fakeAudit,
          positions: EMPTY_POSITIONS,
          allowances: [],
          heldTokens: [],
          unreadableHeldTokens: [],
          heldTokenScanFailed: false,
          discoveryWarnings: [],
          discoveryDiagnostics: [],
        };
      },
      execute: async (input) =>
        failedOutput(input.tree, ["account_merge blocked: account is auth immutable"]),
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY", connector });
    await waitFor(actor, (s) => s.matches("failed"));
    const snap = actor.getSnapshot();
    expect(snap.context.failureKind).toBe("network");
    expect(snap.context.tree).toBeNull();
    expect(snap.context.signedBundle).toBeNull();
    actor.send({ type: "RETRY", connector });
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  it("treats a rejected execute actor as a bug in the onError branch, keeping the tree", async () => {
    const tree = treeOf(node("final-classic-tx", "FinalClassicTx"));
    const { actor } = machineWith({
      tree: () => tree,
      execute: async () => {
        throw new Error("executing: missing tree from preview");
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    await waitFor(actor, (s) => s.matches("failed"));
    const snap = actor.getSnapshot().context;
    expect(snap.error).toBe("executing: missing tree from preview");
    expect(snap.failureKind).toBe("unknown");
    expect(snap.tree!.allNodes).toBe(tree.allNodes);
    actor.stop();
  });
});

describe("a rebuild starts from an empty discovery", () => {
  it("drops the last run's scan results while the new discovery runs", async () => {
    const token = { contractId: "CTOKEN", balance: 5n };
    let discoveries = 0;
    const { actor } = machineWith({
      execute: hang,
      discover: async () => {
        discoveries += 1;
        if (discoveries > 1) return hang();
        return {
          audit: fakeAudit,
          positions: { ...EMPTY_POSITIONS, soroswap: [{ pair: {}, shareBalance: 1n }] },
          allowances: [{ contractId: "CTOKEN", spender: "CSPENDER", amount: 1n }],
          heldTokens: [token],
          unreadableHeldTokens: ["CUNREAD"],
          heldTokenScanFailed: true,
          discoveryWarnings: ["warned"],
          discoveryDiagnostics: ["diag"],
          exitTrustlineGaps: [
            { contractId: "CUSDC", code: "USDC", issuer: "GI", reason: "missing" },
          ],
          unopenableExitLines: [],
          aquariusRewardToken: "CAQUA",
        };
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    expect(actor.getSnapshot().context.heldTokens).toEqual([token]);
    actor.send({ type: "START", input: fakeInput });
    expect(actor.getSnapshot().matches("discovering")).toBe(true);
    const ctx = actor.getSnapshot().context;
    expect(ctx.audit).toBeNull();
    expect(ctx.positions).toBe(EMPTY_POSITIONS);
    expect(ctx.allowances).toEqual([]);
    expect(ctx.heldTokens).toEqual([]);
    expect(ctx.unreadableHeldTokens).toEqual([]);
    expect(ctx.heldTokenScanFailed).toBe(false);
    expect(ctx.exitTrustlineGaps).toEqual([]);
    expect(ctx.aquariusRewardToken).toBeNull();
    actor.stop();
  });
});

describe("a rejected execute still reports the batches that landed", () => {
  it("shows every classic phase on chain, not the list an earlier attempt left", async () => {
    const unwind = node("classic-unwind", "ClassicUnwind");
    const final = node("final-classic-tx", "FinalClassicTx", { dependencies: ["classic-unwind"] });
    const tree = treeOf(unwind, final);
    let calls = 0;
    const { actor } = machineWith({
      tree: () => tree,
      execute: async (input) => {
        calls += 1;
        if (calls === 1) {
          journalFor(unwind).landedPhases.push({ txHash: "UNWIND", ledger: 1 });
          return {
            ...failedOutput(input.tree, ["Bad Gateway (502)"], "network"),
            landedPhases: landedPhasesOf(unwind),
          };
        }
        // phase 0 of the close lands, then the actor itself rejects
        journalFor(final).landedPhases.push({ txHash: "PHASE0", ledger: 2 });
        throw new Error("executing: lost the wallet session");
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY", connector });
    await waitFor(actor, (s) => s.matches("failed") && calls === 2);
    expect(actor.getSnapshot().context.landedPhases.map((p) => p.txHash)).toEqual([
      "UNWIND",
      "PHASE0",
    ]);
    actor.stop();
  });

  it("reports none when nothing landed before the rejection", async () => {
    const { actor } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      execute: async () => {
        throw new Error("executing: missing abort controller");
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    await waitFor(actor, (s) => s.matches("failed"));
    expect(actor.getSnapshot().context.landedPhases).toEqual([]);
    actor.stop();
  });
});

describe("a running close can be stopped", () => {
  it("CANCEL while executing aborts the close at the next step boundary", async () => {
    let signal: AbortSignal | undefined;
    const { actor } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      execute: (input) => {
        signal = input.interrupt;
        return new Promise((resolve) => {
          input.interrupt.addEventListener("abort", () =>
            resolve(failedOutput(input.tree, ["The close was stopped."], "interrupted")),
          );
        });
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    expect(signal?.aborted).toBe(false);
    actor.send({ type: "CANCEL" });
    expect(signal?.aborted).toBe(true);
    await waitFor(actor, (s) => s.matches("failed"));
    expect(actor.getSnapshot().context.failureKind).toBe("interrupted");
    expect(actor.getSnapshot().context.connector).toBeNull();
    actor.stop();
  });

  it("stopping the actor aborts the signal the execute actor runs under", async () => {
    let signal: AbortSignal | undefined;
    const machine = pageFlowMachine.provide({
      actors: {
        discover: fromPromise(async () => ({
          audit: fakeAudit,
          positions: EMPTY_POSITIONS,
          allowances: [],
          heldTokens: [],
          unreadableHeldTokens: [],
          heldTokenScanFailed: false,
          discoveryWarnings: [],
          discoveryDiagnostics: [],
        })) as never,
        preview: fromPromise(async () => ({
          tree: treeOf(node("final-classic-tx", "FinalClassicTx")),
          unroutableCredits: [],
          heldTokenWarnings: [],
        })) as never,
        execute: fromPromise(({ signal: s }) => {
          signal = s;
          return hang();
        }) as never,
      },
    });
    const actor = createActor(machine).start();
    actor.send({ type: "START", input: fakeInput });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    actor.stop();
    expect(signal?.aborted).toBe(true);
  });
});

describe("failure taxonomy", () => {
  it("classifies typed failures by their kind", () => {
    expect(classifyFailure(new CloseFailure("signing", "The wallet did not sign"))).toBe("signing");
    expect(classifyFailure(new SubmitRejectedError({ transaction: "tx_bad_seq" }, 400))).toBe(
      "bad_seq",
    );
    expect(
      classifyFailure(
        new SubmitRejectedError({ transaction: "tx_failed", operations: ["op_no_issuer"] }, 400),
      ),
    ).toBe("not_mergeable");
  });

  it("classifies the messages real code emits", () => {
    expect(classifyFailure('submitClassic rejected: {"transaction":"tx_bad_seq"}')).toBe("bad_seq");
    expect(classifyFailure("submitSoroban: sendTransaction returned ERROR; result txBadSeq")).toBe(
      "bad_seq",
    );
    expect(classifyFailure("simulation failed: restorePreamble required")).toBe(
      "changed_footprint",
    );
    expect(classifyFailure("account_merge blocked: 1 Soroban DeFi position(s) still open")).toBe(
      "position_open",
    );
    expect(classifyFailure("account_merge blocked: account is auth immutable")).toBe(
      "not_mergeable",
    );
    expect(classifyFailure("Bad Gateway (502)")).toBe("network");
    expect(classifyFailure({ code: -32603, message: "fetch failed" })).toBe("network");
    expect(classifyFailure("submitSoroban: transaction ABC123 failed on-chain")).toBe("reverted");
    // a stop whose detail mentions "archived" stays a diverged-state stop
    expect(
      classifyFailure("account_merge blocked: DeFi position(s) still open (entry archived)"),
    ).toBe("position_open");
    // a wallet's own wording is not guessed at; the executor types it
    expect(classifyFailure("User declined")).toBe("unknown");
    // the word "network" alone says nothing
    expect(classifyFailure("the network passphrase does not match")).toBe("unknown");
  });

  it("re-executes only transient kinds; an unknown fault rebuilds the plan", () => {
    for (const k of [
      "position_open",
      "not_mergeable",
      "reverted",
      "unsafe",
      "bundle_stale",
      "mediator_expired",
      "unknown",
    ] as const) {
      expect(isRetryableFailure(k)).toBe(false);
    }
    for (const k of [
      "bad_seq",
      "changed_footprint",
      "network",
      "signing",
      "ambiguous",
      "forward_pending",
      "interrupted",
    ] as const) {
      expect(isRetryableFailure(k)).toBe(true);
    }
  });

  it("does not nest the previous failure into the next one", async () => {
    let calls = 0;
    const { actor } = machineWith({
      tree: () => treeOf(node("final-classic-tx", "FinalClassicTx")),
      execute: async (input) => {
        calls += 1;
        return failedOutput(input.tree, [`HTTP 503 attempt ${calls}`], "network");
      },
    });
    await waitFor(actor, (s) => s.matches("awaiting_confirmation"));
    actor.send({ type: "CONFIRM", typed: "DEST", expected: EXPECTED });
    await waitFor(actor, (s) => s.matches("failed"));
    actor.send({ type: "RETRY", connector });
    await waitFor(actor, (s) => s.matches("failed") && calls === 2);
    expect(actor.getSnapshot().context.error).toBe("HTTP 503 attempt 2");
    actor.stop();
  });
});
