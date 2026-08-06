import { describe, it, expect, vi } from "vitest";
import { TransactionBuilder, type rpc, type Horizon } from "@stellar/stellar-sdk";

import { simulateNode, SimulationFailedError } from "@/lib/plan/simulator";
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
    // the xdr is a real built envelope, not "" — and it decodes back to 3 ops
    expect(out.xdr.length).toBeGreaterThan(0);
    const tx = TransactionBuilder.fromXDR(out.xdr, TESTNET.passphrase);
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
