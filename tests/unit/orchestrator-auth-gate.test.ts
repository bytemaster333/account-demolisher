import { beforeEach, describe, expect, it, vi } from "vitest";
import { Account, xdr, type Transaction } from "@stellar/stellar-sdk";

import { soroswapPairFor } from "@/lib/soroban/defi-auth-guard";
import type { PlanNode, PlanTree } from "@/lib/plan/tree";

import {
  DEST,
  HOSTILE_TOKEN,
  NETWORK,
  USER,
  XLM_SAC,
  USDC_SAC,
  addr,
  allowlisted,
  drainInvocation,
  fakeHorizon,
  i128,
  inv,
  invokeTx,
  makeAudit,
  signingConnector,
  sourceAuth,
  sym,
  u128,
  u32,
  u64,
} from "./orchestrator-fixtures";

// every allow-listed defi node signs only the auth tree its protocol call
// needs. here each node's rebuilt transaction is a well-formed call to the real
// allow-listed contract whose recorded auth also carries a nested
// XLM-SAC.transfer(user, attacker): the drain a hostile token or rpc would add.
// nothing about the allow-list, the guard or the executor is mocked.
const auditAccount = vi.fn();
vi.mock("@/lib/stellar/account-audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stellar/account-audit")>(
    "@/lib/stellar/account-audit",
  );
  return { ...actual, auditAccount: (...args: unknown[]) => auditAccount(...args) };
});
vi.mock("@/lib/stellar/path-finder", () => ({ resolveCreditPaths: async () => new Map() }));

import { executePlanTreeOnChain } from "@/lib/orchestrator/executor";

const ROUTER = allowlisted("soroswap", "SoroswapRouter");
const AQUA_ROUTER = allowlisted("aquarius", "AquariusAmmRouter");
const BLEND_POOL = allowlisted("blend", "BlendPool::");
// the mainnet v2 blend backstop, pinned in blend/constants
const BACKSTOP_V2 = "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7";
const POOL_INDEX = "b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0";
const AQUA_POOL = "CA6PUJLBYKZKUEKLZJMKBZLEKP2OTHANDEOWSFF44FTSYLKQPIICCJBE";
const AQUA_SHARE = "CAVKLYY4RWFQBRA2YI5GTGGXKUKJQI3JLAHDGXMS7L5RDH6X6A47NMOZ";

interface Case {
  readonly name: string;
  readonly node: PlanNode;
  // builds the call; `extra` is appended to the legitimate nested calls
  readonly build: (account: Account, extra: xdr.SorobanAuthorizedInvocation[]) => Transaction;
}

function nodeOf(kind: string, metadata: Record<string, unknown>): PlanNode {
  return {
    id: kind,
    kind,
    dependencies: [],
    description: kind,
    status: "simulated",
    metadata: { kind, ...metadata },
  } as unknown as PlanNode;
}

function blendRequest(asset: string, amount: bigint, type: number) {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("address"), val: addr(asset) }),
      new xdr.ScMapEntry({ key: sym("amount"), val: i128(amount) }),
      new xdr.ScMapEntry({ key: sym("request_type"), val: u32(type) }),
    ]),
  ]);
}

const deadline = u64(1_791_000_000n);

