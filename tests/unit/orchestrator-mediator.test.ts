import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  nativeToScVal,
  xdr,
  type Operation,
  type Transaction,
} from "@stellar/stellar-sdk";

import { AccountNotFoundError } from "@/lib/stellar/account-audit";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";

import {
  DEST,
  EXCHANGE,
  MEDIATOR_A,
  MEDIATOR_B,
  NETWORK,
  USDC_ISSUER,
  USDC_SAC,
  USER,
  USER_KP,
  addr,
  allowlisted,
  decode,
  fakeHorizon,
  horizonError,
  i128,
  inv,
  invokeTx,
  makeAudit,
  signingConnector,
  sourceAuth,
  u32,
  type FakeAccount,
} from "./orchestrator-fixtures";

// the exchange-forward flow as the executor drives it. the audit, path and
// forward network edges are replaced; the batcher, builder, guards and signing are
// real, and the horizon double's account table follows what each signed batch
// actually does on chain.
const auditAccount = vi.fn();
const submitMediatorForward = vi.fn();

vi.mock("@/lib/stellar/account-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/account-audit")>(
    "@/lib/stellar/account-audit",
  );
  return { ...actual, auditAccount: (...args: unknown[]) => auditAccount(...args) };
});
vi.mock("@/lib/stellar/path-finder", () => ({ resolveCreditPaths: async () => new Map() }));
vi.mock("@/lib/mediator/forward", () => ({
  submitMediatorForward: (...args: unknown[]) => submitMediatorForward(...args),
}));

import {
  executePlanTreeOnChain,
  type ExecutorDeps,
  type MediatorFlowControl,
  type PersistedFlow,
} from "@/lib/orchestrator/executor";
import { journalFor } from "@/lib/orchestrator/journal";

const MINUTE = 60_000;
const T0 = 1_800_000_000_000;
const POOL = allowlisted("blend", "BlendPool::");

function tree(...nodes: PlanNode[]): PlanTree {
  return {
    rootNodes: nodes.filter((n) => n.dependencies.length === 0),
    allNodes: new Map(nodes.map((n) => [n.id, n])),
  };
}

// the plan as preview left it: a preview-minted mediator that was never funded
function mediatorTree(previewMediator: string, extra: PlanNode[] = []): PlanTree {
  const final = {
    id: "final-classic-tx",
    kind: "FinalClassicTx",
    dependencies: extra.map((n) => n.id),
    description: "close account",
    status: "simulated",
    metadata: {
      kind: "FinalClassicTx",
      batches: [],
      destination: EXCHANGE,
      useMediator: true,
      mediatorPublicKey: previewMediator,
    },
  } as PlanNode;
  const forward = {
    id: "mediator-forward",
    kind: "MediatorForward",
    dependencies: ["final-classic-tx"],
    description: "forward to the exchange",
    status: "simulated",
    metadata: {
      kind: "MediatorForward",
      mediatorPublicKey: previewMediator,
      flowToken: "PREVIEW-TOKEN",
      ultimateDestination: EXCHANGE,
      memo: { type: "id", value: "777" },
    },
  } as PlanNode;
  return tree(...extra, final, forward);
}

// a required blend withdraw that runs before the merge
function withdrawNode(): PlanNode {
  return {
    id: "withdraw",
    kind: "WithdrawBlend",
    dependencies: [],
    description: "withdraw from blend",
    status: "simulated",
    metadata: { kind: "WithdrawBlend", poolId: POOL, asset: USDC_SAC, bucket: "supply" },
  } as PlanNode;
}

function blendWithdrawTx(account: Account): Transaction {
  const req = xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: nativeToScVal("address", { type: "symbol" }),
        val: addr(USDC_SAC),
      }),
      new xdr.ScMapEntry({ key: nativeToScVal("amount", { type: "symbol" }), val: i128(5n) }),
      new xdr.ScMapEntry({ key: nativeToScVal("request_type", { type: "symbol" }), val: u32(1) }),
    ]),
  ]);
  const args = [addr(USER), addr(USER), addr(USER), req];
  return invokeTx(account, POOL, "submit", args, [sourceAuth(inv(POOL, "submit", args))]);
}

interface Harness {
  readonly table: Map<string, FakeAccount>;
  readonly log: string[];
  readonly control: MediatorFlowControl & {
    mint: ReturnType<typeof vi.fn>;
    persist: ReturnType<typeof vi.fn>;
    reissue?: ReturnType<typeof vi.fn>;
  };
  deps: ExecutorDeps & { connector: ReturnType<typeof signingConnector> };
  clock: number;
}

