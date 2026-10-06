// preview: generate the plan, hydrate and simulate every step against today's
// state, so the user reviews what will actually be signed

import { fromPromise } from "xstate";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { generatePlan } from "@/lib/plan/generator";
import { simulateNode, SimulationFailedError } from "@/lib/plan/simulator";
import { isSorobanNode, topologicalOrder, type PlanNode, type PlanTree } from "@/lib/plan/tree";
import {
  batchClassicDemolition,
  unroutableCredits,
  type UnroutableCredit,
} from "@/lib/plan/classic-batcher";
import { hydratePlanTransactions } from "@/lib/plan/hydration";
import { startMediatorFlow } from "@/lib/mediator/client";
import { residueLineProblem, type DestinationLine } from "@/lib/orchestrator/residue";
import { isNotFoundError } from "@/lib/orchestrator/submit";
import { heldTokenDispositionWarnings } from "@/lib/orchestrator/warnings";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicMemo } from "@/lib/types/plan";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
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
  readonly userFallbackAddress?: string;
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly sendToDestinationAssetKeys?: readonly string[];
  readonly deterministicDisposal?: boolean;
}

export interface PreviewOutput {
  readonly tree: PlanTree;
  // positive credit balances with no XLM path and no return-to-issuer consent;
  // while any exist the account can't fully merge (surfaced in the UI).
  readonly unroutableCredits: readonly UnroutableCredit[];
  // held-token disposition notes that depend on the destination kind (e.g. a CEX
  // close can't receive raw SEP-41 tokens); merged into the discovery warnings.
  readonly heldTokenWarnings: readonly string[];
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
      // a simulation that ran and failed is an answer; anything else is a
      // transport problem worth another try
      if (err instanceof SimulationFailedError) throw err;
      if (err instanceof Error && err.message.includes("has no built transaction")) throw err;
      lastErr = err;
      if (i < SIMULATE_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** i));
      }
    }
  }
  throw lastErr;
}

export const previewActor = fromPromise<PreviewOutput, PreviewInput>(async ({ input }) => {
  // resolve real XLM-conversion paths so credit balances convert via path
  // payment; anything without a path (and without disposal consent) is reported
  // as un-routable rather than silently paid away. in deterministic mode
  // (multisig signing request) path resolution is skipped, so every non-XLM
  // balance must go to its issuer or the destination: no market sell that could
  // fail and sink the one transaction everyone signs.
  const paths: Awaited<ReturnType<typeof resolveCreditPaths>> = input.deterministicDisposal
    ? new Map()
    : await resolveCreditPaths(input.audit, input.network);
  const unroutableBase = unroutableCredits(
    input.audit,
    paths,
    input.returnToIssuerAssetKeys,
    input.sendToDestinationAssetKeys,
  );
  // offer "send to destination" only where the destination can really take the
  // whole residue
  const usableKeys =
    unroutableBase.length > 0
      ? await fetchDestinationUsableKeys(
          input.destination,
          input.network,
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
    const flow = await startMediatorFlow(input.destination);
    if (!flow.ok) {
      throw new Error(`Could not start the exchange-forward flow (${flow.code}): ${flow.reason}`);
    }
    mediator = { flowToken: flow.flowToken, mediatorPublicKey: flow.mediatorPublicKey };
  }

  // build the real batches so FinalClassicTx carries the real op count
  const batches = batchClassicDemolition(
    input.audit,
    {
      destination: input.destination,
      useMediator: input.useMediator,
      ...(mediator ? { mediatorPublicKey: mediator.mediatorPublicKey } : {}),
      ...(input.selectedClaimableBalanceIds
        ? { claimableBalanceIds: input.selectedClaimableBalanceIds }
        : {}),
      ...(input.returnToIssuerAssetKeys
        ? { returnToIssuerAssetKeys: input.returnToIssuerAssetKeys }
        : {}),
      ...(input.sendToDestinationAssetKeys
        ? { sendToDestinationAssetKeys: input.sendToDestinationAssetKeys }
        : {}),
      ...(input.userFallbackAddress ? { userFallbackAddress: input.userFallbackAddress } : {}),
      ...(input.memo ? { memo: input.memo } : {}),
    },
    paths,
  );

  // demolition revokes every active allowance the user owns. The account is
  // being closed, there's no "keep this defi protocol" outcome
  const selectedAllowances = input.allowances.map((a) => `${a.contractId}|${a.spender}`);

  const tree = generatePlan(input.audit, input.positions, input.allowances, input.destination, {
    useMediator: input.useMediator,
    selectedAllowances,
    paths,
    // sweep only the tokens the user opted in to; the generator ignores them for
    // a mediator close (an exchange can't receive a raw token)
    ...(input.selectedHeldTokens.length > 0 ? { heldTokens: input.selectedHeldTokens } : {}),
    ...(input.convertHeldTokensToXLM ? { convertHeldTokensToXLM: true } : {}),
    ...(mediator
      ? { mediatorPublicKey: mediator.mediatorPublicKey, flowToken: mediator.flowToken }
      : {}),
    ...(input.memo ? { memo: input.memo } : {}),
    ...(input.userFallbackAddress ? { userFallbackAddress: input.userFallbackAddress } : {}),
    ...(input.selectedClaimableBalanceIds
      ? { selectedClaimableBalanceIds: input.selectedClaimableBalanceIds }
      : {}),
    ...(input.returnToIssuerAssetKeys
      ? { returnToIssuerAssetKeys: input.returnToIssuerAssetKeys }
      : {}),
    ...(input.sendToDestinationAssetKeys
      ? { sendToDestinationAssetKeys: input.sendToDestinationAssetKeys }
      : {}),
  });

  // splice batches onto FinalClassicTx; metadata is readonly at the type
  // level but documented as a hydration point
  for (const node of tree.allNodes.values()) {
    if (node.kind === "FinalClassicTx") {
      const md = node.metadata as { batches: readonly (typeof batches)[number][] };
      md.batches = batches;
    }
  }

  const rpcServer = getRpc(input.network);
  const horizon = getHorizon(input.network);

  // hydrate soroban nodes so the simulator has a built transaction to inspect.
  // a per-node failure marks that node failed with its real reason; a failure of
  // the whole pass (the ledger read, a bad dependency) fails the preview.
  const previewLedger = await rpcServer.getLatestLedger();
  await hydratePlanTransactions(tree, input.audit.accountId, {
    rpc: rpcServer,
    horizon,
    network: input.network,
    currentLedger: previewLedger.sequence,
    fetchSourceAccount: (pk) => horizon.loadAccount(pk),
  });

  for (const node of topologicalOrder(tree)) {
    // keep a hydration failure and its reason as they are
    if (node.status === "failed") continue;
    try {
      const outcome = await simulateWithRetry(node, {
        server: rpcServer,
        network: input.network,
        userPublicKey: input.audit.accountId,
        fetchSourceAccount: async (pk) => horizon.loadAccount(pk),
      });
      node.simulated = outcome;
      node.status = "simulated";
    } catch (err) {
      node.status = "failed";
      if (err instanceof SimulationFailedError) {
        node.error = err.upstreamError;
      } else if (isSorobanNode(node) && errorMessage(err).includes("has no built transaction")) {
        node.error = `Could not build the ${node.kind} transaction (RPC error or archived contract state).`;
      } else {
        node.error = errorMessage(err);
      }
    }
  }

  const heldTokenWarnings = heldTokenDispositionWarnings(tree, {
    useMediator: input.useMediator,
    selectedCount: input.selectedHeldTokens.length,
  });

  return { tree, unroutableCredits: unroutable, heldTokenWarnings };
});
