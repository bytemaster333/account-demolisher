// xstate machine driving /demolish

import { assign, fromPromise, setup } from "xstate";
import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { generatePlan } from "@/lib/plan/generator";
import { simulateNode, SimulationFailedError } from "@/lib/plan/simulator";
import { topologicalOrder, type PlanNodeStatus, type PlanTree } from "@/lib/plan/tree";
import {
  batchClassicDemolition,
  unroutableCredits,
  type UnroutableCredit,
} from "@/lib/plan/classic-batcher";
import { hydratePlanTransactions } from "@/lib/plan/hydration";
import { startMediatorFlow } from "@/lib/mediator/client";
import { applyRefreshedMediatorFlow, MEDIATOR_FORWARD_NODE_ID } from "@/lib/mediator/refresh";
import {
  savePendingForward,
  clearPendingForward,
  type PendingMediatorForward,
} from "@/lib/mediator/pending-flow";
import { executePlanTreeOnChain, type ConfirmationReceipt } from "@/lib/orchestrator/executor";
import { auditAccount } from "@/lib/stellar/account-audit";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicMemo, DemolishProgressEvent, DemolishResult } from "@/lib/types/plan";
import { EMPTY_POSITIONS, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import { blendRepayShortfallWarnings } from "@/lib/adapters/blend/repay-check";
import { enumerateAllowances, type AllowanceRecord } from "@/lib/soroban/allowances";
import { discoverHeldTokens, type HeldToken } from "@/lib/soroban/held-tokens";
import type { Connector } from "@/lib/wallet/connector";

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
  // (discovered tokens they ticked, plus any they added manually). Default: none.
  readonly selectedHeldTokens?: readonly HeldToken[];
  readonly positions?: ProtocolPositions;
  readonly allowances?: readonly AllowanceRecord[];
  // when true, do NOT resolve market-conversion paths: every non-XLM balance is
  // treated as un-routable so the user must choose issuer/destination disposal.
  // Used for a multisig signing request, where a market sell could fail and sink
  // the one bundled transaction everyone signs.
  readonly deterministicDisposal?: boolean;
}

export interface PageFlowContext {
  readonly input: PageFlowInput | null;
  readonly audit: AccountAudit | null;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  // standalone SEP-41 tokens the account holds directly (discovered via event
  // scan). Surfaced for OPT-IN: the user chooses which to sweep to the
  // destination (default none) — nothing is auto-moved. `unreadableHeldTokens`
  // are contracts that credited the account but whose balance couldn't be read.
  readonly heldTokens: readonly HeldToken[];
  readonly unreadableHeldTokens: readonly string[];
  // true when the optional standalone-token scan couldn't complete (timeout/blip);
  // lets the UI still offer the manual add-a-token affordance in that case.
  readonly heldTokenScanFailed: boolean;
  readonly discoveryWarnings: readonly string[];
  readonly unroutableCredits: readonly UnroutableCredit[];
  readonly tree: PlanTree | null;
  readonly progress: readonly DemolishProgressEvent[];
  readonly result: DemolishResult | null;
  readonly error: string | null;
  // set when a multisig close's collected bundle is submitted (SUBMIT_BUNDLE)
  readonly signedBundleXdr: string | null;
}

export type PageFlowEvent =
  | { type: "START"; input: PageFlowInput }
  // typed = the last-4 characters of the reviewed destination the user re-typed;
  // the machine guard re-checks it so a bare/forged CONFIRM can't execute
  | { type: "CONFIRM"; typed: string }
  | { type: "SUBMIT_BUNDLE"; signedXdr: string }
  | { type: "CANCEL" }
  | { type: "RETRY" }
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
}

