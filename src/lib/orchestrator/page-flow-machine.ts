// xstate machine driving /demolish

import { assign, fromPromise, setup } from "xstate";
import { TransactionBuilder } from "@stellar/stellar-sdk";

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
import { hydratePlanTransactions, rebuildSorobanNodeTransaction } from "@/lib/plan/hydration";
import { startMediatorFlow } from "@/lib/mediator/client";
import { FINAL_CLASSIC_TX_NODE_ID, MEDIATOR_FORWARD_NODE_ID } from "@/lib/mediator/refresh";
import {
  clearPendingForward,
  loadPendingForward,
  savePendingForward,
} from "@/lib/mediator/pending-flow";
import {
  executePlanTreeOnChain,
  type ConfirmationReceipt,
  type LandedMerge,
  type MediatorFlowControl,
  type TxLookup,
} from "@/lib/orchestrator/executor";
import {
  classifyFailure,
  CloseFailure,
  isRetryableFailure,
  SubmitRejectedError,
  type FailureKind,
} from "@/lib/orchestrator/failures";
import { landedPhasesOf, type PhaseReceipt } from "@/lib/orchestrator/journal";
import { prepareTreeForExecution, previewBlockers } from "@/lib/orchestrator/retry";
import { residueLineProblem, type DestinationLine } from "@/lib/orchestrator/residue";
import {
  createClassicSubmitter,
  createSorobanSubmitter,
  isNotFoundError,
  txHashHex,
  txMaxTime,
} from "@/lib/orchestrator/submit";
import { auditAccount } from "@/lib/stellar/account-audit";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicMemo, DemolishProgressEvent, DemolishResult } from "@/lib/types/plan";
import { EMPTY_POSITIONS, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import { blendRepayShortfallWarnings } from "@/lib/adapters/blend/repay-check";
import { manualCloseRequiredNotice } from "@/lib/safety/manual-close";
import { enumerateAllowances, type AllowanceRecord } from "@/lib/soroban/allowances";
import { discoverHeldTokens, type HeldToken } from "@/lib/soroban/held-tokens";
import type { Connector } from "@/lib/wallet/connector";

export { classifyFailure, isRetryableFailure, type FailureKind };
export { previewBlockers, type PreviewBlocker } from "@/lib/orchestrator/retry";

export interface PageFlowInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly connector: Connector;
  readonly destination: string;
  readonly useMediator: boolean;
  readonly memo?: ClassicMemo;
  readonly userFallbackAddress?: string;
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly sendToDestinationAssetKeys?: readonly string[];
  // standalone SEP-41 tokens the user opted in to sweep to the destination
  // (discovered tokens they ticked, plus any they added manually); none by default.
  readonly selectedHeldTokens?: readonly HeldToken[];
  // when true, opted-in held tokens are converted to XLM through the soroswap
  // router rather than transferred as-is. a token that can't be converted is
  // sent as-is instead.
  readonly convertHeldTokensToXLM?: boolean;
  readonly positions?: ProtocolPositions;
  readonly allowances?: readonly AllowanceRecord[];
  // when true, no market-conversion paths are resolved: every non-XLM balance is
  // treated as un-routable so the user must choose issuer or destination. used
  // for a multisig signing request, where a market sell could fail and sink the
  // one bundled transaction everyone signs.
  readonly deterministicDisposal?: boolean;
}

// the input as kept in context: the connector lives in its own slot so it can be
// dropped when a close ends and handed back explicitly on RETRY. signerKind
// records which kind of wallet the run started with, for display.
export type PageFlowRunInput = Omit<PageFlowInput, "connector"> & {
  readonly signerKind: Connector["kind"];
};
type StoredInput = PageFlowRunInput;

export interface PageFlowContext {
  readonly input: StoredInput | null;
  // the wallet that signs the next execution. cleared whenever a close ends, so a
  // retry after a disconnect or network switch can't sign with a stale one
  readonly connector: Connector | null;
  readonly audit: AccountAudit | null;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  // standalone SEP-41 tokens the account holds directly (event scan), offered
  // for opt-in; `unreadableHeldTokens` credited the account but their balance
  // couldn't be read
  readonly heldTokens: readonly HeldToken[];
  readonly unreadableHeldTokens: readonly string[];
  // true when the optional standalone-token scan couldn't complete (timeout/blip);
  // lets the UI still offer the manual add-a-token affordance in that case.
  readonly heldTokenScanFailed: boolean;
  readonly discoveryWarnings: readonly string[];
  // technical detail behind the discovery warnings, for a collapsed section
  readonly discoveryDiagnostics: readonly string[];
  readonly unroutableCredits: readonly UnroutableCredit[];
  readonly tree: PlanTree | null;
  readonly progress: readonly DemolishProgressEvent[];
  readonly result: DemolishResult | null;
  readonly error: string | null;
  // typed classification of `error`, driving recovery. null without a failure.
  readonly failureKind: FailureKind | null;
  // set when a multisig close's collected bundle is submitted (SUBMIT_BUNDLE)
  readonly signedBundleXdr: string | null;
  // best-effort steps that did not do what the plan asked
  readonly executionNotes: readonly string[];
  // classic phases that landed, including those of a close that did not finish
  readonly landedPhases: readonly PhaseReceipt[];
  // aborted by CANCEL while executing; the close stops at the next step boundary
  readonly executionAbort: AbortController | null;
}

