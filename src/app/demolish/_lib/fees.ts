// fee and xlm amount helpers for the review and status views

import { BASE_FEE } from "@stellar/stellar-sdk";

import type { PlanNode } from "@/lib/plan/tree";

// network fee for a node, in stroops (0 when not simulated).
// exported for unit tests.
export function nodeFeeStroops(node: PlanNode): number {
  const sim = node.simulated;
  const raw =
    sim?.kind === "soroban"
      ? // the submitted fee assembles as minResourceFee + the classic inclusion
        // fee; every soroban node here is a single op built with BASE_FEE, so add
        // BASE_FEE to match assembleTransaction (and the classic branch, which
        // already tallies BASE_FEE * opCount).
        (Number.parseInt(sim.minResourceFee, 10) + Number.parseInt(BASE_FEE, 10)).toString()
      : sim?.kind === "classic"
        ? sim.estimatedFee
        : null;
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

// stroops → a trimmed XLM string (1 XLM = 10,000,000 stroops)
export function stroopsToXlm(stroops: number): string {
  const xlm = stroops / 1e7;
  if (xlm === 0) return "0";
  const s = xlm.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
}

// decimal XLM string -> integer stroops (for display-side net/fee arithmetic)
export function xlmToStroops(xlm: string): number {
  const [whole = "0", frac = ""] = xlm.trim().split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return Number(BigInt(whole || "0") * 10_000_000n + BigInt(fracPadded || "0"));
}
