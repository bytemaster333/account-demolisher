// fee and xlm amount helpers for the review and status views

import { BASE_FEE } from "@stellar/stellar-sdk";

import type { PlanNode } from "@/lib/plan/tree";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";

// the executor's surge ceiling per classic operation (MAX_PER_OP_FEE in
// orchestrator/executor.ts): it starts at Horizon's p90 and triples on a fee
// reject up to this, so it is the most a classic step can be charged
export const EXECUTOR_MAX_PER_OP_FEE = 1_000_000;

// the forward out of the mediator is two operations built at 2x BASE_FEE each
// (lib/mediator/forward.ts)
export const MEDIATOR_FORWARD_FEE_STROOPS = 2 * 2 * Number.parseInt(BASE_FEE, 10);

function classicOpCount(node: PlanNode): number {
  if (node.kind !== "FinalClassicTx") return 0;
  return node.metadata.batches.reduce((n, b) => n + b.operations.length, 0);
}

// a soroban step's fee as it is signed: assembleTransaction sets the fee to the
// inclusion bid plus the simulated minResourceFee, and every soroban builder
// here bids SOROBAN_INCLUSION_FEE. That is the most the step can be charged.
function sorobanFeeStroops(node: PlanNode): number {
  const sim = node.simulated;
  if (sim?.kind !== "soroban") return 0;
  const resource = Number.parseInt(sim.minResourceFee, 10);
  if (!Number.isFinite(resource)) return 0;
  return resource + Number.parseInt(SOROBAN_INCLUSION_FEE, 10);
}

// the usual fee for a step, in stroops (0 when nothing was built for it). The
// classic close counts every batch, not just the first one the preview built.
export function nodeFeeStroops(node: PlanNode): number {
  if (node.kind === "FinalClassicTx") {
    return classicOpCount(node) * Number.parseInt(BASE_FEE, 10);
  }
  if (node.kind === "MediatorForward") return MEDIATOR_FORWARD_FEE_STROOPS;
  return sorobanFeeStroops(node);
}

// the most execution may pay for a step, in stroops
export function nodeMaxFeeStroops(node: PlanNode): number {
  if (node.kind === "FinalClassicTx") return classicOpCount(node) * EXECUTOR_MAX_PER_OP_FEE;
  return nodeFeeStroops(node);
}

// stroops → a trimmed XLM string (1 XLM = 10,000,000 stroops)
export function stroopsToXlm(stroops: number | bigint): string {
  const big = typeof stroops === "bigint" ? stroops : BigInt(Math.trunc(stroops));
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  const s = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${s}` : s;
}

// decimal XLM string -> integer stroops
export function xlmToStroops(xlm: string): bigint {
  const [whole = "0", frac = ""] = xlm.trim().split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole || "0") * 10_000_000n + BigInt(fracPadded || "0");
}
