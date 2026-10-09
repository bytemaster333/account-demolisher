// fee and xlm amount helpers for the review and status views

import { BASE_FEE } from "@stellar/stellar-sdk";

import { FORWARD_OPERATION_COUNT, MAX_FORWARD_FEE } from "@/lib/mediator/forward-terms";
import { MAX_PER_OP_FEE, sorobanStepFeeCeiling } from "@/lib/orchestrator/executor";
import { decimalToStroops, stroopsToTrimmedDecimal } from "@/lib/stellar/amount";
import { isSorobanNode, type PlanNode } from "@/lib/plan/tree";

// the executor's surge ceiling per classic operation: it starts at Horizon's p90
// and triples on a fee reject up to this, so it is the most a classic step can
// be charged
export const EXECUTOR_MAX_PER_OP_FEE = MAX_PER_OP_FEE;

// classic steps the page builds and submits itself
function isClassicNode(node: PlanNode): boolean {
  return (
    node.kind === "FinalClassicTx" ||
    node.kind === "ClassicUnwind" ||
    node.kind === "AddBlndTrustline" ||
    node.kind === "AddExitTrustline"
  );
}

function classicOpCount(node: PlanNode): number {
  if (node.kind === "FinalClassicTx" || node.kind === "ClassicUnwind") {
    return node.metadata.batches.reduce((n, b) => n + b.operations.length, 0);
  }
  if (node.kind === "AddBlndTrustline" || node.kind === "AddExitTrustline") return 1;
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
// soroban step is priced at what the preview's build authorizes (the inclusion
// bid plus the assembled resource fee). The classic close counts every batch at
// the fee base the preview built them with, and the forward out of the mediator
// at the same per-op starting bid (lib/plan/simulator.ts). Unsimulated classic
// steps are counted at the network minimum.
export function nodeFeeStroops(node: PlanNode): number {
  const sim = node.simulated;
  if (node.kind === "MediatorForward") {
    return sim?.kind === "classic"
      ? parseStroops(sim.estimatedFee)
      : FORWARD_OPERATION_COUNT * Number.parseInt(BASE_FEE, 10);
  }
  if (isClassicNode(node)) {
    if (sim?.kind === "classic") return parseStroops(sim.estimatedFee);
    return classicOpCount(node) * Number.parseInt(BASE_FEE, 10);
  }
  if (sim?.kind !== "soroban") return 0;
  return parseStroops(sim.maxFee);
}

// the most execution may pay for a step, in stroops. a soroban step is rebuilt
// and re-simulated right before signing, so the fee it is signed for can differ
// from the preview's; what bounds it is the cap the executor checks per class of
// step, which also covers a step only built at execute time
export function nodeMaxFeeStroops(node: PlanNode): number {
  if (isClassicNode(node)) return classicOpCount(node) * EXECUTOR_MAX_PER_OP_FEE;
  if (node.kind === "MediatorForward") return MAX_FORWARD_FEE;
  return Number(sorobanStepFeeCeiling(node));
}

// a soroban step with no built transaction yet (deferred to execute time): its
// usual fee is unknown until it is built, and only its ceiling counts
export function feeIsUnbuilt(node: PlanNode): boolean {
  return isSorobanNode(node) && !isClassicNode(node) && node.simulated?.kind !== "soroban";
}

// stroops → a trimmed XLM string (1 XLM = 10,000,000 stroops)
export function stroopsToXlm(stroops: number | bigint): string {
  return stroopsToTrimmedDecimal(
    typeof stroops === "bigint" ? stroops : BigInt(Math.trunc(stroops)),
  );
}

// decimal XLM string -> integer stroops, under the shared strict amount policy:
// anything that isn't a plain amount of up to 7 decimals throws instead of being
// truncated or read as 0
export function xlmToStroops(xlm: string): bigint {
  return decimalToStroops(xlm);
}
