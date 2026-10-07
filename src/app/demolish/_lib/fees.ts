// fee and xlm amount helpers for the review and status views

import { BASE_FEE } from "@stellar/stellar-sdk";

import { MAX_PER_OP_FEE } from "@/lib/orchestrator/executor";
import { decimalToStroops } from "@/lib/stellar/amount";
import type { PlanNode } from "@/lib/plan/tree";

// the executor's surge ceiling per classic operation: it starts at Horizon's p90
// and triples on a fee reject up to this, so it is the most a classic step can
// be charged
export const EXECUTOR_MAX_PER_OP_FEE = MAX_PER_OP_FEE;

// the forward out of the mediator is two operations, usually bid near the
// network minimum (lib/mediator/forward.ts)
export const MEDIATOR_FORWARD_FEE_STROOPS = 2 * 2 * Number.parseInt(BASE_FEE, 10);

// classic steps the page builds and submits itself
function isClassicNode(node: PlanNode): boolean {
  return (
    node.kind === "FinalClassicTx" ||
    node.kind === "ClassicUnwind" ||
    node.kind === "AddBlndTrustline"
  );
}

function classicOpCount(node: PlanNode): number {
  if (node.kind === "FinalClassicTx" || node.kind === "ClassicUnwind") {
    return node.metadata.batches.reduce((n, b) => n + b.operations.length, 0);
  }
  if (node.kind === "AddBlndTrustline") return 1;
  return 0;
}

// a fee figure the page can't read must not show as free
function parseStroops(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`malformed fee "${value}" in the built plan`);
  }
  return Number(value);
}

// the usual fee for a step, in stroops (0 when nothing was built for it). A
// soroban step is charged at most what its built transaction authorizes (the
// inclusion bid plus the assembled resource fee). The classic close counts every
// batch at the fee base the preview built them with.
export function nodeFeeStroops(node: PlanNode): number {
  const sim = node.simulated;
  if (node.kind === "MediatorForward") return MEDIATOR_FORWARD_FEE_STROOPS;
  if (isClassicNode(node)) {
    if (sim?.kind === "classic") return parseStroops(sim.estimatedFee);
    return classicOpCount(node) * Number.parseInt(BASE_FEE, 10);
  }
  if (sim?.kind !== "soroban") return 0;
  return parseStroops(sim.maxFee);
}

// the most execution may pay for a step, in stroops
export function nodeMaxFeeStroops(node: PlanNode): number {
  if (isClassicNode(node)) return classicOpCount(node) * EXECUTOR_MAX_PER_OP_FEE;
  if (node.kind === "MediatorForward") {
    const sim = node.simulated;
    return sim?.kind === "classic"
      ? Math.max(parseStroops(sim.estimatedFee), MEDIATOR_FORWARD_FEE_STROOPS)
      : MEDIATOR_FORWARD_FEE_STROOPS;
  }
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

// decimal XLM string -> integer stroops, under the shared strict amount policy:
// anything that isn't a plain amount of up to 7 decimals throws instead of being
// truncated or read as 0
export function xlmToStroops(xlm: string): bigint {
  return decimalToStroops(xlm);
}
