// preview: generate the plan, hydrate and simulate every step against today's
// state, so the user reviews what will actually be signed, and say before
// confirming what would stop the close

import { fromPromise } from "xstate";
import { Asset } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { generatePlan } from "@/lib/plan/generator";
import { NodeNotBuiltError, simulateNode, SimulationFailedError } from "@/lib/plan/simulator";
import { topologicalOrder, type PlanNode, type PlanTree } from "@/lib/plan/tree";
import {
  mediatorFundingCheck,
  planClaimableBalances,
  unroutableCredits,
  type UnroutableCredit,
} from "@/lib/plan/classic-batcher";
import { hydratePlanTransactions } from "@/lib/plan/hydration";
import { startMediatorFlow } from "@/lib/mediator/client";
import { FORFEIT_PREFIX, surgeFeeBase } from "@/lib/orchestrator/executor";
import { residueLineProblem, type DestinationLine } from "@/lib/orchestrator/residue";
import { isNotFoundError } from "@/lib/orchestrator/submit";
import { heldTokenDispositionWarnings } from "@/lib/orchestrator/warnings";
import { assessMergeability, isFrozenBalance } from "@/lib/stellar/account-audit";
import { fetchLedgerClock } from "@/lib/stellar/ledger-clock";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { getRpc } from "@/lib/soroban/rpc-client";
import { formatXlm } from "@/lib/soroban/fee-cap";
import type { AccountAudit } from "@/lib/types/account";
import { pathKey, type ClassicMemo } from "@/lib/types/plan";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
import { blndTrustlineRequirement } from "@/lib/adapters/blend/emissions-check";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { HeldToken } from "@/lib/soroban/held-tokens";

export interface PreviewInput {
  readonly audit: AccountAudit;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  // only the tokens the user opted in to drain (default none)
  readonly selectedHeldTokens: readonly HeldToken[];
  readonly convertHeldTokensToXLM?: boolean;
  readonly network: NetworkConfig;
  readonly destination: string;
  readonly useMediator: boolean;
  readonly memo?: ClassicMemo;
  // the reviewed claim list; [] claims none, undefined every collectable one
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly sendToDestinationAssetKeys?: readonly string[];
  // pathKey()s ("CODE:ISSUER", or "contract:C..." for a held token) the user
  // agreed to sell although over the price-impact cap or unpriced
  readonly acceptedPriceImpactAssetKeys?: readonly string[];
  // pools whose accrued backstop emissions the user agreed to leave unclaimed
  // because the claim can't run
  readonly forfeitBackstopEmissionPoolIds?: readonly string[];
  readonly deterministicDisposal?: boolean;
}

// a held token whose conversion was refused for its price. the close does not
// start until the user decides: accept the price (add `key` to
// acceptedPriceImpactAssetKeys), send the token as-is, or leave it out.
export interface RefusedConversion {
  readonly key: string;
  readonly contractId: string;
  readonly reason: string;
}

// a backstop emissions claim that can't run. the user either acknowledges
// leaving the BLND behind (forfeitBackstopEmissionPoolIds) or does not close.
export interface EmissionForfeit {
  readonly poolId: string;
  // BLND, 7 decimals; null when discovery did not report the amount
  readonly accruedEmissions: bigint | null;
  readonly reason: string;
}

export interface PreviewOutput {
  readonly tree: PlanTree;
  // positive credit balances with no XLM path and no return-to-issuer consent;
  // while any exist the account can't fully merge (surfaced in the UI).
  readonly unroutableCredits: readonly UnroutableCredit[];
  // held-token disposition notes that depend on the destination kind (e.g. a CEX
  // close can't receive raw SEP-41 tokens); merged into the discovery warnings.
  readonly heldTokenWarnings: readonly string[];
  // non-blocking notes for the review (a trustline the close opens, emissions
  // left behind); merged into the discovery warnings
  readonly reviewNotes?: readonly string[];
  // what keeps the close from starting, in words for the user
  readonly reviewBlockers?: readonly string[];
  readonly refusedConversions?: readonly RefusedConversion[];
  readonly emissionForfeits?: readonly EmissionForfeit[];
}

const SIMULATE_ATTEMPTS = 3;

// the residue asset keys the destination can actually receive in the amount the
// account holds: a line that exists, is authorized and has room. a missing
// destination account can hold nothing.
export async function fetchDestinationUsableKeys(
  destination: string,
  network: NetworkConfig,
  residues: readonly { readonly key: string; readonly amount: string }[],
): Promise<ReadonlySet<string>> {
  let lines: readonly DestinationLine[];
  try {
    const account = await getHorizon(network).loadAccount(destination);
    lines = account.balances as readonly DestinationLine[];
  } catch (err) {
    if (isNotFoundError(err)) return new Set();
    throw err;
  }
  const usable = new Set<string>();
  for (const r of residues) {
    if (residueLineProblem(destination, lines, r.key, r.amount) === null) usable.add(r.key);
  }
  return usable;
}

