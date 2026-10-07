// the money figures on the Review step. Everything here is derived from what the
// plan will actually sign (the batches' destMin floors, the native claims) and
// from the most execution may pay in fees, so "at least" is a real floor. Value a
// step can't express in XLM before it runs is listed instead of being guessed.

import type { PlanNode } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";

import { nodeFeeStroops, nodeMaxFeeStroops, xlmToStroops } from "./fees";

export interface ReviewMoney {
  readonly nativeBalanceStroops: bigint;
  // sum of destMin on the path payments that convert credit assets to XLM
  readonly conversionMinStroops: bigint;
  // native claimable balances the close collects
  readonly nativeClaimStroops: bigint;
  readonly typicalFeeStroops: bigint;
  readonly maxFeeStroops: bigint;
  // native + conversion floors + native claims - max fees, never below zero
  readonly atLeastStroops: bigint;
  // a step (a loan repayment) pays out of the balance by an amount only known
  // when it runs, so the floor holds only before those payments
  readonly spendsBalance: boolean;
  // value the figure leaves out, in plain words
  readonly notCounted: readonly string[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function computeReviewMoney(args: {
  readonly audit: AccountAudit;
  // the plan's nodes in execution order
  readonly ordered: readonly PlanNode[];
}): ReviewMoney {
  const { audit, ordered } = args;
  const native = audit.balances.find((b) => b.asset.kind === "native");
  const nativeBalanceStroops = native ? xlmToStroops(native.amount) : 0n;

  let conversionMinStroops = 0n;
  let nativeClaimStroops = 0n;
  let creditClaims = 0;
  let poolWithdraws = 0;
  let sentAsIs = 0;
  let typicalFeeStroops = 0n;
  let maxFeeStroops = 0n;
  let repays = 0;
  let defiProceeds = 0;
  let tokensAsIs = 0;

  for (const node of ordered) {
    if (node.status === "skipped") continue;
    typicalFeeStroops += BigInt(nodeFeeStroops(node));
    maxFeeStroops += BigInt(nodeMaxFeeStroops(node));
    switch (node.kind) {
      case "FinalClassicTx":
        for (const op of node.metadata.batches.flatMap((b) => b.operations)) {
          const md = op.metadata;
          if (op.kind === "path_payment_strict_send") {
            const dest = md["destAsset"] as { readonly kind?: string } | undefined;
            if (dest?.kind === "native" && typeof md["destMin"] === "string") {
              conversionMinStroops += xlmToStroops(md["destMin"]);
            }
          } else if (op.kind === "claim_claimable_balance") {
            const asset = md["asset"] as { readonly kind?: string } | undefined;
            if (asset?.kind === "native" && typeof md["amount"] === "string") {
              nativeClaimStroops += xlmToStroops(md["amount"]);
            } else {
              creditClaims += 1;
            }
          } else if (op.kind === "liquidity_pool_withdraw") {
            poolWithdraws += 1;
          } else if (op.kind === "send_residue_to_destination") {
            sentAsIs += 1;
          }
        }
        break;
      case "ClassicUnwind":
        // cancelled offers hand back what they sold, and a withdrawn pool share
        // pays out the pool's assets; neither is an XLM floor
        for (const op of node.metadata.batches.flatMap((b) => b.operations)) {
          if (op.kind === "liquidity_pool_withdraw") poolWithdraws += 1;
        }
        break;
      case "RepayBlend":
        repays += 1;
        break;
      case "TransferAsIs":
        tokensAsIs += 1;
        break;
      case "WithdrawBlend":
      case "WithdrawAquarius":
      case "WithdrawAquariusConcentrated":
      case "WithdrawSoroswapLp":
      case "ClaimBlendEmissions":
      case "ClaimAquariusRewards":
      case "ClaimAquariusConcentratedFees":
      case "ConvertSorobanToXLM":
      case "BackstopWithdraw":
        defiProceeds += 1;
        break;
      // the trustline's reserve comes back when the close removes it, and the
      // backstop claim pays into backstop shares, not into this account
      case "AddBlndTrustline":
      case "ClaimBackstopEmissions":
      case "RevokeAllowance":
      case "BackstopQueue":
      case "MediatorForward":
        break;
    }
  }

  const notCounted: string[] = [];
  if (repays > 0) {
    notCounted.push(
      `${plural(repays, "loan repayment", "loan repayments")} paid from this account's balance, which lowers the amount.`,
    );
  }
  if (defiProceeds > 0) {
    notCounted.push(
      `What ${plural(defiProceeds, "DeFi step", "DeFi steps")} return (withdrawals, rewards, token swaps). It is converted when the close runs and only adds to the amount.`,
    );
  }
  if (poolWithdraws > 0) {
    notCounted.push(
      `${plural(poolWithdraws, "liquidity pool share", "liquidity pool shares")} withdrawn into the pool's assets.`,
    );
  }
  if (creditClaims > 0) {
    notCounted.push(
      `${plural(creditClaims, "pending payment", "pending payments")} in assets other than XLM, collected as those assets.`,
    );
  }
  if (sentAsIs > 0 || tokensAsIs > 0) {
    notCounted.push(
      `${plural(sentAsIs + tokensAsIs, "asset", "assets")} sent to the destination as they are, not as XLM.`,
    );
  }

  const gross = nativeBalanceStroops + conversionMinStroops + nativeClaimStroops;
  const atLeastStroops = gross > maxFeeStroops ? gross - maxFeeStroops : 0n;
  return {
    nativeBalanceStroops,
    conversionMinStroops,
    nativeClaimStroops,
    typicalFeeStroops,
    maxFeeStroops,
    atLeastStroops,
    spendsBalance: repays > 0,
    notCounted,
  };
}

// the reserve the network releases when the account closes, already part of the
// native balance: two base reserves for the account, one per subentry, one per
// entry it sponsors, minus the ones a sponsor pays for. null when the base
// reserve couldn't be read, so the UI says so instead of assuming 0.5 XLM.
export function reserveReleasedStroops(
  audit: AccountAudit,
  baseReserveStroops: number | null,
): bigint | null {
  if (baseReserveStroops === null) return null;
  const units =
    2 + audit.subentryCount + audit.sponsorship.numSponsoring - audit.sponsorship.numSponsored;
  return BigInt(Math.max(0, units)) * BigInt(baseReserveStroops);
}