export type PageFlowEvent =
  | { type: "START"; input: PageFlowInput }
  // typed = the last-4 characters of the reviewed destination the user re-typed;
  // the machine guard re-checks it so a bare/forged CONFIRM can't execute
  | { type: "CONFIRM"; typed: string }
  // the multisig bundle path has the same typed-destination gate as CONFIRM
  | { type: "SUBMIT_BUNDLE"; signedXdr: string; typed?: string }
  | { type: "CANCEL" }
  // the wallet currently connected; without one a retry can only rediscover
  | { type: "RETRY"; connector?: Connector | null }
  | { type: "RESET" }
  | { type: "_PROGRESS"; event: DemolishProgressEvent }
  | { type: "_NODE_TICK" };

interface DiscoverInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly positions?: ProtocolPositions;
  readonly allowances?: readonly AllowanceRecord[];
}

interface DiscoverOutput {
  readonly audit: AccountAudit;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  readonly heldTokens: readonly HeldToken[];
  readonly unreadableHeldTokens: readonly string[];
  readonly heldTokenScanFailed: boolean;
  // non-fatal discovery failures (allowance scan / position probe) surfaced so
  // the UI can warn that the plan may be incomplete instead of hiding them.
  readonly discoveryWarnings: readonly string[];
  readonly discoveryDiagnostics: readonly string[];
}

interface PreviewInput {
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

interface PreviewOutput {
  readonly tree: PlanTree;
  // positive credit balances with no XLM path and no return-to-issuer consent;
  // while any exist the account can't fully merge (surfaced in the UI).
  readonly unroutableCredits: readonly UnroutableCredit[];
  // held-token disposition notes that depend on the destination kind (e.g. a CEX
  // close can't receive raw SEP-41 tokens); merged into the discovery warnings.
  readonly heldTokenWarnings: readonly string[];
}

interface ExecuteInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly connector: Connector;
  // tree from the preview pass; execute runs against this so the ui shows
  // the same steps the user reviewed
  readonly tree: PlanTree;
  // present for a multisig close: the fully-signed bundled transaction to submit
  // as-is, instead of re-building/signing the tree node by node.
  readonly signedBundleXdr?: string;
  // aborted by CANCEL; combined with the actor's own stop signal
  readonly interrupt: AbortSignal;
  readonly onProgress: (event: DemolishProgressEvent) => void;
  // fires after every node.status mutation so the page re-renders the steps
  readonly onNodeTick: () => void;
}

interface ExecuteOutput {
  readonly result: DemolishResult;
  readonly tree: PlanTree;
  readonly failureKind?: FailureKind;
  readonly notes: readonly string[];
  readonly landedPhases: readonly PhaseReceipt[];
}

// per-discovery-step ceiling so a hanging rpc can't pin the ui on a spinner
const DISCOVERY_TIMEOUT_MS = 30_000;
// matches the rpc's typical event-retention window (about 7 days)
const ALLOWANCE_SCAN_WINDOW_LEDGERS = 120_960;
const SIMULATE_ATTEMPTS = 3;

function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// protocol key for a discovery that did not finish at all
const ALL_PROTOCOLS = "all";

// user-facing copy for a discovery error. a warning an adapter wrote for the user
// (a stranding, backstop or manual-close notice) is shown verbatim; a technical
// load failure gets a generic frame.
export function discoveryWarningFor(e: {
  readonly protocol: string;
  readonly message: string;
}): string {
  if (e.protocol === ALL_PROTOCOLS) {
    return "We couldn't finish checking for DeFi positions, so anything you have in apps like Blend, Aquarius, Soroswap or FxDAO might be missing from this plan. If you've used those, check them before closing.";
  }
  const actionable =
    /backstop|stranded|will be stranded|withdraw it|manual close|close it manually|before closing/i.test(
      e.message,
    );
  return actionable
    ? e.message
    : `We couldn't check your ${e.protocol} positions. If you've used ${e.protocol}, review it before closing.`;
}