interface PreviewInput {
  readonly audit: AccountAudit;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  // only the tokens the user opted in to drain (default none); NOT every
  // discovered token — nothing is swept without an explicit choice.
  readonly selectedHeldTokens: readonly HeldToken[];
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
  readonly destination: string;
  readonly useMediator: boolean;
  readonly memo?: ClassicMemo;
  readonly userFallbackAddress?: string;
  readonly selectedClaimableBalanceIds?: readonly string[];
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  // tree from the preview pass; execute runs against this so the ui shows
  readonly tree: PlanTree;
  // present for a multisig close: the fully-signed bundled transaction to submit
  // as-is, instead of re-building/signing the tree node by node.
  readonly signedBundleXdr?: string;
  readonly onProgress: (event: DemolishProgressEvent) => void;
  // fires after every node.status mutation during execution so the page can
  readonly onNodeTick: () => void;
}

interface ExecuteOutput {
  readonly result: DemolishResult;
  readonly tree: PlanTree;
}

// per-discovery-step ceiling so a hanging testnet rpc can't pin the ui in the
const DISCOVERY_TIMEOUT_MS = 30_000;
// matches the rpc's typical event-retention window
const ALLOWANCE_SCAN_WINDOW_LEDGERS = 120_960;

function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Map a discovery error to user-facing warning copy. A user-ACTIONABLE warning
// (a stranding / backstop / manual-close notice an adapter deliberately produced)
// is surfaced VERBATIM so its specific, actionable detail reaches the user; a
// technical load failure (which reads like a developer log line) keeps a generic
// frame. Fixes SEC-11, where the specific Blend backstop stranding warning was
// discarded and replaced with a generic "we couldn't check" message.
export function discoveryWarningFor(e: {
  readonly protocol: string;
  readonly message: string;
}): string {
  const actionable =
    /backstop|stranded|will be stranded|withdraw it|manual close|close it manually|before closing/i.test(
      e.message,
    );
  return actionable
    ? e.message
    : `We couldn't check your ${e.protocol} positions. If you've used ${e.protocol}, review it before closing.`;
}

// Held-token disposition notes surfaced BEFORE the user confirms, so a token that
// can't be swept is never a silent skip at execution. Two cases:
//   • path 3 — a CEX/mediator close: the selected tokens can't be forwarded to an
//     exchange, so the generator didn't sweep them; say so, don't drop quietly;
//   • path 2 — a selected drain that failed/was-skipped in the preview simulation:
//     warn it'll be left behind on the deleted account if the user proceeds.
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
    if (node.kind !== "TransferAsIs") continue;
    if (node.status !== "failed" && node.status !== "skipped") continue;
    const asset = node.metadata.asset;
    const label =
      asset.kind === "contract"
        ? `${asset.contractId.slice(0, 4)}…${asset.contractId.slice(-4)}`
        : "a standalone token";
    out.push(
      `We couldn't move token ${label} (${node.error ?? "the transfer simulation failed"}). ` +
        `If you close now it will be left behind on the deleted account — remove it from the ` +
        `sweep, or move it out of the account manually first.`,
    );
  }
  return out;
}