async function simulateWithRetry(
  node: PlanNode,
  deps: Parameters<typeof simulateNode>[1],
): ReturnType<typeof simulateNode> {
  let lastErr: unknown;
  for (let i = 0; i < SIMULATE_ATTEMPTS; i++) {
    try {
      return await simulateNode(node, deps);
    } catch (err) {
      // a simulation that ran and failed is an answer, and so is a step with no
      // transaction; anything else is a transport problem worth another try
      if (err instanceof SimulationFailedError || err instanceof NodeNotBuiltError) throw err;
      lastErr = err;
      if (i < SIMULATE_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** i));
      }
    }
  }
  throw lastErr;
}

// simulates every step the user reviews. a hydration failure keeps its status
// and reason; a step deferred to execute time (it runs after steps that have not
// landed yet) stays pending and is built and simulated then. any other step
// that can't be simulated is failed with the real reason: its hydration error
// when it was never built, otherwise the simulation's.
export async function simulatePreviewTree(
  tree: PlanTree,
  hydrationReason: ReadonlyMap<string, string>,
  deps: Parameters<typeof simulateNode>[1],
): Promise<void> {
  for (const node of topologicalOrder(tree)) {
    if (node.status === "failed" || node.deferred !== undefined) continue;
    try {
      node.simulated = await simulateWithRetry(node, deps);
      node.status = "simulated";
    } catch (err) {
      if (err instanceof NodeNotBuiltError && err.deferred !== undefined) continue;
      node.status = "failed";
      if (err instanceof SimulationFailedError) {
        node.error = err.upstreamError;
      } else if (err instanceof NodeNotBuiltError) {
        node.error = hydrationReason.get(node.id) ?? errorMessage(err);
      } else {
        node.error = errorMessage(err);
      }
    }
  }
}

// the step kind that claims accrued backstop emissions ahead of the queue
const BACKSTOP_CLAIM_KIND = "ClaimBackstopEmissions";