// held-token notes shown before the user confirms, so a token that can't be
// swept is never a silent skip:
//   a CEX/mediator close can't forward raw tokens, so the selection is not swept;
//   a drain or conversion that failed in preview is tried again at execute, and
//   these notes say what happens if it fails again.
export function heldTokenDispositionWarnings(
  tree: PlanTree,
  opts: { readonly useMediator: boolean; readonly selectedCount: number },
): string[] {
  const out: string[] = [];
  if (opts.useMediator && opts.selectedCount > 0) {
    const n = opts.selectedCount;
    out.push(
      `The ${n} standalone token${n === 1 ? "" : "s"} you selected can't be forwarded to an ` +
        `exchange, so ${n === 1 ? "it won't" : "they won't"} be swept. Move ${
          n === 1 ? "it" : "them"
        } to a personal wallet before closing, or ${n === 1 ? "it" : "they"} will be left behind.`,
    );
  }
  for (const node of tree.allNodes.values()) {
    if (node.kind !== "TransferAsIs" && node.kind !== "ConvertSorobanToXLM") continue;
    if (node.status !== "failed" && node.status !== "skipped") continue;
    const asset = node.metadata.asset;
    const label =
      asset.kind === "contract"
        ? `${asset.contractId.slice(0, 4)}…${asset.contractId.slice(-4)}`
        : "a standalone token";
    const reason = node.error ?? "the simulation failed";
    if (node.kind === "TransferAsIs") {
      out.push(
        `We couldn't prepare the transfer of token ${label} (${reason}). The close tries it ` +
          "again; if it still fails, the token stays on the closed account. Remove it from the " +
          "sweep, or move it out of the account yourself first.",
      );
    } else {
      out.push(
        `We couldn't prepare the conversion of token ${label} to XLM (${reason}). The close tries ` +
          "again and, if it still can't convert it, sends the token to your destination as-is. If " +
          "that fails too, the close stops before the merge.",
      );
    }
  }
  return out;
}

const discoverActor = fromPromise<DiscoverOutput, DiscoverInput>(async ({ input }) => {
  const discoveryWarnings: string[] = [];
  const discoveryDiagnostics: string[] = [];

  // the audit is required, so a timeout rejects the actor (machine -> failed with
  // a real error) instead of hanging the UI. it runs alongside the best-effort
  // scans below and is awaited on its own so its failure still rejects.
  const auditPromise = withTimeout(
    "auditAccount",
    auditAccount(input.publicKey, input.network),
    DISCOVERY_TIMEOUT_MS,
  );

  // allowances, defi positions and held tokens are independent scans run
  // concurrently; each turns its own failure into a warning

  // allowances: best-effort sep-41 enumeration, timeout-bounded because
  // rpc.getEvents pagination can stall on a flaky endpoint
  const allowancesPromise: Promise<{
    allowances: readonly AllowanceRecord[];
    warning?: string;
    detail?: string;
  }> =
    input.allowances && input.allowances.length > 0
      ? Promise.resolve({ allowances: input.allowances })
      : (async () => {
          try {
            const rpc = getRpc(input.network);
            const latest = await withTimeout(
              "getLatestLedger",
              rpc.getLatestLedger(),
              DISCOVERY_TIMEOUT_MS,
            );
            const allowances = await withTimeout(
              "enumerateAllowances",
              enumerateAllowances(
                rpc,
                input.publicKey,
                latest.sequence,
                ALLOWANCE_SCAN_WINDOW_LEDGERS,
              ),
              DISCOVERY_TIMEOUT_MS,
            );
            return { allowances };
          } catch (e) {
            return {
              allowances: [] as readonly AllowanceRecord[],
              warning:
                "We couldn't finish checking this account's token spending permissions, so any active ones might not show up in this plan. You can review them separately on the Allowances page before closing.",
              detail: `allowance scan: ${errorMessage(e)}`,
            };
          }
        })();

  // defi positions: direct-contract probing across blend/aquarius/soroswap/fxdao.
  // a timeout keeps no partial result, so it is recorded as an unfinished
  // discovery in positions.errors, which the merge guard also refuses on
  const positionsPromise: Promise<{ positions: ProtocolPositions; detail?: string }> =
    input.positions && input.positions !== EMPTY_POSITIONS
      ? Promise.resolve({ positions: input.positions })
      : (async () => {
          try {
            const provider = new DirectContractProvider();
            const positions = await withTimeout(
              "getPositions",
              provider.getPositions(input.publicKey, input.network),
              DISCOVERY_TIMEOUT_MS,
            );
            return { positions };
          } catch (e) {
            return {
              positions: {
                ...EMPTY_POSITIONS,
                errors: [{ protocol: ALL_PROTOCOLS, message: errorMessage(e) }],
              },
              detail: `position discovery: ${errorMessage(e)}`,
            };
          }
        })();

  // standalone SEP-41 tokens held directly. no native "list my tokens" exists,
  // so this event-scans transfers crediting the account and probes balance().
  // the rpc's ~7-day retention means older receipts are missed, so a miss is a
  // soft warning, never treated as exhaustive.
  const heldPromise: Promise<{
    held: readonly HeldToken[];
    unreadable: readonly string[];
    failed: boolean;
    warning?: string;
    detail?: string;
  }> = (async () => {
    try {
      const rpc = getRpc(input.network);
      const latest = await withTimeout(
        "getLatestLedger",
        rpc.getLatestLedger(),
        DISCOVERY_TIMEOUT_MS,
      );
      const scan = await withTimeout(
        "discoverHeldTokens",
        discoverHeldTokens(rpc, input.publicKey, latest.sequence, input.network),
        DISCOVERY_TIMEOUT_MS,
      );
      return { held: scan.held, unreadable: scan.unreadable, failed: false };
    } catch (e) {
      // an optional, opt-in scan with a manual-add fallback: a blip must not read
      // like imminent fund loss
      return {
        held: [] as readonly HeldToken[],
        unreadable: [] as readonly string[],
        failed: true,
        warning:
          "We couldn't finish the optional scan for standalone (custom SEP-41) tokens. This doesn't affect any balance you can already see. If you know you hold a custom token, you can add it by its contract address to include it in the close.",
        detail: `held-token scan: ${errorMessage(e)}`,
      };
    }
  })();

  const audit = await auditPromise;
  const [allowanceResult, positionResult, heldResult] = await Promise.all([
    allowancesPromise,
    positionsPromise,
    heldPromise,
  ]);
  const positions = positionResult.positions;

  // warnings in a stable order (scan warnings, per-protocol errors, blend repay
  // shortfall) so copy doesn't reshuffle between runs
  if (allowanceResult.warning) discoveryWarnings.push(allowanceResult.warning);
  if (heldResult.warning) discoveryWarnings.push(heldResult.warning);
  for (const r of [allowanceResult, positionResult, heldResult]) {
    if (r.detail) discoveryDiagnostics.push(r.detail);
  }
  for (const e of positions.errors) {
    discoveryWarnings.push(discoveryWarningFor(e));
    if (e.protocol !== ALL_PROTOCOLS) discoveryDiagnostics.push(`${e.protocol}: ${e.message}`);
  }

  // blend repay needs the borrowed token on hand (no auto-swap); a shortfall
  // would stop the close mid-way, so say it now
  discoveryWarnings.push(...blendRepayShortfallWarnings(audit, positions.blend, input.network));

  // held tokens from unrecognized contracts are the visible trace of a position
  // in an unsupported app we can't unwind; ask the user to close those first
  const manualClose = manualCloseRequiredNotice({
    heldTokenCount: heldResult.held.length,
    unreadableTokenCount: heldResult.unreadable.length,
  });
  if (manualClose) discoveryWarnings.push(manualClose);

  return {
    audit,
    positions,
    allowances: allowanceResult.allowances,
    heldTokens: heldResult.held,
    unreadableHeldTokens: heldResult.unreadable,
    heldTokenScanFailed: heldResult.failed,
    discoveryWarnings,
    discoveryDiagnostics,
  };
});

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