function harness(
  opts: {
    previous?: PersistedFlow | null;
    reissue?: boolean;
    mintKey?: string;
    over?: Partial<ExecutorDeps>;
  } = {},
): Harness {
  const table = new Map<string, FakeAccount>([[USER, { seq: 100n, balances: [] }]]);
  const log: string[] = [];
  const h = { table, log, clock: T0 } as Harness;
  const mintKey = opts.mintKey ?? MEDIATOR_B;
  const control = {
    mint: vi.fn(async () => {
      log.push("mint");
      return { mediatorPublicKey: mintKey, flowToken: "MINTED-TOKEN" };
    }),
    persist: vi.fn((flow: PersistedFlow) => {
      log.push(`persist:${flow.mediatorPublicKey}:${flow.flowToken}`);
    }),
    previous: () => opts.previous ?? null,
    forwarded: vi.fn(),
    ...(opts.reissue
      ? {
          reissue: vi.fn(async () => {
            log.push("reissue");
            return { flowToken: "RENEWED-TOKEN" };
          }),
        }
      : {}),
  };
  const connector = signingConnector();
  connector.signTransaction.mockImplementation(async (tx: Transaction) => {
    log.push(`sign:${tx.operations.map((o) => o.type).join(",")}`);
    tx.sign(USER_KP);
    connector.signed.push(tx);
    return { signedXdr: tx.toEnvelope().toXdr("base64"), signerPublicKey: USER };
  });
  // a landed batch changes the account table the way the network would
  const submitClassic = vi.fn(async (signedXdr: string) => {
    const tx = decode(signedXdr);
    for (const op of tx.operations) {
      if (op.type === "createAccount") {
        table.set((op as Operation.CreateAccount).destination, { seq: 1n, balances: [] });
      }
      if (op.type === "accountMerge") table.delete(USER);
    }
    log.push("classic-landed");
    return { txHash: `C${log.length}`, ledger: 10 };
  });
  (h as { control: unknown }).control = control;
  (h as { deps: unknown }).deps = {
    network: NETWORK,
    connector,
    horizon: fakeHorizon(table),
    submitClassic,
    submitSoroban: vi.fn(async () => ({ txHash: "S1", ledger: 5 })),
    rebuildSorobanNode: async (node: PlanNode) => {
      log.push("soroban-build");
      (node.metadata as { transaction?: Transaction }).transaction = blendWithdrawTx(
        new Account(USER, table.get(USER)!.seq.toString()),
      );
    },
    mediatorFlow: control,
    now: () => h.clock,
    ...opts.over,
  };
  return h;
}

async function run(t: PlanTree, d: ExecutorDeps) {
  const p = executePlanTreeOnChain({ publicKey: USER, tree: t }, d);
  p.catch(() => {});
  await vi.runAllTimersAsync();
  return p;
}

function mergeSigned(h: Harness): Transaction {
  const merge = h.deps.connector.signed.find((tx) =>
    tx.operations.some((o) => o.type === "accountMerge"),
  );
  if (!merge) throw new Error("no merge was signed");
  return merge;
}

function opDestinations(tx: Transaction, type: "createAccount" | "accountMerge"): string[] {
  return tx.operations
    .filter((o) => o.type === type)
    .map((o) => (o as { destination: string }).destination);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  auditAccount.mockResolvedValue(makeAudit());
  submitMediatorForward.mockResolvedValue({ ok: true, txHash: "FWD" });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the flow is minted right before the batch that funds the mediator", () => {
  it("mints after every earlier step was signed and records it before the funding batch is signed", async () => {
    const h = harness();
    const t = mediatorTree(MEDIATOR_A, [withdrawNode()]);
    await run(t, h.deps);
    expect(h.log).toEqual([
      "soroban-build",
      "sign:invokeHostFunction",
      "mint",
      `persist:${MEDIATOR_B}:MINTED-TOKEN`,
      expect.stringMatching(/^sign:createAccount,.*accountMerge$/),
      "classic-landed",
    ]);
    const merge = mergeSigned(h);
    expect(opDestinations(merge, "createAccount")).toEqual([MEDIATOR_B]);
    expect(opDestinations(merge, "accountMerge")).toEqual([MEDIATOR_B]);
    // the forward goes out of the mediator that was funded, with the fresh token
    expect(submitMediatorForward.mock.calls[0]![0]).toMatchObject({
      mediatorPublicKey: MEDIATOR_B,
      flowToken: "MINTED-TOKEN",
      destination: EXCHANGE,
    });
  });

  it("records nothing when the close stops before the funding batch", async () => {
    const h = harness();
    (h.deps.submitSoroban as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("submitSoroban: transaction S failed on-chain"),
    );
    const t = mediatorTree(MEDIATOR_A, [withdrawNode()]);
    await expect(run(t, h.deps)).rejects.toThrow(/failed on-chain/);
    expect(h.control.mint).not.toHaveBeenCalled();
    expect(h.control.persist).not.toHaveBeenCalled();
  });

  it("signs the merge with a token minted inside the safety margin even after a slow close", async () => {
    const h = harness();
    // twenty minutes pass in the soroban step, longer than the whole token ttl
    h.deps = {
      ...h.deps,
      rebuildSorobanNode: async (node: PlanNode) => {
        h.clock += 20 * MINUTE;
        (node.metadata as { transaction?: Transaction }).transaction = blendWithdrawTx(
          new Account(USER, h.table.get(USER)!.seq.toString()),
        );
      },
    };
    const t = mediatorTree(MEDIATOR_A, [withdrawNode()]);
    await run(t, h.deps);
    const persisted = h.control.persist.mock.calls[0]![0] as PersistedFlow;
    expect(persisted.issuedAt).toBe(T0 + 20 * MINUTE);
    expect(h.control.mint).toHaveBeenCalledTimes(1);
  });
});