const discoverActor = fromPromise<DiscoverOutput, DiscoverInput>(async ({ input }) => {
  // the audit is REQUIRED, so a timeout rejects the actor (machine -> failed with
  // a real error) instead of hanging the UI on "Auditing account…" forever.
  const audit = await withTimeout(
    "auditAccount",
    auditAccount(input.publicKey, input.network),
    DISCOVERY_TIMEOUT_MS,
  );
  const discoveryWarnings: string[] = [];

  // allowances: best-effort sep-41 enumeration. wrapped in a hard timeout
  // because rpc.getEvents pagination can stall on a flaky testnet endpoint
  let allowances: readonly AllowanceRecord[] = input.allowances ?? [];
  if (allowances.length === 0) {
    try {
      const rpc = getRpc(input.network);
      const latest = await withTimeout(
        "getLatestLedger",
        rpc.getLatestLedger(),
        DISCOVERY_TIMEOUT_MS,
      );
      allowances = await withTimeout(
        "enumerateAllowances",
        enumerateAllowances(rpc, input.publicKey, latest.sequence, ALLOWANCE_SCAN_WINDOW_LEDGERS),
        DISCOVERY_TIMEOUT_MS,
      );
    } catch (e) {
      console.warn("[demolish] allowance enumeration skipped:", e);
      discoveryWarnings.push(
        "We couldn't finish checking this account's token spending permissions, so any active ones might not show up in this plan. You can review them separately on the Allowances page before closing.",
      );
    }
  }

  // defi positions: direct-contract probing across blend/aquarius/soroswap/fxdao
  let positions: ProtocolPositions = input.positions ?? EMPTY_POSITIONS;
  if (positions === EMPTY_POSITIONS) {
    try {
      const provider = new DirectContractProvider();
      positions = await withTimeout(
        "getPositions",
        provider.getPositions(input.publicKey, input.network),
        DISCOVERY_TIMEOUT_MS,
      );
    } catch (e) {
      console.warn("[demolish] position discovery skipped:", e);
      discoveryWarnings.push(
        "We couldn't finish checking for DeFi positions, so anything you have in apps like Blend, Aquarius, Soroswap or FxDAO might be missing from this plan. If you've used those, check them before closing.",
      );
    }
  }

  // standalone SEP-41 tokens held directly (custom tokens someone transferred to
  // the account). No native "list my tokens" exists, so this event-scans the rpc
  // for transfers crediting the account and probes balance() on each. Best-effort
  // + timeout-bounded, its own failure domain: a stall here must not block the
  // close. The RPC's ~7-day retention means older receipts are missed, so a miss
  // is surfaced as a soft warning rather than treated as exhaustive.
  let heldTokens: readonly HeldToken[] = [];
  let unreadableHeldTokens: readonly string[] = [];
  let heldTokenScanFailed = false;
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
    heldTokens = scan.held;
    unreadableHeldTokens = scan.unreadable;
  } catch (e) {
    console.warn("[demolish] held-token discovery skipped:", e);
    heldTokenScanFailed = true;
    // Proportionate: this is an OPTIONAL, opt-in scan with a manual-add fallback,
    // so a timeout/blip must not read like imminent fund loss. It doesn't affect
    // any balance already shown, and the user can still add a token by contract id.
    discoveryWarnings.push(
      "We couldn't finish the optional scan for standalone (custom SEP-41) tokens. This doesn't affect any balance you can already see. If you know you hold a custom token, you can add it by its contract address to include it in the close.",
    );
  }

  // per-protocol discovery failures (e.g. Soroswap has no position index) were
  // previously invisible; surface them in plain language so the user knows the
  // plan may be partial. The raw technical message is dropped from user copy;
  // it only ever read like a developer log line.
  for (const e of positions.errors) {
    discoveryWarnings.push(discoveryWarningFor(e));
  }

  // Blend repay needs the borrowed token on hand (no auto-swap). If the account
  // is short on one, the repay step would stop the close, so surface it now
  // rather than letting it surprise the user mid-execution.
  discoveryWarnings.push(...blendRepayShortfallWarnings(audit, positions.blend, input.network));

  return {
    audit,
    positions,
    allowances,
    heldTokens,
    unreadableHeldTokens,
    heldTokenScanFailed,
    discoveryWarnings,
  };
});

// best-effort: the pathKey()s of credit assets the destination account already
// trusts. Lets the UI offer "send to destination" for un-routable residue
// without risking op_no_trust. A missing/unfunded destination trusts nothing.
async function fetchDestinationTrustedKeys(
  destination: string,
  network: NetworkConfig,
): Promise<ReadonlySet<string>> {
  try {
    const account = await getHorizon(network).loadAccount(destination);
    const keys = new Set<string>();
    for (const b of account.balances) {
      if (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") {
        keys.add(`${b.asset_code}:${b.asset_issuer}`);
      }
    }
    return keys;
  } catch {
    return new Set<string>();
  }
}