const CASES: Case[] = [
  {
    name: "ConvertSorobanToXLM (held-token swap)",
    node: nodeOf("ConvertSorobanToXLM", {
      asset: { kind: "contract", contractId: HOSTILE_TOKEN },
      amount: 500n,
    }),
    build: (a, extra) => {
      const args = [
        i128(500n),
        i128(1n),
        xdr.ScVal.scvVec([addr(HOSTILE_TOKEN), addr(XLM_SAC)]),
        addr(USER),
        deadline,
      ];
      const pair = soroswapPairFor(NETWORK, HOSTILE_TOKEN, XLM_SAC);
      // the drain sits under the hostile token's own transfer, as recording
      // mode would put it
      const transfer = inv(HOSTILE_TOKEN, "transfer", [addr(USER), addr(pair), i128(500n)], extra);
      return invokeTx(a, ROUTER, "swap_exact_tokens_for_tokens", args, [
        sourceAuth(inv(ROUTER, "swap_exact_tokens_for_tokens", args, [transfer])),
      ]);
    },
  },
  {
    name: "WithdrawSoroswapLp",
    node: nodeOf("WithdrawSoroswapLp", {
      tokenA: XLM_SAC,
      tokenB: HOSTILE_TOKEN,
      shareBalance: 1000n,
    }),
    build: (a, extra) => {
      const args = [
        addr(XLM_SAC),
        addr(HOSTILE_TOKEN),
        i128(1000n),
        i128(0n),
        i128(0n),
        addr(USER),
        deadline,
      ];
      const pair = soroswapPairFor(NETWORK, XLM_SAC, HOSTILE_TOKEN);
      return invokeTx(a, ROUTER, "remove_liquidity", args, [
        sourceAuth(
          inv(ROUTER, "remove_liquidity", args, [
            inv(pair, "transfer", [addr(USER), addr(pair), i128(1000n)]),
            ...extra,
          ]),
        ),
      ]);
    },
  },
  {
    name: "WithdrawAquarius",
    node: nodeOf("WithdrawAquarius", {
      poolIndex: POOL_INDEX,
      shareAmount: 1000n,
      tokens: [XLM_SAC, USDC_SAC],
    }),
    build: (a, extra) => {
      const mins = xdr.ScVal.scvVec([u128(0n), u128(0n)]);
      const args = [
        addr(USER),
        xdr.ScVal.scvVec([addr(XLM_SAC), addr(USDC_SAC)]),
        xdr.ScVal.scvBytes(Buffer.from(POOL_INDEX, "hex")),
        u128(1000n),
        mins,
      ];
      return invokeTx(a, AQUA_ROUTER, "withdraw", args, [
        sourceAuth(
          inv(AQUA_ROUTER, "withdraw", args, [
            inv(
              AQUA_POOL,
              "withdraw",
              [addr(USER), u128(1000n), mins],
              [inv(AQUA_SHARE, "burn", [addr(USER), i128(1000n)]), ...extra],
            ),
          ]),
        ),
      ]);
    },
  },
  {
    name: "RepayBlend",
    node: nodeOf("RepayBlend", { poolId: BLEND_POOL, asset: XLM_SAC, amount: 1_000_000n }),
    build: (a, extra) => {
      const args = [addr(USER), addr(USER), addr(USER), blendRequest(XLM_SAC, 1_000_000n, 5)];
      return invokeTx(a, BLEND_POOL, "submit", args, [
        sourceAuth(
          inv(BLEND_POOL, "submit", args, [
            inv(XLM_SAC, "transfer", [addr(USER), addr(BLEND_POOL), i128(1_000_000n)]),
            ...extra,
          ]),
        ),
      ]);
    },
  },
  {
    name: "WithdrawBlend",
    node: nodeOf("WithdrawBlend", { poolId: BLEND_POOL, asset: USDC_SAC, bucket: "collateral" }),
    build: (a, extra) => {
      const args = [addr(USER), addr(USER), addr(USER), blendRequest(USDC_SAC, 5n, 3)];
      return invokeTx(a, BLEND_POOL, "submit", args, [
        sourceAuth(inv(BLEND_POOL, "submit", args, extra)),
      ]);
    },
  },
  {
    name: "ClaimBlendEmissions",
    node: nodeOf("ClaimBlendEmissions", { poolId: BLEND_POOL, reserveTokenIds: [3] }),
    build: (a, extra) => {
      const args = [addr(USER), xdr.ScVal.scvVec([u32(3)]), addr(USER)];
      return invokeTx(a, BLEND_POOL, "claim", args, [
        sourceAuth(inv(BLEND_POOL, "claim", args, extra)),
      ]);
    },
  },
  {
    name: "BackstopQueue",
    node: nodeOf("BackstopQueue", { poolId: BLEND_POOL, shares: 70n }),
    build: (a, extra) => {
      const args = [addr(USER), addr(BLEND_POOL), i128(70n)];
      return invokeTx(a, BACKSTOP_V2, "queue_withdrawal", args, [
        sourceAuth(inv(BACKSTOP_V2, "queue_withdrawal", args, extra)),
      ]);
    },
  },
  {
    name: "BackstopWithdraw",
    node: nodeOf("BackstopWithdraw", { poolId: BLEND_POOL, amount: 70n }),
    build: (a, extra) => {
      const args = [addr(USER), addr(BLEND_POOL), i128(70n)];
      return invokeTx(a, BACKSTOP_V2, "withdraw", args, [
        sourceAuth(inv(BACKSTOP_V2, "withdraw", args, extra)),
      ]);
    },
  },
];