export const previewActor = fromPromise<PreviewOutput, PreviewInput>(async ({ input }) => {
  const { audit, network } = input;
  // resolve real XLM-conversion paths so credit balances convert via path
  // payment; anything without a path (and without disposal consent) is reported
  // as un-routable rather than silently paid away. in deterministic mode
  // (multisig signing request) path resolution is skipped, so every non-XLM
  // balance must go to its issuer or the destination: no market sell that could
  // fail and sink the one transaction everyone signs.
  const paths: Awaited<ReturnType<typeof resolveCreditPaths>> = input.deterministicDisposal
    ? new Map()
    : await resolveCreditPaths(audit, network);

  // a frozen balance can't be sold, sent or returned, so no option is offered
  // for it; the mergeability check below blocks the close instead
  const frozen = new Set(
    audit.balances
      .filter(isFrozenBalance)
      .flatMap((b) => (b.asset.kind === "credit" ? [pathKey(b.asset)] : [])),
  );
  const unroutableBase = unroutableCredits(
    audit,
    paths,
    input.returnToIssuerAssetKeys,
    input.sendToDestinationAssetKeys,
    {
      ...(input.selectedClaimableBalanceIds !== undefined
        ? { claimableBalanceIds: input.selectedClaimableBalanceIds }
        : {}),
      ...(input.acceptedPriceImpactAssetKeys
        ? { acceptedPriceImpactAssetKeys: input.acceptedPriceImpactAssetKeys }
        : {}),
    },
  ).filter((c) => !frozen.has(c.key));
  // offer "send to destination" only where the destination can really take the
  // whole residue. an exchange close never offers it: the payment would reach the
  // exchange's shared address without the deposit memo.
  const usableKeys =
    unroutableBase.length > 0 && !input.useMediator
      ? await fetchDestinationUsableKeys(
          input.destination,
          network,
          unroutableBase.map((c) => ({ key: c.key, amount: c.amount })),
        )
      : new Set<string>();
  const unroutable = unroutableBase.map((c) => ({
    ...c,
    destinationTrusts: usableKeys.has(c.key),
  }));

  // a CEX destination routes through a per-flow mediator account. a flow is
  // minted here only so the preview can build and check the real merge batch;
  // the executor mints the flow that is actually funded right before funding it.
  let mediator: { readonly flowToken: string; readonly mediatorPublicKey: string } | null = null;
  if (input.useMediator) {
    const flow = await startMediatorFlow(input.destination, {
      network: network.id,
      memo: input.memo ?? null,
    });
    if (!flow.ok) {
      throw new Error(`Could not start the exchange-forward flow (${flow.code}): ${flow.reason}`);
    }
    mediator = { flowToken: flow.flowToken, mediatorPublicKey: flow.mediatorPublicKey };
  }

  // demolition revokes every active allowance the user owns. The account is
  // being closed, there's no "keep this defi protocol" outcome
  const selectedAllowances = input.allowances.map((a) => `${a.contractId}|${a.spender}`);

  // the generator builds FinalClassicTx's batches with every option the user
  // chose; those batches are what the review shows
  const tree = generatePlan(audit, input.positions, input.allowances, input.destination, {
    useMediator: input.useMediator,
    selectedAllowances,
    paths,
    networkPassphrase: network.passphrase,
    // sweep only the tokens the user opted in to; the generator ignores them for
    // a mediator close (an exchange can't receive a raw token)
    ...(input.selectedHeldTokens.length > 0 ? { heldTokens: input.selectedHeldTokens } : {}),
    ...(input.convertHeldTokensToXLM ? { convertHeldTokensToXLM: true } : {}),
    ...(mediator
      ? { mediatorPublicKey: mediator.mediatorPublicKey, flowToken: mediator.flowToken }
      : {}),
    ...(input.memo ? { memo: input.memo } : {}),
    ...(input.selectedClaimableBalanceIds !== undefined
      ? { selectedClaimableBalanceIds: input.selectedClaimableBalanceIds }
      : {}),
    ...(input.returnToIssuerAssetKeys
      ? { returnToIssuerAssetKeys: input.returnToIssuerAssetKeys }
      : {}),
    ...(input.sendToDestinationAssetKeys
      ? { sendToDestinationAssetKeys: input.sendToDestinationAssetKeys }
      : {}),
    ...(input.acceptedPriceImpactAssetKeys
      ? { acceptedPriceImpactAssetKeys: input.acceptedPriceImpactAssetKeys }
      : {}),
  });

  const rpcServer = getRpc(network);
  const horizon = getHorizon(network);

  // hydrate soroban nodes so the simulator has a built transaction to inspect.
  // a step that runs after other steps and can't be built against today's state
  // is deferred to execute time; any other per-node failure marks the node
  // failed with its real reason. a failure of the whole pass (the ledger read, a
  // bad dependency) fails the preview.
  const previewLedger = await rpcServer.getLatestLedger();
  const { failures } = await hydratePlanTransactions(tree, audit.accountId, {
    rpc: rpcServer,
    horizon,
    network,
    currentLedger: previewLedger.sequence,
    fetchSourceAccount: (pk) => horizon.loadAccount(pk),
  });
  const hydrationReason = new Map(failures.map((f) => [f.nodeId, f.reason]));

  const classicFeePerOp = await surgeFeeBase(horizon);
  await simulatePreviewTree(tree, hydrationReason, {
    server: rpcServer,
    network,
    userPublicKey: audit.accountId,
    fetchSourceAccount: async (pk) => horizon.loadAccount(pk),
    classicFeePerOp,
  });

  const emissionForfeits = settleBackstopClaims(tree, input);
  const refusedConversions = priceRefusedConversions(tree);

  const heldTokenWarnings = heldTokenDispositionWarnings(tree, {
    useMediator: input.useMediator,
    selectedCount: input.selectedHeldTokens.length,
  });

  const reviewNotes: string[] = [];
  const reviewBlockers: string[] = [];

  // pool emissions are paid in BLND, which needs a trustline the issuer authorized
  const blnd = blndTrustlineRequirement(audit, input.positions.blend, network);
  if (blnd?.reason === "missing") {
    reviewNotes.push(
      "The close first opens a BLND trustline so your Blend emissions can be claimed. It holds " +
        "0.5 XLM of reserve, which comes back when the final step removes the trustline.",
    );
  } else if (blnd?.reason === "unauthorized") {
    reviewBlockers.push(
      `Your BLND trustline is not authorized by its issuer, so the Blend emissions in pool${
        blnd.poolIds.length === 1 ? "" : "s"
      } ${blnd.poolIds.join(", ")} can't be claimed and the account can't be closed until that is resolved with the issuer.`,
    );
  }

  for (const left of input.positions.backstopUnclaimedEmissions) {
    reviewNotes.push(
      `${formatXlm(left.accruedEmissions)} BLND of backstop emissions for pool ${left.poolId} stay ` +
        "unclaimed: claiming them would mint new backstop shares under a new withdrawal lock.",
    );
  }

  const finalNode = [...tree.allNodes.values()].find((n) => n.kind === "FinalClassicTx");
  if (finalNode !== undefined && finalNode.kind === "FinalClassicTx") {
    const md = finalNode.metadata;
    // the network's own checks on the merge, against what this plan really
    // claims and how many transactions the account still sources before it
    const clock = await fetchLedgerClock(network);
    const merge = assessMergeability(audit, {
      ledger: clock,
      claimedBalanceIds: planClaimableBalances(audit, md.claimableBalanceIds).claimed.map(
        (c) => c.id,
      ),
      transactionsBeforeMerge: transactionsBeforeMerge(tree),
    });
    if (!merge.mergeable) reviewBlockers.push(merge.detail);

    // the exchange forward needs its starting balance from this account at the
    // merge; the steps ahead of it can spend some of what is there now
    const funding = mediatorFundingCheck(
      audit,
      md.batches,
      classicFeePerOp,
      spentBefore(tree, network),
    );
    if (funding !== null && !funding.sufficient) {
      reviewBlockers.push(
        `This account needs at least ${formatXlm(funding.requiredStroops)} XLM free at the merge to ` +
          `fund the exchange forward; it has about ${formatXlm(
            funding.availableStroops < 0n ? 0n : funding.availableStroops,
          )} XLM. Add XLM, then rebuild the plan.`,
      );
    }
  }

  return {
    tree,
    unroutableCredits: unroutable,
    heldTokenWarnings,
    reviewNotes,
    reviewBlockers,
    refusedConversions,
    emissionForfeits,
  };
});