describe("a funded mediator is never replaced", () => {
  it("keeps the tree's mediator when an earlier run funded it, without minting", async () => {
    const h = harness();
    h.table.set(MEDIATOR_A, { seq: 1n, balances: [] });
    const t = mediatorTree(MEDIATOR_A);
    journalFor(t.allNodes.get("mediator-forward")!).flowIssuedAt = T0 - MINUTE;
    await run(t, h.deps);
    expect(h.control.mint).not.toHaveBeenCalled();
    expect(h.control.persist).not.toHaveBeenCalled();
    const merge = mergeSigned(h);
    // already funded: no second create_account
    expect(opDestinations(merge, "createAccount")).toEqual([]);
    expect(opDestinations(merge, "accountMerge")).toEqual([MEDIATOR_A]);
  });

  it("adopts the funded mediator an earlier attempt recorded instead of minting a new one", async () => {
    const h = harness({
      previous: {
        mediatorPublicKey: MEDIATOR_A,
        flowToken: "OLD-TOKEN",
        ultimateDestination: EXCHANGE,
        issuedAt: T0 - 2 * MINUTE,
      },
    });
    h.table.set(MEDIATOR_A, { seq: 1n, balances: [] });
    const t = mediatorTree(MEDIATOR_B);
    await run(t, h.deps);
    expect(h.control.mint).not.toHaveBeenCalled();
    expect(opDestinations(mergeSigned(h), "accountMerge")).toEqual([MEDIATOR_A]);
    expect(submitMediatorForward.mock.calls[0]![0]).toMatchObject({
      mediatorPublicKey: MEDIATOR_A,
      flowToken: "OLD-TOKEN",
    });
  });

  it("refuses to close to another destination while an earlier flow's mediator holds funds", async () => {
    const h = harness({
      previous: {
        mediatorPublicKey: MEDIATOR_A,
        flowToken: "OLD-TOKEN",
        ultimateDestination: DEST,
        issuedAt: T0,
      },
    });
    h.table.set(MEDIATOR_A, { seq: 1n, balances: [] });
    await expect(run(mediatorTree(MEDIATOR_B), h.deps)).rejects.toMatchObject({
      kind: "not_mergeable",
    });
    expect(h.deps.connector.signTransaction).not.toHaveBeenCalled();
    expect(h.control.mint).not.toHaveBeenCalled();
  });

  it("re-runs a multi-phase close against the mediator phase 0 funded", async () => {
    // an lp share puts its withdraw (and the funding op leading it) in phase 0
    const lpAudit = makeAudit({
      subentryCount: 1,
      poolShares: [
        {
          poolId: "a".repeat(64),
          poolType: "constant_product",
          shareBalance: "10.0000000",
          totalShares: "100.0000000",
          shareLimit: "1000",
          fee: 30,
          reserves: [
            { asset: { kind: "native" }, amount: "100.0000000" },
            { asset: { kind: "credit", code: "USDC", issuer: USDC_ISSUER }, amount: "50.0000000" },
          ],
        },
      ],
    });
    auditAccount.mockResolvedValueOnce(lpAudit);
    const h = harness();
    const submit = h.deps.submitClassic as ReturnType<typeof vi.fn>;
    const landed = submit.getMockImplementation()!;
    submit.mockImplementationOnce(landed).mockImplementationOnce(async () => {
      throw new Error("submitClassic rejected: HTTP 400: op_no_issuer");
    });
    const t = mediatorTree(MEDIATOR_A);
    await expect(run(t, h.deps)).rejects.toThrow(/op_no_issuer/);
    expect(h.control.mint).toHaveBeenCalledTimes(1);
    expect(h.table.has(MEDIATOR_B)).toBe(true);

    // retry: the same tree, the mediator phase 0 funded is still there
    submit.mockImplementation(landed);
    const final = t.allNodes.get("final-classic-tx")!;
    final.status = "pending";
    delete final.error;
    await run(t, h.deps);
    expect(h.control.mint).toHaveBeenCalledTimes(1);
    expect(opDestinations(mergeSigned(h), "accountMerge")).toEqual([MEDIATOR_B]);
  });
});