function deps(build: (a: Account) => Transaction) {
  return {
    network: NETWORK,
    connector: signingConnector(),
    horizon: fakeHorizon(new Map([[USER, { seq: 10n, balances: [] }]])),
    submitClassic: vi.fn(async () => ({ txHash: "M", ledger: 1 })),
    submitSoroban: vi.fn(async () => ({ txHash: "S", ledger: 1 })),
    // the exits' payouts are swept before the merge; nothing is left here
    readTokenBalance: async () => 0n,
    rebuildSorobanNode: async (node: PlanNode) => {
      (node.metadata as { transaction?: Transaction }).transaction = build(new Account(USER, "10"));
    },
  };
}

function withMerge(node: PlanNode): PlanTree {
  const final = {
    id: "final-classic-tx",
    kind: "FinalClassicTx",
    dependencies: [node.id],
    description: "merge",
    status: "simulated",
    metadata: {
      kind: "FinalClassicTx",
      batches: [],
      destination: DEST,
      useMediator: false,
      claimableBalanceIds: [],
    },
  } as PlanNode;
  return {
    rootNodes: [node],
    allNodes: new Map([
      [node.id, node],
      [final.id, final],
    ]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditAccount.mockResolvedValue(makeAudit());
});

describe("allow-listed defi nodes sign only the tree their call needs", () => {
  for (const c of CASES) {
    it(`${c.name}: signs the clean tree`, async () => {
      const node = structuredClone(c.node);
      const d = deps((a) => c.build(a, []));
      await executePlanTreeOnChain({ publicKey: USER, tree: withMerge(node) }, d);
      expect(node.status).toBe("confirmed");
      expect(d.submitSoroban).toHaveBeenCalledTimes(1);
    });

    it(`${c.name}: never signs a tree carrying a nested XLM drain`, async () => {
      const node = structuredClone(c.node);
      const d = deps((a) => c.build(a, [drainInvocation()]));
      const t = withMerge(node);
      await executePlanTreeOnChain({ publicKey: USER, tree: t }, d).catch(() => undefined);
      // no wallet prompt for the poisoned step, and no merge after it: a refused
      // required exit stops the close; a refused conversion falls back to a
      // transfer that this test does not provide, which stops it too
      expect(d.connector.signTransaction).not.toHaveBeenCalled();
      expect(d.submitSoroban).not.toHaveBeenCalled();
      expect(d.submitClassic).not.toHaveBeenCalled();
      expect(t.allNodes.get("final-classic-tx")!.status).not.toBe("confirmed");
    });
  }

  it("never signs an extra root authorization entry added by an rpc", async () => {
    const c = CASES.find((x) => x.name === "WithdrawBlend")!;
    const node = structuredClone(c.node);
    const d = deps((a) => {
      const tx = c.build(a, []);
      const op = tx.operations[0] as { auth?: xdr.SorobanAuthorizationEntry[] };
      op.auth?.push(sourceAuth(drainInvocation()));
      return invokeTx(
        new Account(USER, "10"),
        BLEND_POOL,
        "submit",
        [addr(USER), addr(USER), addr(USER), blendRequest(USDC_SAC, 5n, 3)],
        op.auth ?? [],
      );
    });
    await executePlanTreeOnChain({ publicKey: USER, tree: withMerge(node) }, d).catch(
      () => undefined,
    );
    expect(d.connector.signTransaction).not.toHaveBeenCalled();
    expect(node.status).toBe("failed");
  });
});