// a backstop emissions claim that could not be built (the claim traps in the
// comet pool today) either stays a blocker that asks the user, or, when they
// agreed to forfeit it, is skipped so the queue runs without it
function settleBackstopClaims(tree: PlanTree, input: PreviewInput): EmissionForfeit[] {
  const forfeited = new Set(input.forfeitBackstopEmissionPoolIds ?? []);
  const out: EmissionForfeit[] = [];
  for (const node of tree.allNodes.values()) {
    if ((node.kind as string) !== BACKSTOP_CLAIM_KIND || node.status !== "failed") continue;
    const poolId = (node.metadata as { readonly poolId?: unknown }).poolId;
    if (typeof poolId !== "string") continue;
    const accrued =
      input.positions.backstop.find((b) => b.poolId === poolId)?.accruedEmissions ?? null;
    const amount = accrued === null ? "the accrued" : `${formatXlm(accrued)}`;
    if (forfeited.has(poolId)) {
      node.status = "skipped";
      node.error = `${FORFEIT_PREFIX} you chose to leave ${amount} BLND of backstop emissions for pool ${poolId} unclaimed (${node.error ?? "the claim can't run"}).`;
      continue;
    }
    out.push({ poolId, accruedEmissions: accrued, reason: node.error ?? "the claim can't run" });
  }
  return out;
}

// held-token conversions hydration refused for their price (over the impact cap
// or with no reference price). hydration reports these with the price wording
// below; any other failure of a conversion falls back to sending the token
// as-is at execute time.
function priceRefusedConversions(tree: PlanTree): RefusedConversion[] {
  const out: RefusedConversion[] = [];
  for (const node of tree.allNodes.values()) {
    if (node.kind !== "ConvertSorobanToXLM" || node.status !== "failed") continue;
    if (node.metadata.asset.kind !== "contract") continue;
    const reason = node.error ?? "";
    if (!/price impact|can't price a reference trade/i.test(reason)) continue;
    const contractId = node.metadata.asset.contractId;
    out.push({ key: `contract:${contractId}`, contractId, reason });
  }
  return out;
}

// every transaction this account still sources up to and including the merge:
// each step's own, and every classic batch. the forward is the mediator's.
function transactionsBeforeMerge(tree: PlanTree): number {
  let n = 0;
  for (const node of tree.allNodes.values()) {
    if (node.kind === "MediatorForward" || node.status === "skipped") continue;
    const batches = (node.metadata as { readonly batches?: unknown }).batches;
    n += Array.isArray(batches) ? Math.max(1, batches.length) : 1;
  }
  return n;
}

// XLM the steps ahead of the classic batches can spend: each simulated step's
// maximum fee, plus any XLM debt a blend repay pays back. a step deferred to
// execute time has no simulated fee yet; the executor's check on fresh state
// before the funding batch covers it.
function spentBefore(tree: PlanTree, network: NetworkConfig): bigint {
  const nativeSac = Asset.native().contractId(network.passphrase);
  let spent = 0n;
  for (const node of tree.allNodes.values()) {
    if (node.simulated?.kind === "soroban") spent += BigInt(node.simulated.maxFee);
    if (node.kind === "RepayBlend" && node.metadata.asset === nativeSac) {
      spent += node.metadata.amount;
    }
  }
  return spent;
}