describe("the forward token is checked before the merge is signed", () => {
  const previous = (issuedAt: number): PersistedFlow => ({
    mediatorPublicKey: MEDIATOR_A,
    flowToken: "OLD-TOKEN",
    ultimateDestination: EXCHANGE,
    issuedAt,
  });

  it("refuses to merge into a funded mediator whose token is about to expire", async () => {
    const h = harness({ previous: previous(T0 - 10 * MINUTE) });
    h.table.set(MEDIATOR_A, { seq: 1n, balances: [] });
    await expect(run(mediatorTree(MEDIATOR_B), h.deps)).rejects.toMatchObject({
      kind: "mediator_expired",
    });
    expect(h.deps.connector.signTransaction).not.toHaveBeenCalled();
    expect(h.control.mint).not.toHaveBeenCalled();
  });

  it("renews the token first when the deployment can, then merges", async () => {
    const h = harness({ previous: previous(T0 - 10 * MINUTE), reissue: true });
    h.table.set(MEDIATOR_A, { seq: 1n, balances: [] });
    await run(mediatorTree(MEDIATOR_B), h.deps);
    expect(h.log.slice(0, 2)).toEqual(["reissue", `persist:${MEDIATOR_A}:RENEWED-TOKEN`]);
    expect(submitMediatorForward.mock.calls[0]![0]).toMatchObject({
      mediatorPublicKey: MEDIATOR_A,
      flowToken: "RENEWED-TOKEN",
    });
  });
});

describe("the mediator probe fails closed", () => {
  function flakyHorizon(h: Harness, answers: Error[]) {
    const base = h.deps.horizon.loadAccount;
    const loadAccount = vi.fn(async (id: string) => {
      if (id === MEDIATOR_A && answers.length > 0) throw answers.shift();
      return base.call(h.deps.horizon, id);
    });
    h.deps = { ...h.deps, horizon: { ...h.deps.horizon, loadAccount } };
  }

  it("stops before signing when horizon can't say whether the mediator exists", async () => {
    const h = harness();
    h.table.set(MEDIATOR_A, { seq: 1n, balances: [] });
    flakyHorizon(h, [horizonError(503), horizonError(503), horizonError(503)]);
    await expect(run(mediatorTree(MEDIATOR_A), h.deps)).rejects.toMatchObject({
      kind: "network",
    });
    expect(h.deps.connector.signTransaction).not.toHaveBeenCalled();
    expect(h.control.mint).not.toHaveBeenCalled();
  });

  it("rides out a rate limit and then sees the funded mediator", async () => {
    const h = harness();
    h.table.set(MEDIATOR_A, { seq: 1n, balances: [] });
    flakyHorizon(h, [horizonError(429)]);
    const t = mediatorTree(MEDIATOR_A);
    journalFor(t.allNodes.get("mediator-forward")!).flowIssuedAt = T0;
    await run(t, h.deps);
    expect(h.control.mint).not.toHaveBeenCalled();
    expect(opDestinations(mergeSigned(h), "createAccount")).toEqual([]);
  });
});

describe("a merge that landed with its reply lost", () => {
  it("is recognised from the account's history and the forward still runs", async () => {
    const findAccountMerge = vi.fn(async () => ({
      txHash: "MERGED",
      ledger: 42,
      into: MEDIATOR_A,
    }));
    const h = harness({ over: { findAccountMerge } });
    h.table.delete(USER);
    h.table.set(MEDIATOR_A, { seq: 1n, balances: [] });
    auditAccount.mockRejectedValue(new AccountNotFoundError(USER));
    const t = mediatorTree(MEDIATOR_A);
    journalFor(t.allNodes.get("mediator-forward")!).flowIssuedAt = T0;
    await run(t, h.deps);
    expect(t.allNodes.get("final-classic-tx")!.executed).toEqual({ txHash: "MERGED", ledger: 42 });
    expect(h.deps.connector.signTransaction).not.toHaveBeenCalled();
    expect(t.allNodes.get("mediator-forward")!.status).toBe("confirmed");
  });

  it("does not claim a merge into some other account", async () => {
    const findAccountMerge = vi.fn(async () => ({ txHash: "ELSEWHERE", ledger: 1, into: DEST }));
    const h = harness({ over: { findAccountMerge } });
    h.table.delete(USER);
    auditAccount.mockRejectedValue(new AccountNotFoundError(USER));
    await expect(run(mediatorTree(MEDIATOR_A), h.deps)).rejects.toMatchObject({
      kind: "not_mergeable",
      message: expect.stringMatching(/not by this close/),
    });
    expect(submitMediatorForward).not.toHaveBeenCalled();
  });
});