const previewActor = fromPromise<PreviewOutput, PreviewInput>(async ({ input }) => {
  // resolve real XLM-conversion paths so credit balances convert via path
  // payment; anything without a path (and without disposal consent) is reported
  // as un-routable rather than silently paid away. In deterministic mode
  // (multisig signing request) we skip path resolution entirely, so EVERY non-XLM
  // balance is un-routable and must be sent to its issuer or the destination, no
  // market sells that could fail and sink the one transaction everyone signs.
  const paths: Awaited<ReturnType<typeof resolveCreditPaths>> = input.deterministicDisposal
    ? new Map()
    : await resolveCreditPaths(input.audit, input.network);
  const unroutableBase = unroutableCredits(
    input.audit,
    paths,
    input.returnToIssuerAssetKeys,
    input.sendToDestinationAssetKeys,
  );
  // flag which still-blocking residue assets the destination trusts, so the UI
  // can offer sending them there instead of only burning them at the issuer.
  const trustedKeys =
    unroutableBase.length > 0
      ? await fetchDestinationTrustedKeys(input.destination, input.network)
      : new Set<string>();
  const unroutable = unroutableBase.map((c) => ({
    ...c,
    destinationTrusts: trustedKeys.has(c.key),
  }));

  // For a CEX (memo-required) destination the close-out routes through an
  // ephemeral, per-flow mediator account. Mint that flow now so the merge (into
  // the mediator) and the later forward (out of it) target the SAME key; the
  // returned token authorizes signing that key at forward time. Per-flow keys
  // mean a co-signed drain can only ever reach this user's own funds.
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
    // sweep ONLY the standalone SEP-41 tokens the user opted in to (default none;
    // the generator ignores these for a mediator/CEX close, since an exchange
    // can't receive a raw token — the UI surfaces that separately)
    ...(input.selectedHeldTokens.length > 0 ? { heldTokens: input.selectedHeldTokens } : {}),
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

  // hydrate soroban nodes so the simulator has a built transaction to inspect
  try {
    const previewLedger = await rpcServer.getLatestLedger();
    await hydratePlanTransactions(tree, input.audit.accountId, {
      rpc: rpcServer,
      horizon,
      network: input.network,
      currentLedger: previewLedger.sequence,
      fetchSourceAccount: (pk) => horizon.loadAccount(pk),
    });
  } catch (err) {
    // hydration failures here are non-fatal; the simulate loop below will
    console.warn("[preview] hydratePlanTransactions:", err);
  }

  for (const node of topologicalOrder(tree)) {
    try {
      const outcome = await simulateNode(node, {
        server: rpcServer,
        network: input.network,
        fetchSourceAccount: async (pk) => horizon.loadAccount(pk),
      });
      node.simulated = outcome;
      node.status = "simulated";
    } catch (err) {
      if (err instanceof SimulationFailedError) {
        node.status = "failed";
        node.error = err.upstreamError;
      } else if (err instanceof Error && err.message.includes("has no built transaction")) {
        // the node's transaction never got built during hydration. The adapters
        // ARE wired, so this is a real upstream failure (RPC error, or the
        // contract's state is archived and needs a restore/bump), so say so
        // instead of implying the integration is missing.
        node.status = "skipped";
        node.error = `Could not build the ${node.kind} transaction (RPC error or archived contract state). This step was skipped; close the position manually if it persists.`;
      } else {
        node.status = "failed";
        node.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const heldTokenWarnings = heldTokenDispositionWarnings(tree, {
    useMediator: input.useMediator,
    selectedCount: input.selectedHeldTokens.length,
  });

  return { tree, unroutableCredits: unroutable, heldTokenWarnings };
});

// Node kinds that CANNOT live inside a single signed classic bundle: each needs
// its own transaction (Soroban unwinds, allowance revokes) or is multi-step (the
// mediator forward). assessBundleability rejects all of these up front; this set
// is the executor's belt-and-suspenders check on the bundle path.
const NON_BUNDLEABLE_NODE_KINDS: ReadonlySet<string> = new Set([
  "RevokeAllowance",
  "MediatorForward",
  "RepayBlend",
  "WithdrawBlend",
  "ClaimBlendEmissions",
  "BackstopQueue",
  "WithdrawAquarius",
  "ClaimAquariusRewards",
  "WithdrawSoroswapLp",
  "PayFxDAODebt",
  "ConvertSorobanToXLM",
]);

const executeActor = fromPromise<ExecuteOutput, ExecuteInput>(async ({ input }) => {
  // execute the SAME tree the preview pass produced
  const rpc = getRpc(input.network);
  const horizon = getHorizon(input.network);
  const tree = input.tree;

  const submitClassic = async (signedXdr: string): Promise<ConfirmationReceipt> => {
    const signed = TransactionBuilder.fromXDR(signedXdr, input.network.passphrase) as Transaction;
    let res: { readonly hash?: string; readonly ledger?: number };
    try {
      res = (await horizon.submitTransaction(signed)) as {
        readonly hash?: string;
        readonly ledger?: number;
      };
    } catch (err) {
      const anyErr = err as { response?: { data?: { extras?: { result_codes?: unknown } } } };
      const codes = anyErr.response?.data?.extras?.result_codes;
      throw new Error(
        `submitClassic rejected: ${codes ? JSON.stringify(codes) : "<no result_codes>"}`,
      );
    }
    // Horizon returns a real hash on acceptance; a missing one means something is
    // wrong. Don't fabricate a sentinel and report success we can't prove. This
    // sits OUTSIDE the catch so it isn't mislabeled as a submission rejection.
    if (typeof res.hash !== "string" || res.hash.length === 0) {
      throw new Error("submitClassic: Horizon accepted the transaction but returned no hash");
    }
    return { txHash: res.hash, ledger: res.ledger ?? 0 };
  };

  // A multisig close arrives here as ONE fully-signed bundled transaction: every
  // required signature was collected in the Signatures step. Submit it as-is and
  // mark the reviewed plan confirmed, so the SAME Close step + status UI runs as
  // a single-signer close. No re-hydration and no re-signing (it's already signed
  // to threshold; rebuilding it would invalidate the collected signatures).
  if (input.signedBundleXdr) {
    input.onProgress({ kind: "submitting", message: "Submitting the signed close…" });
    // A bundled close is exactly ONE classic transaction. assessBundleability
    // rejects Soroban positions, allowance revocations, and the mediator flow up
    // front, so a bundleable tree must contain only classic nodes. Guard that
    // invariant before stamping receipts: marking a non-classic node confirmed
    // with the bundle's hash would fabricate success for an operation the signed
    // transaction never contained (e.g. an un-unwound Soroban position).
    const stray = [...tree.allNodes.values()].find(
      (n) => n.status !== "skipped" && NON_BUNDLEABLE_NODE_KINDS.has(n.kind),
    );
    if (stray) {
      const message = `Refusing to submit: the bundled close contains a '${stray.kind}' step, which can't be part of a single signed transaction. Close this account with all signers present instead.`;
      input.onProgress({ kind: "blocked", message });
      return { result: { ok: false, errors: [message] }, tree };
    }
    try {
      const receipt = await submitClassic(input.signedBundleXdr);
      for (const node of tree.allNodes.values()) {
        if (node.status !== "skipped") {
          node.status = "confirmed";
          node.executed = receipt;
        }
      }
      input.onNodeTick();
      input.onProgress({
        kind: "complete",
        message: "Demolition complete.",
        ...(receipt.txHash ? { txHash: receipt.txHash } : {}),
      });
      return { result: { ok: true, errors: [], mergedTxHash: receipt.txHash }, tree };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      input.onProgress({ kind: "blocked", message });
      return { result: { ok: false, errors: [message] }, tree };
    }
  }

  // SEC-01: re-mint the mediator flow at execute time so its 15-minute TTL starts
  // NOW — the merge into the ephemeral account and the forward out of it both run
  // in this pass, well within the window. Minting at preview instead let a slow
  // review (or a slow multi-position execution) expire the token AFTER the balance
  // had already been merged into the ephemeral account, stranding it permanently.
  const mediatorForwardNode = tree.allNodes.get(MEDIATOR_FORWARD_NODE_ID);
  if (mediatorForwardNode && mediatorForwardNode.status !== "skipped") {
    // re-mint bound to the SAME destination the forward will target (committed
    // into the token so the sign route enforces it — SEC-16)
    const forwardDestination = (
      mediatorForwardNode.metadata as { readonly ultimateDestination: string }
    ).ultimateDestination;
    const flow = await startMediatorFlow(forwardDestination);
    if (!flow.ok) {
      const message = `Could not start the exchange-forward flow (${flow.code}): ${flow.reason}`;
      input.onProgress({ kind: "blocked", message });
      return { result: { ok: false, errors: [message] }, tree };
    }
    applyRefreshedMediatorFlow(tree, {
      mediatorPublicKey: flow.mediatorPublicKey,
      flowToken: flow.flowToken,
    });
    // SEC-01 part B: persist the in-flight forward BEFORE the merge lands, so a
    // crash in the window between merge-into-mediator and the forward is
    // recoverable on reload. Cleared once the close completes below.
    const forwardMemo = (
      mediatorForwardNode.metadata as { readonly memo?: PendingMediatorForward["memo"] }
    ).memo;
    savePendingForward({
      publicKey: input.publicKey,
      mediatorPublicKey: flow.mediatorPublicKey,
      flowToken: flow.flowToken,
      ultimateDestination: forwardDestination,
      ...(forwardMemo ? { memo: forwardMemo } : {}),
      networkId: input.network.id,
      savedAt: Date.now(),
    });
  }

  // re-hydrate the tree against fresh sequence numbers / ledger state
  const ledger = await rpc.getLatestLedger();
  await hydratePlanTransactions(tree, input.publicKey, {
    rpc,
    horizon,
    network: input.network,
    currentLedger: ledger.sequence,
    fetchSourceAccount: (pk) => horizon.loadAccount(pk),
  });
  const submitSoroban = async (signedXdr: string): Promise<ConfirmationReceipt> => {
    const signed = TransactionBuilder.fromXDR(signedXdr, input.network.passphrase) as Transaction;
    const send = await rpc.sendTransaction(signed);
    if (send.status !== "PENDING" && send.status !== "DUPLICATE") {
      throw new Error(`submitSoroban: sendTransaction returned ${send.status}`);
    }
    // bounded poll (~60s). the SDK short-circuits on a definitive status, so a
    // trailing NOT_FOUND means the poll ceiling was hit while the tx was still
    // pending. That is NOT the same as a hard on-chain FAILED, so report it
    // distinctly instead of asserting failure for a tx that may still confirm.
    // (kept bounded, not unbounded: the RPC's tx-retention window ages hashes
    // out of its queryable set, so polling forever is not safe either.)
    const result = await rpc.pollTransaction(send.hash, { attempts: 60 });
    if (result.status === "FAILED") {
      throw new Error(`submitSoroban: transaction ${send.hash} failed on-chain`);
    }
    if (result.status !== "SUCCESS") {
      // status is NOT_FOUND: poll ceiling reached, tx may still confirm shortly
      throw new Error(
        `submitSoroban: transaction ${send.hash} still pending after polling; ` +
          "it may confirm shortly. Verify on-chain before re-running this step.",
      );
    }
    return { txHash: send.hash, ledger: result.ledger };
  };

  input.onProgress({
    kind: "submitting",
    message: "Executing demolition plan…",
  });

  try {
    const output = await executePlanTreeOnChain(
      {
        publicKey: input.publicKey,
        tree,
        previousReceipts: {},
        onNodeUpdate: () => input.onNodeTick(),
      },
      {
        network: input.network,
        connector: input.connector,
        horizon,
        submitClassic,
        submitSoroban,
        // re-run Soroban discovery at merge time and refuse if any position remains
        // (undiscovered / skipped / failed-to-close), so nothing is merged around
        reprobeSorobanPositions: (pk, net) => new DirectContractProvider().getPositions(pk, net),
      },
    );
    // final receipt = FinalClassicTx merge, else last confirmed
    const finalNode = output.tree.allNodes.get("final-classic-tx");
    const mergedTxHash = finalNode?.executed?.txHash;
    const forwardNode = output.tree.allNodes.get("mediator-forward");
    const forwardTxHash = forwardNode?.executed?.txHash;

    // SEC-01 part B: the forward confirmed (or there was none) — the transiting
    // funds have been swept out, so drop the persisted crash-recovery record. If
    // the forward failed, executePlanTreeOnChain throws (handled below) and the
    // record is KEPT so the user can resume it on reload.
    if (forwardNode === undefined || forwardNode.status === "confirmed") {
      clearPendingForward();
    }

    // the executor cascade-skips the merge when a dependency (a DeFi exit) fails,
    // so a non-confirmed final node means the account did NOT close, so surface it
    // as a failure instead of a false "Demolition complete."
    if (finalNode !== undefined && finalNode.status !== "confirmed") {
      const reason =
        finalNode.error ??
        "the account merge did not complete because a required step was skipped or failed.";
      input.onProgress({ kind: "blocked", message: `Merge did not complete: ${reason}` });
      return { result: { ok: false, errors: [reason] }, tree: output.tree };
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
      tree: output.tree,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.onProgress({ kind: "blocked", message });
    return { result: { ok: false, errors: [message] }, tree };
  }
});

const initialContext: PageFlowContext = {
  input: null,
  audit: null,
  positions: EMPTY_POSITIONS,
  allowances: [],
  heldTokens: [],
  unreadableHeldTokens: [],
  heldTokenScanFailed: false,
  discoveryWarnings: [],
  unroutableCredits: [],
  tree: null,
  progress: [],
  result: null,
  error: null,
  signedBundleXdr: null,
};

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
    // Machine-level enforcement of the typed-destination confirmation gate. The
    // typed value, the timed delay, and the high-value acknowledgement are driven
    // in React, but the irreversible execute transition ALSO refuses here unless
    // the CONFIRM event carries the last-4 chars of the reviewed destination — so
    // a CONFIRM dispatched outside the confirmation UI (a bug, or state poking)
    // cannot trigger the merge.
    confirmMatchesDestination: ({ context, event }) => {
      if (event.type !== "CONFIRM") return false;
      const dest = context.input?.destination;
      return typeof dest === "string" && dest.length >= 4 && event.typed === dest.slice(-4);
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
            input: ({ event }) => event.input,
            audit: null,
            discoveryWarnings: [],
            unroutableCredits: [],
            tree: null,
            progress: [],
            result: null,
            error: null,
          }),
        },
      },
    },
    discovering: {
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
          }),
        },
        onError: {
          target: "failed",
          actions: assign({ error: ({ event }) => describeError(event.error) }),
        },
      },
    },
    previewing: {
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
          actions: assign({ error: ({ event }) => describeError(event.error) }),
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
            input: ({ event }) => event.input,
            audit: null,
            discoveryWarnings: [],
            unroutableCredits: [],
            tree: null,
            progress: [],
            result: null,
            error: null,
            signedBundleXdr: null,
          }),
        },
        CONFIRM: { target: "executing", guard: "confirmMatchesDestination" },
        // a multisig close: submit the collected, fully-signed bundle as-is
        SUBMIT_BUNDLE: {
          target: "executing",
          actions: assign({ signedBundleXdr: ({ event }) => event.signedXdr }),
        },
        CANCEL: "cancelled",
      },
    },
    executing: {
      invoke: {
        src: "execute",
        input: ({ context, self }): ExecuteInput => {
          const i = context.input;
          if (!i) throw new Error("executing: missing input");
          if (!context.tree) throw new Error("executing: missing tree from preview");
          return {
            publicKey: i.publicKey,
            network: i.network,
            connector: i.connector,
            destination: i.destination,
            useMediator: i.useMediator,
            positions: context.positions,
            allowances: context.allowances,
            tree: context.tree,
            ...(context.signedBundleXdr ? { signedBundleXdr: context.signedBundleXdr } : {}),
            ...(i.memo ? { memo: i.memo } : {}),
            ...(i.userFallbackAddress ? { userFallbackAddress: i.userFallbackAddress } : {}),
            ...(i.selectedClaimableBalanceIds
              ? { selectedClaimableBalanceIds: i.selectedClaimableBalanceIds }
              : {}),
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
              // executor mutated nodes in place; re-assign tree to a new
              tree: ({ event }) => ({ ...event.output.tree }),
            }),
          },
          {
            target: "failed",
            actions: assign({
              result: ({ event }) => event.output.result,
              error: ({ event }) => event.output.result.errors.join("; "),
              tree: ({ event }) => ({ ...event.output.tree }),
            }),
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) => describeError(event.error),
            tree: ({ context }) => markFinalNode(context.tree, "failed"),
          }),
        },
      },
      on: {
        _PROGRESS: {
          actions: assign({
            progress: ({ context, event }) => [...context.progress, event.event],
            tree: ({ context, event }) => applyProgressToTree(context.tree, event.event),
          }),
        },
        // executor mutates node.status in place on the shared tree
        _NODE_TICK: {
          actions: assign({
            tree: ({ context }) => (context.tree ? { ...context.tree } : null),
          }),
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
        // re-execute the already-mutated failed tree so the executor's
        // node.executed skip logic skips already-confirmed on-chain steps
        // instead of re-signing/re-submitting them; fall back to a full
        // rediscovery only when the failure happened before a tree existed.
        RETRY: [
          { target: "executing", guard: ({ context }) => context.tree !== null },
          { target: "discovering" },
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

function describeError(err: unknown): string {
  // Soroban RPC rejects with a plain `{ code, message }` object, not an Error,
  // so delegate to the shared extractor rather than falling straight through to
  // String(err) (which would surface "[object Object]" for a failed RPC exit).
  return errorMessage(err);
}

// reflect progress events onto the final-classic-tx / mediator-forward nodes
function applyProgressToTree(tree: PlanTree | null, event: DemolishProgressEvent): PlanTree | null {
  if (!tree) return tree;
  const finalNode = tree.allNodes.get("final-classic-tx");
  if (finalNode) {
    switch (event.kind) {
      case "complete":
        if (finalNode.status !== "failed") finalNode.status = "confirmed";
        break;
      case "blocked":
        finalNode.status = "failed";
        finalNode.error = event.message;
        break;
      default:
        // batch-built / submitting / submitted / mediator-cosign are now no-ops
        break;
    }
  }
  const mediatorNode = tree.allNodes.get("mediator-forward");
  if (
    mediatorNode &&
    event.kind === "submitted" &&
    event.txHash &&
    finalNode?.executed?.txHash &&
    event.txHash !== finalNode.executed.txHash
  ) {
    mediatorNode.status = "confirmed";
    mediatorNode.executed = { txHash: event.txHash, ledger: 0 };
  }
  return { ...tree };
}

function markFinalNode(tree: PlanTree | null, status: PlanNodeStatus): PlanTree | null {
  if (!tree) return tree;
  const finalNode = tree.allNodes.get("final-classic-tx");
  if (finalNode) finalNode.status = status;
  return { ...tree };
}
