import { describe, it, expect, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  type rpc,
  type Horizon,
} from "@stellar/stellar-sdk";
import { FORWARD_OPERATION_COUNT, MAX_FORWARD_FEE } from "@/lib/mediator/forward-terms";

import { NodeNotBuiltError, simulateNode, SimulationFailedError } from "@/lib/plan/simulator";
import type { SimulationDeps } from "@/lib/plan/simulator";
import type { PlanNode } from "@/lib/plan/tree";
import type { ClassicBatch } from "@/lib/types/plan";
import { TESTNET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const MED = "GA7QIC5MOVEXQ4T5AGE5FH5LQZZLGN2X7EIVAJEHRDLNC5T3DDR7RUFS";

function batch(opCount: number): ClassicBatch {
  return {
    operations: Array.from({ length: opCount }, (_, i) => ({
      kind: "manage_data_delete" as const,
      summary: `delete data k${i}`,
      metadata: { name: `k${i}` },
    })),
    destination: DEST,
  };
}

function baseDeps(over: Partial<SimulationDeps> = {}): SimulationDeps {
  return {
    server: {} as unknown as rpc.Server,
    network: TESTNET,
    userPublicKey: USER,
    fetchSourceAccount: async () => ({}) as unknown as Horizon.AccountResponse,
    ...over,
  };
}

function finalNode(batches: ClassicBatch[]): PlanNode {
  return {
    id: "final",
    kind: "FinalClassicTx",
    dependencies: [],
    status: "pending",
    description: "final",
    metadata: { kind: "FinalClassicTx", batches, destination: DEST, useMediator: false },
  } as unknown as PlanNode;
}

describe("simulator: FinalClassicTx in-memory validation", () => {
  it("BUILDS the batch envelope and reports its real xdr, op count, and fee", async () => {
    const out = await simulateNode(finalNode([batch(3)]), baseDeps());
    expect(out.kind).toBe("classic");
    if (out.kind !== "classic") throw new Error("expected classic");
    expect(out.operationCount).toBe(3);
    // the xdr is a real built envelope, not "", and it decodes back to 3 ops
    expect(out.xdr.length).toBeGreaterThan(0);
    const tx = TransactionBuilder.fromXdr(out.xdr, TESTNET.passphrase);
    expect("operations" in tx ? tx.operations.length : 0).toBe(3);
    // real total fee = feeBase(100) * 3 ops
    expect(out.estimatedFee).toBe("300");
  });

  it("throws SimulationFailedError when a batch is malformed (zero operations)", async () => {
    await expect(simulateNode(finalNode([batch(0)]), baseDeps())).rejects.toBeInstanceOf(
      SimulationFailedError,
    );
  });

  it("throws when there are no batches at all", async () => {
    await expect(simulateNode(finalNode([]), baseDeps())).rejects.toThrow(/zero batches/);
  });

  it("validates EVERY batch builds (a later malformed batch is caught)", async () => {
    await expect(simulateNode(finalNode([batch(1), batch(0)]), baseDeps())).rejects.toBeInstanceOf(
      SimulationFailedError,
    );
  });

  // L-19: a multi-batch close signs and pays for every batch, not just the first
  it("totals ops and fees over every batch of a multi-batch close", async () => {
    const out = await simulateNode(finalNode([batch(100), batch(40)]), baseDeps());
    if (out.kind !== "classic") throw new Error("expected classic");
    expect(out.operationCount).toBe(140);
    expect(out.estimatedFee).toBe("14000");
    expect(out.transactionCount).toBe(2);
  });

  it("prices the batches at the fee the caller says the executor will bid", async () => {
    const out = await simulateNode(
      finalNode([batch(100), batch(40)]),
      baseDeps({ classicFeePerOp: 250 }),
    );
    if (out.kind !== "classic") throw new Error("expected classic");
    expect(out.estimatedFee).toBe("35000");
  });

  // the network's clock, not the browser's, bounds the envelope like the executor's
  it("bounds the envelope by the ledger close time the caller passes", async () => {
    const closedAt = 1_800_000_000;
    const out = await simulateNode(finalNode([batch(2)]), baseDeps({ ledgerCloseTime: closedAt }));
    if (out.kind !== "classic") throw new Error("expected classic");
    const tx = TransactionBuilder.fromXDR(out.xdr, TESTNET.passphrase);
    if ("innerTransaction" in tx) throw new Error("expected a plain transaction");
    expect(tx.timeBounds).toEqual({ minTime: "0", maxTime: String(closedAt + 300) });
  });

  it("refuses a ledger close time that is not a positive whole second", async () => {
    await expect(
      simulateNode(finalNode([batch(1)]), baseDeps({ ledgerCloseTime: Number.NaN })),
    ).rejects.toBeInstanceOf(SimulationFailedError);
  });
});

describe("simulator: MediatorForward structural validation", () => {
  function forwardNode(md: Record<string, unknown>): PlanNode {
    return {
      id: "fwd",
      kind: "MediatorForward",
      dependencies: [],
      status: "pending",
      description: "fwd",
      metadata: { kind: "MediatorForward", ...md },
    } as unknown as PlanNode;
  }

  it("reports the fixed 2-op forward structure when metadata is complete", async () => {
    const out = await simulateNode(
      forwardNode({ mediatorPublicKey: MED, ultimateDestination: DEST, flowToken: "tok" }),
      baseDeps(),
    );
    expect(out.kind).toBe("classic");
    if (out.kind !== "classic") throw new Error("expected classic");
    expect(out.operationCount).toBe(2);
  });

  it("throws when the forward metadata is missing a required field", async () => {
    await expect(
      simulateNode(forwardNode({ mediatorPublicKey: MED, ultimateDestination: DEST }), baseDeps()),
    ).rejects.toBeInstanceOf(SimulationFailedError);
  });
});

describe("simulator: Soroban node routes to rpc simulate", () => {
  it("returns a soroban outcome from a successful simulation", async () => {
    const node = {
      id: "rev",
      kind: "RevokeAllowance",
      dependencies: [],
      status: "pending",
      description: "revoke",
      metadata: { kind: "RevokeAllowance", contractId: "C", spender: "S", transaction: {} },
    } as unknown as PlanNode;
    const simulateFn = vi.fn(async () => ({
      ok: true as const,
      retval: null,
      minResourceFee: "100",
      transactionData: {} as never,
      auth: [],
      latestLedger: 5,
    }));
    const out = await simulateNode(node, baseDeps({ simulateFn }));
    expect(out.kind).toBe("soroban");
    expect(simulateFn).toHaveBeenCalledTimes(1);
  });

  // L-19: every soroban builder bids a 100000-stroop inclusion fee on top of the
  // resource fee; the outcome carries what the built tx authorizes
  it("reports the built transaction's own fee as the maximum fee", async () => {
    const node = {
      id: "rev",
      kind: "RevokeAllowance",
      dependencies: [],
      status: "pending",
      description: "revoke",
      metadata: {
        kind: "RevokeAllowance",
        contractId: "C",
        spender: "S",
        transaction: { fee: "112345" },
      },
    } as unknown as PlanNode;
    const simulateFn = vi.fn(async () => ({
      ok: true as const,
      retval: null,
      minResourceFee: "12345",
      transactionData: {} as never,
      auth: [],
      latestLedger: 5,
    }));
    const out = await simulateNode(node, baseDeps({ simulateFn }));
    if (out.kind !== "soroban") throw new Error("expected soroban");
    expect(out.maxFee).toBe("112345");
  });

  it("says a deferred node is built later rather than broken", async () => {
    const node = {
      id: "withdraw",
      kind: "WithdrawBlend",
      dependencies: ["repay"],
      status: "pending",
      description: "withdraw",
      deferred: { after: ["repay"], reason: "Error(Contract, #1205)" },
      metadata: { kind: "WithdrawBlend", poolId: "P", asset: "A", bucket: "collateral" },
    } as unknown as PlanNode;
    const err = await simulateNode(node, baseDeps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeNotBuiltError);
    expect((err as NodeNotBuiltError).deferred).toEqual({
      after: ["repay"],
      reason: "Error(Contract, #1205)",
    });
    // the preview caller keys on this phrase today
    expect((err as Error).message).toMatch(/has no built transaction/);
  });

  it("throws SimulationFailedError on a Soroban simulation error", async () => {
    const node = {
      id: "rev",
      kind: "RevokeAllowance",
      dependencies: [],
      status: "pending",
      description: "revoke",
      metadata: { kind: "RevokeAllowance", contractId: "C", spender: "S", transaction: {} },
    } as unknown as PlanNode;
    const simulateFn = vi.fn(async () => ({
      ok: false as const,
      error: "boom",
      diagnostic: [],
      latestLedger: 5,
    }));
    await expect(simulateNode(node, baseDeps({ simulateFn }))).rejects.toBeInstanceOf(
      SimulationFailedError,
    );
  });
});

describe("simulator: the forward reports its fee ceiling, not a fixed base fee (M-01)", () => {
  it("shows the most the forward can bid while it escalates", async () => {
    const out = await simulateNode(
      {
        id: "fwd",
        kind: "MediatorForward",
        dependencies: [],
        status: "pending",
        description: "fwd",
        metadata: {
          kind: "MediatorForward",
          mediatorPublicKey: MED,
          ultimateDestination: DEST,
          flowToken: "tok",
        },
      },
      baseDeps(),
    );
    if (out.kind !== "classic") throw new Error("expected classic");
    expect(out.operationCount).toBe(FORWARD_OPERATION_COUNT);
    expect(out.estimatedFee).toBe(MAX_FORWARD_FEE.toString());
  });
});

describe("simulator: classic nodes outside the final batch", () => {
  it("builds the classic unwind's batches like the final one", async () => {
    const out = await simulateNode(
      {
        id: "classic-unwind",
        kind: "ClassicUnwind",
        dependencies: [],
        status: "pending",
        description: "unwind",
        metadata: {
          kind: "ClassicUnwind",
          batches: [batch(2)],
          offerIds: [],
          poolIds: [],
          repayAssets: [],
          destination: DEST,
        },
      },
      baseDeps(),
    );
    if (out.kind !== "classic") throw new Error("expected classic");
    expect(out.operationCount).toBe(2);
    expect(out.transactionCount).toBe(1);
  });

  it("validates the BLND change_trust in memory instead of asking soroban rpc", async () => {
    const simulateFn = vi.fn();
    // the change_trust hydration builds for this node
    const tx = new TransactionBuilder(new Account(USER, "41"), {
      fee: "100000",
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset: new Asset("BLND", "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56"),
        }),
      )
      .setTimeout(300)
      .build();
    const out = await simulateNode(
      {
        id: "blnd-trustline",
        kind: "AddBlndTrustline",
        dependencies: [],
        status: "pending",
        description: "trust BLND",
        metadata: {
          kind: "AddBlndTrustline",
          code: "BLND",
          issuer: "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56",
          transaction: tx,
        },
      },
      baseDeps({ simulateFn }),
    );
    expect(simulateFn).not.toHaveBeenCalled();
    if (out.kind !== "classic") throw new Error("expected classic");
    expect(out.operationCount).toBe(1);
    expect(out.estimatedFee).toBe(tx.fee);
  });

  it("validates a pool payout's change_trust in memory too", async () => {
    const simulateFn = vi.fn();
    const issuer = Keypair.random().publicKey();
    const asset = new Asset("YBX", issuer);
    const tx = new TransactionBuilder(new Account(USER, "41"), {
      fee: "100000",
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(300)
      .build();
    const out = await simulateNode(
      {
        id: "line",
        kind: "AddExitTrustline",
        dependencies: [],
        status: "pending",
        description: "trust YBX",
        metadata: {
          kind: "AddExitTrustline",
          code: "YBX",
          issuer,
          contractId: asset.contractId(TESTNET.passphrase),
          transaction: tx,
        },
      },
      baseDeps({ simulateFn }),
    );
    expect(simulateFn).not.toHaveBeenCalled();
    if (out.kind !== "classic") throw new Error("expected classic");
    expect(out.operationCount).toBe(1);
    expect(out.xdr).toBe(tx.toEnvelope().toXdr("base64"));
  });
});
