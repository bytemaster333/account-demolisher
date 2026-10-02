// plain-language labels, grouping and explainers for plan nodes

import type { PlanNode } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";

export function sumNativeBalance(audit: AccountAudit): string {
  const native = audit.balances.find((b) => b.asset.kind === "native");
  return native?.amount ?? "0";
}

export function countTrustlines(audit: AccountAudit): number {
  return audit.balances.filter((b) => b.asset.kind === "credit").length;
}

// plan-tree grouping for the left rail. groups by node "phase"
// soroban-side nodes belong to "unwind"; the final classic + mediator nodes belong to "merge"
export function groupPlanNodes(nodes: readonly PlanNode[]): ReadonlyArray<{
  phase: string;
  nodes: readonly PlanNode[];
}> {
  const groups = new Map<string, PlanNode[]>();
  for (const node of nodes) {
    const phase = phaseForNode(node);
    let arr = groups.get(phase);
    if (!arr) {
      arr = [];
      groups.set(phase, arr);
    }
    arr.push(node);
  }
  return [...groups.entries()].map(([phase, ns]) => ({ phase, nodes: ns }));
}

export function phaseForNode(node: PlanNode): string {
  switch (node.kind) {
    case "RevokeAllowance":
      return "Allowances";
    case "RepayBlend":
    case "PayFxDAODebt":
      return "DeFi debt";
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
      return "DeFi withdrawals";
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
      return "Claim rewards";
    case "ConvertSorobanToXLM":
    case "TransferAsIs":
      return "Liquidation";
    case "BackstopQueue":
      return "Queued backstop";
    case "FinalClassicTx":
      return "Merge";
    case "MediatorForward":
      return "Mediator forward";
  }
}

export function nodeLabel(node: PlanNode): string {
  switch (node.kind) {
    case "RevokeAllowance":
      return "Revoke SEP-41 allowance";
    case "RepayBlend":
      return "Repay Blend debt";
    case "PayFxDAODebt":
      return "Pay FxDAO debt";
    case "WithdrawBlend":
      return "Withdraw Blend position";
    case "WithdrawAquarius":
      return "Withdraw Aquarius LP";
    case "WithdrawSoroswapLp":
      return "Withdraw Soroswap LP";
    case "ClaimBlendEmissions":
      return "Claim Blend emissions";
    case "ClaimAquariusRewards":
      return "Claim Aquarius rewards";
    case "ConvertSorobanToXLM":
      return "Convert SEP-41 → XLM";
    case "TransferAsIs":
      return "Transfer token as-is";
    case "BackstopQueue":
      return "Queue Blend backstop";
    case "FinalClassicTx":
      return "Final merge transaction";
    case "MediatorForward":
      return "Mediator forward to destination";
  }
}

// plain, non-jargon primary label for a plan step. The protocol name from
// nodeLabel() is still shown as secondary text so power users keep the detail.
export function nodePlainLabel(node: PlanNode): string {
  switch (node.kind) {
    case "RevokeAllowance":
      return "Cancel a token spending permission";
    case "RepayBlend":
      return "Repay a loan on Blend";
    case "PayFxDAODebt":
      return "Repay your FxDAO vault";
    case "WithdrawBlend":
      return "Withdraw from Blend (a lending app)";
    case "WithdrawAquarius":
      return "Withdraw from an Aquarius pool";
    case "WithdrawSoroswapLp":
      return "Withdraw from a Soroswap pool";
    case "ClaimBlendEmissions":
      return "Collect Blend rewards";
    case "ClaimAquariusRewards":
      return "Collect Aquarius rewards";
    case "ConvertSorobanToXLM":
      return "Turn a leftover token into XLM";
    case "TransferAsIs":
      return "Move a leftover token out";
    case "BackstopQueue":
      return "Start a Blend backstop withdrawal";
    case "FinalClassicTx":
      return "Close the account and send everything";
    case "MediatorForward":
      return "Deliver your funds to the destination";
  }
}

// a plain-language "what this step does, and is it safe" line, shown as a tooltip
// on each step in the Review so the plan reads clearly to a non-expert. Every
// step before the final one is reversible on its own; only the close is not.
export function nodeExplainer(node: PlanNode): string {
  switch (node.kind) {
    case "RevokeAllowance":
      return "Cancels a permission you once gave an app to spend a token for you. The account doesn't need it to close, and leaving stray permissions around is a security risk, so we clear it.";
    case "RepayBlend":
      return "Pays back what you borrowed on Blend, using your own balance, so your deposited collateral can be released.";
    case "PayFxDAODebt":
      return "Pays off your FxDAO vault so the collateral locked inside it is returned to your account.";
    case "WithdrawBlend":
      return "Pulls your deposit back out of Blend (a lending app) and into your account, so it can be converted and sent with everything else.";
    case "WithdrawAquarius":
      return "Pulls your share of an Aquarius liquidity pool back into your account.";
    case "WithdrawSoroswapLp":
      return "Pulls your share of a Soroswap liquidity pool back into your account.";
    case "ClaimBlendEmissions":
      return "Collects the reward tokens Blend owes you before you leave, so you don't leave them behind.";
    case "ClaimAquariusRewards":
      return "Collects the reward tokens Aquarius owes you before you leave, so you don't leave them behind.";
    case "ConvertSorobanToXLM":
      return "Swaps a leftover token into XLM at the market rate, so your whole account ends up as a single XLM balance.";
    case "TransferAsIs":
      return "Moves a leftover token out of the account so its trustline can be removed.";
    case "BackstopQueue": {
      const unlockDate = node.metadata.queueEndsAt;
      const dateStr =
        unlockDate instanceof Date && !Number.isNaN(unlockDate.getTime())
          ? unlockDate.toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
            })
          : "in about 17 days";
      return (
        `Starts the required 17-day waiting period before a Blend backstop deposit can be ` +
        `withdrawn. It unlocks on or around ${dateStr}; come back on or after that date to ` +
        `withdraw it and finish closing. The account can't be closed until the backstop is ` +
        `withdrawn, so this close will stop at the merge with that reminder.`
      );
    }
    case "FinalClassicTx":
      return "The last step. It converts anything left to XLM, sends your whole balance to the destination, and permanently deletes the account, all in one transaction. This is the irreversible one.";
    case "MediatorForward":
      return "Delivers your funds to the destination through a short-lived helper account, so your exchange deposit memo is preserved along the way.";
  }
}

// plain display name for a plan phase group. The grouping key stays as
// phaseForNode() so logic (e.g. the irreversible check) is unaffected.
export function phasePlainLabel(phase: string): string {
  switch (phase) {
    case "Allowances":
      return "Token permissions";
    case "DeFi debt":
      return "Repay loans";
    case "DeFi withdrawals":
      return "Withdraw from apps";
    case "Claim rewards":
      return "Collect rewards";
    case "Liquidation":
      return "Convert leftovers to XLM";
    case "Queued backstop":
      return "Backstop withdrawal";
    case "Merge":
      return "Close the account";
    case "Mediator forward":
      return "Deliver to destination";
    default:
      return phase;
  }
}
