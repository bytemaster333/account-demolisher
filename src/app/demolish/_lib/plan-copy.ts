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

export interface PlanGroup {
  readonly phase: string;
  readonly nodes: readonly PlanNode[];
}

// groups CONSECUTIVE nodes of the same phase, given nodes in execution
// (topological) order. Folding every node of a phase into its first group would
// list a later step (e.g. a Blend withdraw that waits on its repay) ahead of steps
// that actually run before it, so a phase can appear more than once here.
export function groupPlanNodes(nodes: readonly PlanNode[]): readonly PlanGroup[] {
  const groups: { phase: string; nodes: PlanNode[] }[] = [];
  for (const node of nodes) {
    const phase = phaseForNode(node);
    const last = groups[groups.length - 1];
    if (last && last.phase === phase) last.nodes.push(node);
    else groups.push({ phase, nodes: [node] });
  }
  return groups;
}

// 1-based step numbers in display order, which is the execution order
export function planStepNumbers(groups: readonly PlanGroup[]): ReadonlyMap<string, number> {
  return new Map(groups.flatMap((g) => g.nodes).map((n, i) => [n.id, i + 1]));
}

// how many steps will actually run; a skipped step (e.g. one whose transaction
// couldn't be built) is listed with its reason instead of being counted
export function runnableSteps(ordered: readonly PlanNode[]): {
  readonly runnable: number;
  readonly skipped: readonly PlanNode[];
} {
  const skipped = ordered.filter((n) => n.status === "skipped");
  return { runnable: ordered.length - skipped.length, skipped };
}

// the classic close and the mediator forward are only built offline at preview
// (no network simulation), so they must not read as a passed dry run like the
// Soroban steps that really were simulated against the network
export function simulatedBadgeLabel(node: PlanNode): "Checked offline" | "Dry run passed" {
  return node.kind === "FinalClassicTx" || node.kind === "MediatorForward"
    ? "Checked offline"
    : "Dry run passed";
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

// a plain-language "what this step does" line, shown as a tooltip on each step in
// the Review. Every step is final once it lands on chain (a repay, swap or revoke
// is not undone if a later step fails); the earlier ones just leave the account
// open, while the close itself deletes it.
export function nodeExplainer(
  node: PlanNode,
  // a shared-account plan converts nothing on the market: every other asset goes
  // to its issuer or the destination, as chosen in the Resolve step
  opts: { readonly deterministic: boolean },
): string {
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
      return "Sends this token, unchanged, to your destination so it isn't left on the deleted account.";
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
    case "FinalClassicTx": {
      const cleanup = opts.deterministic
        ? "It returns or sends on the other assets as you chose, clears the account's trustlines, offers and data"
        : "It swaps assets that have a market into XLM, returns or sends on the rest as you chose, clears the account's trustlines, offers and data";
      const delivery = node.metadata.useMediator
        ? "then moves your whole XLM balance into a short-lived helper account and deletes this account. The next step delivers it from there with your memo"
        : "then sends your whole XLM balance to the destination and deletes this account";
      return `The close. ${cleanup}, ${delivery}. This runs in one or more transactions, and the last one is the irreversible delete.`;
    }
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
      return "Leftover tokens";
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