const previewActor = fromPromise<PreviewOutput, PreviewInput>(async ({ input }) => {
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

// mediator flow wiring for the executor: mint through the sign route, record the
// flow in the pending-forward store before the funding batch is signed, and clear
// that record only for the flow whose forward landed
function mediatorFlowControl(
  input: ExecuteInput,
  horizon: ReturnType<typeof getHorizon>,
): MediatorFlowControl {
  return {
    async mint(destination) {
      // this build's mint endpoint takes only the destination; the memo rides on
      // the forward
      const flow = await startMediatorFlow(destination);
      if (!flow.ok) {
        const kind: FailureKind =
          flow.code === "NETWORK_ERROR" || flow.code === "RATE_LIMITED" ? "network" : "unknown";
        throw new CloseFailure(
          kind,
          `Could not start the exchange-forward flow (${flow.code}): ${flow.reason}`,
        );
      }
      return { mediatorPublicKey: flow.mediatorPublicKey, flowToken: flow.flowToken };
    },
    persist(flow) {
      savePendingForward({
        publicKey: input.publicKey,
        mediatorPublicKey: flow.mediatorPublicKey,
        flowToken: flow.flowToken,
        ultimateDestination: flow.ultimateDestination,
        ...(flow.memo ? { memo: flow.memo } : {}),
        networkId: input.network.id,
        // the issue time, so a later run can tell how long the token has left
        savedAt: flow.issuedAt,
      });
    },
    previous() {
      const p = loadPendingForward(input.publicKey);
      if (p === null || p.networkId !== input.network.id) return null;
      return {
        mediatorPublicKey: p.mediatorPublicKey,
        flowToken: p.flowToken,
        ultimateDestination: p.ultimateDestination,
        ...(p.memo ? { memo: p.memo } : {}),
        issuedAt: p.savedAt,
      };
    },
    forwarded(mediatorPublicKey) {
      if (loadPendingForward(input.publicKey)?.mediatorPublicKey === mediatorPublicKey) {
        clearPendingForward();
      }
    },
    async findForward(mediatorPublicKey) {
      const page = await horizon
        .transactions()
        .forAccount(mediatorPublicKey)
        .order("desc")
        .limit(10)
        .call();
      const forward = page.records.find(
        (r) => r.successful && r.source_account === mediatorPublicKey,
      );
      return forward?.hash ?? null;
    },
  };
}

// the merge that deleted the account, read from its operation history (horizon
// keeps it after the account is gone)
async function findLandedMerge(
  horizon: ReturnType<typeof getHorizon>,
  publicKey: string,
): Promise<LandedMerge | null> {
  const page = await horizon.operations().forAccount(publicKey).order("desc").limit(20).call();
  const merge = page.records.find(
    (r) =>
      String(r.type) === "account_merge" &&
      r.transaction_successful &&
      r.source_account === publicKey,
  );
  if (merge === undefined || !("into" in merge) || typeof merge.into !== "string") return null;
  const tx = await horizon.transactions().transaction(merge.transaction_hash).call();
  return { txHash: merge.transaction_hash, ledger: tx.ledger_attr, into: merge.into };
}

async function lookupHorizonTransaction(
  horizon: ReturnType<typeof getHorizon>,
  hash: string,
  maxTime: number | null,
): Promise<TxLookup> {
  try {
    const record = await horizon.transactions().transaction(hash).call();
    return record.successful
      ? { status: "success", ledger: record.ledger_attr }
      : { status: "failed" };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  if (maxTime === null) return { status: "pending" };
  const page = await horizon.ledgers().order("desc").limit(1).call();
  const closed = page.records[0]?.closed_at;
  const closedAt = typeof closed === "string" ? Math.floor(Date.parse(closed) / 1000) : null;
  return closedAt !== null && closedAt > maxTime ? { status: "expired" } : { status: "pending" };
}

async function lookupRpcTransaction(
  rpc: ReturnType<typeof getRpc>,
  hash: string,
  maxTime: number | null,
): Promise<TxLookup> {
  const res = await rpc.getTransaction(hash);
  if (res.status === "SUCCESS") return { status: "success", ledger: res.ledger };
  if (res.status === "FAILED") return { status: "failed" };
  const closedAt = Number(res.latestLedgerCloseTime);
  if (maxTime !== null && Number.isFinite(closedAt) && closedAt > maxTime) {
    return { status: "expired" };
  }
  return { status: "pending" };
}

// aborts when either source aborts (AbortSignal.any is missing from older
// safari releases)
function eitherSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const both = new AbortController();
  const abort = () => both.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return both.signal;
}

// steps a signed multisig bundle can't contain: any soroban node or the forward
function bundleStray(tree: PlanTree): PlanNode | undefined {
  return [...tree.allNodes.values()].find(
    (n) => n.kind !== "FinalClassicTx" && (isSorobanNode(n) || n.kind === "MediatorForward"),
  );
}

const executeActor = fromPromise<ExecuteOutput, ExecuteInput>(async ({ input, signal }) => {
  const rpc = getRpc(input.network);
  const horizon = getHorizon(input.network);
  const tree = input.tree;
  const stop = eitherSignal(signal, input.interrupt);
  const submitClassic = createClassicSubmitter(horizon, input.network.passphrase);
  const finalNode = tree.allNodes.get(FINAL_CLASSIC_TX_NODE_ID);
  const landed = (): readonly PhaseReceipt[] => (finalNode ? landedPhasesOf(finalNode) : []);

  if (input.signedBundleXdr) {
    return submitBundle(input, input.signedBundleXdr, submitClassic, horizon);
  }

  const notes: string[] = [];
  input.onProgress({ kind: "submitting", message: "Executing demolition plan…" });
  try {
    await executePlanTreeOnChain(
      {
        publicKey: input.publicKey,
        tree,
        onNodeUpdate: () => input.onNodeTick(),
        onNote: (text) => notes.push(text),
      },
      {
        network: input.network,
        connector: input.connector,
        horizon,
        submitClassic,
        submitSoroban: createSorobanSubmitter(rpc, input.network.passphrase),
        // rebuild each soroban node from fresh state right before signing
        rebuildSorobanNode: async (node, pk) => {
          const fresh = await rpc.getLatestLedger();
          await rebuildSorobanNodeTransaction(node, pk, {
            rpc,
            horizon,
            network: input.network,
            currentLedger: fresh.sequence,
            fetchSourceAccount: (p) => horizon.loadAccount(p),
          });
        },
        // re-run soroban discovery at merge time and refuse if any position remains
        reprobeSorobanPositions: (pk, net) => new DirectContractProvider().getPositions(pk, net),
        lookupClassicTransaction: (hash, maxTime) =>
          lookupHorizonTransaction(horizon, hash, maxTime),
        lookupSorobanTransaction: (hash, maxTime) => lookupRpcTransaction(rpc, hash, maxTime),
        mediatorFlow: mediatorFlowControl(input, horizon),
        findAccountMerge: (pk) => findLandedMerge(horizon, pk),
        signal: stop,
      },
    );
  } catch (err) {
    const message = errorMessage(err);
    input.onProgress({ kind: "blocked", message });
    return {
      result: { ok: false, errors: [message] },
      tree,
      failureKind: classifyFailure(err),
      notes,
      landedPhases: landed(),
    };
  }

  const mergedTxHash = finalNode?.executed?.txHash;
  // the merge did not land: a dependency was not done when the merge's turn came
  if (finalNode !== undefined && finalNode.status !== "confirmed") {
    const reason =
      finalNode.error ??
      "the account merge did not run because a step it depends on did not complete.";
    input.onProgress({ kind: "blocked", message: `Merge did not complete: ${reason}` });
    return {
      result: { ok: false, errors: [reason] },
      tree,
      failureKind: "unknown",
      notes,
      landedPhases: landed(),
    };
  }
  // an exchange close is done only once the forward out of the mediator landed;
  // until then the balance sits in the mediator and success would be false
  const forwardNode = tree.allNodes.get(MEDIATOR_FORWARD_NODE_ID);
  const forwardTxHash = forwardNode?.executed?.txHash;
  if (forwardNode !== undefined && (forwardNode.status !== "confirmed" || !forwardTxHash)) {
    const reason =
      "Your account was merged into the temporary exchange-forward account, but the forward to " +
      `the exchange has not landed${forwardNode.error ? `: ${forwardNode.error}` : "."} Retry resumes it.`;
    input.onProgress({ kind: "blocked", message: reason });
    return {
      result: { ok: false, errors: [reason], ...(mergedTxHash ? { mergedTxHash } : {}) },
      tree,
      failureKind: "forward_pending",
      notes,
      landedPhases: landed(),
    };
  }

  input.onProgress({
    kind: "complete",
    message: "Demolition complete.",
    ...(mergedTxHash ? { txHash: mergedTxHash } : {}),
  });
  return {
    result: {
      ok: true,
      errors: [],
      ...(mergedTxHash ? { mergedTxHash } : {}),
      ...(forwardTxHash ? { forwardTxHash } : {}),
    },
    tree,
    notes,
    landedPhases: landed(),
  };
});

// a multisig close arrives as one transaction signed to threshold in the
// signatures step. it is submitted as-is (rebuilding would void the signatures)
// and only the merge step is marked with its receipt.
async function submitBundle(
  input: ExecuteInput,
  signedBundleXdr: string,
  submitClassic: (xdr: string) => Promise<ConfirmationReceipt>,
  horizon: ReturnType<typeof getHorizon>,
): Promise<ExecuteOutput> {
  const tree = input.tree;
  const fail = (message: string, failureKind: FailureKind): ExecuteOutput => {
    input.onProgress({ kind: "blocked", message });
    return {
      result: { ok: false, errors: [message] },
      tree,
      failureKind,
      notes: [],
      landedPhases: [],
    };
  };
  input.onProgress({ kind: "submitting", message: "Submitting the signed close…" });

  // the bundle carries only classic operations; a plan with any soroban step or
  // the forward was not what everyone signed, whatever that step's status
  const stray = bundleStray(tree);
  if (stray) {
    return fail(
      `Refusing to submit: the plan contains a '${stray.kind}' step, which can't be part of a single signed transaction. Close this account with all signers present instead.`,
      "not_mergeable",
    );
  }
  const finalNode = tree.allNodes.get(FINAL_CLASSIC_TX_NODE_ID);
  if (finalNode === undefined) {
    return fail("Refusing to submit: the plan has no merge step.", "not_mergeable");
  }

  let receipt: ConfirmationReceipt;
  try {
    // an earlier submission of this bundle may have landed with its reply lost
    const signed = TransactionBuilder.fromXdr(signedBundleXdr, input.network.passphrase);
    const earlier = await lookupHorizonTransaction(horizon, txHashHex(signed), txMaxTime(signed));
    receipt =
      earlier.status === "success"
        ? { txHash: txHashHex(signed), ledger: earlier.ledger }
        : await submitClassic(signedBundleXdr);
  } catch (err) {
    // a refused bundle (stale sequence, expired timebounds, bad auth, a failed
    // operation) will be refused again: the signatures must be collected anew
    const kind = err instanceof SubmitRejectedError ? "bundle_stale" : classifyFailure(err);
    return fail(errorMessage(err), kind);
  }
  finalNode.status = "confirmed";
  finalNode.executed = receipt;
  input.onNodeTick();
  input.onProgress({ kind: "complete", message: "Demolition complete.", txHash: receipt.txHash });
  return {
    result: { ok: true, errors: [], mergedTxHash: receipt.txHash },
    tree,
    notes: [],
    landedPhases: [receipt],
  };
}

const initialContext: PageFlowContext = {
  input: null,
  connector: null,
  audit: null,
  positions: EMPTY_POSITIONS,
  allowances: [],
  heldTokens: [],
  unreadableHeldTokens: [],
  heldTokenScanFailed: false,
  discoveryWarnings: [],
  discoveryDiagnostics: [],
  unroutableCredits: [],
  tree: null,
  progress: [],
  result: null,
  error: null,
  failureKind: null,
  signedBundleXdr: null,
  executionNotes: [],
  landedPhases: [],
  executionAbort: null,
};

function storeInput(input: PageFlowInput): StoredInput {
  const { connector, ...rest } = input;
  return { ...rest, signerKind: connector.kind };
}

// everything that must be resolved before the close may start, in words for the
// user: a required step that failed preview, and any defi protocol discovery
// could not read. the merge guard refuses an unreadable protocol at merge time,
// so confirming anyway would only unwind the other positions first.
export function confirmBlockers(
  context: Pick<PageFlowContext, "tree" | "positions">,
): readonly string[] {
  return [
    ...previewBlockers(context.tree).map((b) => `${b.description}: ${b.error}`),
    ...context.positions.errors.map((e) => discoveryWarningFor(e)),
  ];
}

function typedMatches(context: PageFlowContext, typed: string | undefined): boolean {
  const dest = context.input?.destination;
  return (
    typeof dest === "string" &&
    dest.length >= 4 &&
    typeof typed === "string" &&
    typed === dest.slice(-4)
  );
}

// what a failed discovery or preview leaves: nothing from an earlier plan may be
// executed by a later RETRY
const clearedPlan = {
  tree: null,
  signedBundleXdr: null,
  progress: [],
  result: null,
  executionNotes: [],
  landedPhases: [],
} as const;

export const pageFlowMachine = setup({
  types: {
    context: {} as PageFlowContext,
    events: {} as PageFlowEvent,
  },
  actors: {
    discover: discoverActor,
    preview: previewActor,
    execute: executeActor,
  },
  guards: {
    // the irreversible execute transition refuses unless the event carries the
    // last 4 characters of the reviewed destination, a wallet is connected, and
    // nothing in confirmBlockers is open. a CONFIRM dispatched outside the
    // confirmation UI can't trigger the merge.
    confirmMatchesDestination: ({ context, event }) => {
      if (event.type !== "CONFIRM") return false;
      return (
        typedMatches(context, event.typed) &&
        context.connector !== null &&
        confirmBlockers(context).length === 0
      );
    },
    bundleConfirmed: ({ context, event }) => {
      if (event.type !== "SUBMIT_BUNDLE") return false;
      return (
        typedMatches(context, event.typed) &&
        context.connector !== null &&
        confirmBlockers(context).length === 0
      );
    },
    canResume: ({ context, event }) => {
      if (event.type !== "RETRY") return false;
      return (
        context.tree !== null &&
        isRetryableFailure(context.failureKind ?? "unknown") &&
        event.connector !== undefined &&
        event.connector !== null
      );
    },
  },
}).createMachine({
  id: "page-flow",
  initial: "idle",
  context: initialContext,
  states: {
    idle: {
      on: {
        START: {
          target: "discovering",
          actions: assign({
            input: ({ event }) => storeInput(event.input),
            connector: ({ event }) => event.input.connector,
            audit: null,
            discoveryWarnings: [],
            discoveryDiagnostics: [],
            unroutableCredits: [],
            error: null,
            failureKind: null,
            ...clearedPlan,
          }),
        },
      },
    },
    discovering: {
      // the account or network changed under the run; the scan's result is dropped
      on: {
        CANCEL: { target: "cancelled", actions: assign({ connector: null, ...clearedPlan }) },
      },
      invoke: {
        src: "discover",
        input: ({ context }): DiscoverInput => {
          const i = context.input;
          if (!i) throw new Error("discovering: missing input");
          return {
            publicKey: i.publicKey,
            network: i.network,
            ...(i.positions ? { positions: i.positions } : {}),
            ...(i.allowances ? { allowances: i.allowances } : {}),
          };
        },
        onDone: {
          target: "previewing",
          actions: assign({
            audit: ({ event }) => event.output.audit,
            positions: ({ event }) => event.output.positions,
            allowances: ({ event }) => event.output.allowances,
            heldTokens: ({ event }) => event.output.heldTokens,
            unreadableHeldTokens: ({ event }) => event.output.unreadableHeldTokens,
            heldTokenScanFailed: ({ event }) => event.output.heldTokenScanFailed,
            discoveryWarnings: ({ event }) => event.output.discoveryWarnings,
            discoveryDiagnostics: ({ event }) => event.output.discoveryDiagnostics,
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => errorMessage(event.error),
            failureKind: ({ event }) => classifyFailure(event.error),
            connector: null,
            ...clearedPlan,
          }),
        },
      },
    },
    previewing: {
      on: {
        CANCEL: { target: "cancelled", actions: assign({ connector: null, ...clearedPlan }) },
      },
      invoke: {
        src: "preview",
        input: ({ context }): PreviewInput => {
          const i = context.input;
          const audit = context.audit;
          if (!i || !audit) throw new Error("previewing: missing input or audit");
          return {
            audit,
            positions: context.positions,
            allowances: context.allowances,
            // only what the user explicitly opted in to drain (default none)
            selectedHeldTokens: i.selectedHeldTokens ?? [],
            ...(i.convertHeldTokensToXLM ? { convertHeldTokensToXLM: true } : {}),
            network: i.network,
            destination: i.destination,
            useMediator: i.useMediator,
            ...(i.memo ? { memo: i.memo } : {}),
            ...(i.userFallbackAddress ? { userFallbackAddress: i.userFallbackAddress } : {}),
            ...(i.selectedClaimableBalanceIds
              ? { selectedClaimableBalanceIds: i.selectedClaimableBalanceIds }
              : {}),
            ...(i.returnToIssuerAssetKeys
              ? { returnToIssuerAssetKeys: i.returnToIssuerAssetKeys }
              : {}),
            ...(i.sendToDestinationAssetKeys
              ? { sendToDestinationAssetKeys: i.sendToDestinationAssetKeys }
              : {}),
            ...(i.deterministicDisposal ? { deterministicDisposal: true } : {}),
          };
        },
        onDone: {
          target: "awaiting_confirmation",
          actions: assign({
            tree: ({ event }) => event.output.tree,
            unroutableCredits: ({ event }) => event.output.unroutableCredits,
            // held-token disposition depends on the destination kind, decided at
            // preview; fold those notes into the discovery warnings the UI shows.
            discoveryWarnings: ({ context, event }) => [
              ...context.discoveryWarnings,
              ...(event.output.heldTokenWarnings ?? []),
            ],
          }),
        },
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => errorMessage(event.error),
            failureKind: ({ event }) => classifyFailure(event.error),
            connector: null,
            ...clearedPlan,
          }),
        },
      },
    },
    awaiting_confirmation: {
      on: {
        // re-run discovery + preview with updated input (e.g. after the user
        // toggles return-to-issuer consent and hits "Rebuild plan").
        START: {
          target: "discovering",
          actions: assign({
            input: ({ event }) => storeInput(event.input),
            connector: ({ event }) => event.input.connector,
            audit: null,
            discoveryWarnings: [],
            discoveryDiagnostics: [],
            unroutableCredits: [],
            error: null,
            failureKind: null,
            ...clearedPlan,
          }),
        },
        CONFIRM: { target: "executing", guard: "confirmMatchesDestination" },
        // a multisig close: submit the collected, fully-signed bundle as-is
        SUBMIT_BUNDLE: {
          target: "executing",
          guard: "bundleConfirmed",
          actions: assign({ signedBundleXdr: ({ event }) => event.signedXdr }),
        },
        CANCEL: { target: "cancelled", actions: assign({ connector: null }) },
      },
    },
    executing: {
      entry: assign({
        executionAbort: () => new AbortController(),
        // anything that did not land re-runs; see prepareTreeForExecution
        tree: ({ context }) => (context.tree ? prepareTreeForExecution(context.tree) : null),
        progress: [],
        result: null,
        error: null,
        executionNotes: [],
      }),
      invoke: {
        src: "execute",
        input: ({ context, self }): ExecuteInput => {
          const i = context.input;
          if (!i) throw new Error("executing: missing input");
          if (!context.tree) throw new Error("executing: missing tree from preview");
          if (!context.connector) throw new Error("executing: no wallet connected");
          if (!context.executionAbort) throw new Error("executing: missing abort controller");
          return {
            publicKey: i.publicKey,
            network: i.network,
            connector: context.connector,
            tree: context.tree,
            interrupt: context.executionAbort.signal,
            ...(context.signedBundleXdr ? { signedBundleXdr: context.signedBundleXdr } : {}),
            onProgress: (event: DemolishProgressEvent) => {
              self.send({ type: "_PROGRESS", event });
            },
            onNodeTick: () => {
              self.send({ type: "_NODE_TICK" });
            },
          };
        },
        onDone: [
          {
            target: "succeeded",
            guard: ({ event }) => event.output.result.ok,
            actions: assign({
              result: ({ event }) => event.output.result,
              // executor mutated nodes in place; re-assign so subscribers re-render
              tree: ({ event }) => ({ ...event.output.tree }),
              error: null,
              failureKind: null,
              executionNotes: ({ event }) => event.output.notes,
              landedPhases: ({ event }) => event.output.landedPhases,
              connector: null,
              executionAbort: null,
            }),
          },
          {
            target: "failed",
            actions: assign({
              result: ({ event }) => event.output.result,
              error: ({ event }) => event.output.result.errors.join("; "),
              failureKind: ({ event }) =>
                event.output.failureKind ?? classifyFailure(event.output.result.errors.join("; ")),
              tree: ({ event }) => ({ ...event.output.tree }),
              executionNotes: ({ event }) => event.output.notes,
              landedPhases: ({ event }) => event.output.landedPhases,
              connector: null,
              executionAbort: null,
            }),
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => errorMessage(event.error),
            failureKind: ({ event }) => classifyFailure(event.error),
            tree: ({ context }) => (context.tree ? { ...context.tree } : null),
            connector: null,
            executionAbort: null,
          }),
        },
      },
      on: {
        _PROGRESS: {
          actions: assign({
            progress: ({ context, event }) => [...context.progress, event.event],
          }),
        },
        // executor mutates node.status in place on the shared tree
        _NODE_TICK: {
          actions: assign({
            tree: ({ context }) => (context.tree ? { ...context.tree } : null),
          }),
        },
        // stop at the next step boundary; the execute actor then finishes with an
        // "interrupted" failure that reports what already landed
        CANCEL: {
          actions: ({ context }) => context.executionAbort?.abort(),
        },
      },
    },
    succeeded: {
      on: {
        RESET: { target: "idle", actions: assign(() => initialContext) },
      },
    },
    failed: {
      on: {
        // a retryable failure re-executes the same tree with the wallet that is
        // connected now: landed steps are skipped, everything else re-runs. any
        // other failure, or a retry without a wallet, rebuilds the plan from fresh
        // discovery and drops the old tree so it can't be executed later.
        RETRY: [
          {
            target: "executing",
            guard: "canResume",
            actions: assign({
              connector: ({ event }) => event.connector ?? null,
              failureKind: null,
            }),
          },
          {
            target: "discovering",
            actions: assign({
              connector: ({ event }) => event.connector ?? null,
              error: null,
              failureKind: null,
              ...clearedPlan,
            }),
          },
        ],
        RESET: { target: "idle", actions: assign(() => initialContext) },
      },
    },
    cancelled: {
      on: {
        RESET: { target: "idle", actions: assign(() => initialContext) },
      },
    },
  },
});
