// walks a hydrated plan tree in topological order and signs and submits each
// node. used by the page-flow machine's execute actor.

import {
  Asset,
  BASE_FEE,
  NotFoundError,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import type { Connector } from "@/lib/wallet/connector";
import {
  auditAccount,
  AccountNotFoundError,
  assessMergeability,
  type AccountAuditResult,
} from "@/lib/stellar/account-audit";
import { AllowlistViolation, assertTransactionAllowed } from "@/lib/stellar/allowlist";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { filterClaimableNow } from "@/lib/stellar/claimable-balances";
import { DEFAULT_TX_VALIDITY_SECONDS, type LedgerClock } from "@/lib/stellar/ledger-clock";
import {
  batchClassicDemolition,
  buildClassicUnwindBatches,
  mediatorFundingCheck,
  planClaimableBalances,
  unroutableCredits,
  type UnroutableCredit,
} from "@/lib/plan/classic-batcher";
import { finalBatchOptions } from "@/lib/plan/generator";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { submitMediatorForward } from "@/lib/mediator/forward";
import { encodeMemoCommitment, forwardMemoToSdk } from "@/lib/mediator/forward-terms";
import { applyRefreshedMediatorFlow, MEDIATOR_FORWARD_NODE_ID } from "@/lib/mediator/refresh";
import {
  BackstopEmissionsClaimError,
  PriceImpactRefusedError,
  resolveContractIdForAsset,
} from "@/lib/plan/hydration";
import { NoSoroswapRouteError } from "@/lib/adapters/soroswap/swap";
import { assertSafeTransferInvocation, UnsafeTransferError } from "@/lib/soroban/transfer-guard";
import { assertSafeRevokeInvocation, UnsafeRevokeError } from "@/lib/soroban/revoke-guard";
import { assertDefiAuthTree, UnsafeDefiAuthError } from "@/lib/soroban/defi-auth-guard";
import {
  assertSorobanFeeWithinCap,
  SorobanFeeCapError,
  sorobanFeeCeiling,
  type SorobanFeeClass,
} from "@/lib/soroban/fee-cap";
import {
  nodeTransaction,
  planExitPayoutTokens,
  topologicalOrder,
  type ClassicUnwindNode,
  type ConvertSorobanToXLMNode,
  type FinalClassicTxNode,
  type MediatorForwardNode,
  type PlanNode,
  type PlanTree,
  type TransferAsIsNode,
} from "@/lib/plan/tree";
import { openPositionCount, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { AccountAudit } from "@/lib/types/account";
import { pathKey, type ClassicBatch, type ClassicMemo, type PathResultRef } from "@/lib/types/plan";
import { AmbiguousSubmitError, CloseFailure, rejectionCodes } from "@/lib/orchestrator/failures";
import { journalFor, type NodeJournal } from "@/lib/orchestrator/journal";
import { residueLineProblem, type DestinationLine } from "@/lib/orchestrator/residue";
import {
  decimalToStroops as toStroops,
  stroopsToDecimal,
  stroopsToTrimmedDecimal,
} from "@/lib/stellar/amount";
import { shortAddress } from "@/lib/safe-display";

export interface ConfirmationReceipt {
  readonly txHash: string;
  readonly ledger: number;
}

// the horizon surface the executor reads. the latest ledger times every classic
// batch and sizes its fee to the spendable balance; fee stats set the starting
// bid, since a minimum bid during surge pricing never lands.
export type HorizonLike = Pick<Horizon.Server, "loadAccount" | "ledgers" | "feeStats">;

// on-chain outcome of a transaction submitted earlier. "pending" means not found
// yet while it can still be included; "expired" means not found and past its
// maxTime, so it never will be.
export type TxLookup =
  | { readonly status: "success"; readonly ledger: number }
  | { readonly status: "failed" }
  | { readonly status: "pending" }
  | { readonly status: "expired" };

export interface LandedMerge extends ConfirmationReceipt {
  // the account the balance was merged into
  readonly into: string;
}

export interface PersistedFlow {
  readonly mediatorPublicKey: string;
  readonly flowToken: string;
  readonly ultimateDestination: string;
  readonly memo?: ClassicMemo;
  // local clock reading taken before the request that issued flowToken. the
  // server's ttl runs from a moment after it, so issuedAt + ttl never
  // overstates how long the token lives, whatever the clock skew.
  readonly issuedAt: number;
}

// how the executor gets and keeps the exchange-forward flow. the flow is minted
// right before the batch that funds the mediator, so its token ttl covers the
// merge and the forward and not every step before them.
export interface MediatorFlowControl {
  // the memo is the exchange deposit memo the forward will carry
  mint(
    destination: string,
    memo: PersistedFlow["memo"],
  ): Promise<{ mediatorPublicKey: string; flowToken: string }>;
  // records the flow durably; called before the funding batch is signed
  persist(flow: PersistedFlow): void;
  // the flow recorded for this account by an earlier attempt, if any
  previous(): PersistedFlow | null;
  // the forward out of this mediator confirmed
  forwarded(mediatorPublicKey: string): void;
  // a fresh token for the same flow, when the deployment offers it
  reissue?(flowToken: string): Promise<{ flowToken: string }>;
  // the forward that emptied this mediator into destination, if one landed. it
  // throws when the mediator was emptied anywhere else.
  findForward?(mediatorPublicKey: string, destination: string): Promise<ConfirmationReceipt | null>;
}

export interface ExecutorDeps {
  readonly network: NetworkConfig;
  readonly connector: Connector;
  readonly horizon: HorizonLike;
  readonly submitClassic: (signedXdr: string) => Promise<ConfirmationReceipt>;
  readonly submitSoroban: (signedXdr: string) => Promise<ConfirmationReceipt>;
  // execute-time soroban discovery for the merge guard. the classic re-audit
  // does not see defi positions, so without it a position left open is merged
  // around and stranded. production always wires it.
  readonly reprobeSorobanPositions?: (
    publicKey: string,
    network: NetworkConfig,
  ) => Promise<ProtocolPositions>;
  // rebuilds a soroban node's transaction from fresh state right before signing.
  // without it the preview-built transaction is signed and a stale-state
  // rejection is not retried.
  readonly rebuildSorobanNode?: (node: PlanNode, publicKey: string) => Promise<void>;
  readonly lookupClassicTransaction?: (hash: string, maxTime: number | null) => Promise<TxLookup>;
  readonly lookupSorobanTransaction?: (hash: string, maxTime: number | null) => Promise<TxLookup>;
  readonly mediatorFlow?: MediatorFlowControl;
  // the account_merge that deleted this account, if one landed. a merge whose
  // reply was lost then finishes the close instead of reading as "account gone".
  readonly findAccountMerge?: (publicKey: string) => Promise<LandedMerge | null>;
  // the SEP-41 balance of a token held by the account. the merge guard reads
  // the tokens the plan's defi exits pay out, so exit proceeds that are not a
  // classic balance are never merged away. required when the plan has such exits.
  readonly readTokenBalance?: (contractId: string, holder: string) => Promise<bigint>;
  // called right before a soroban step is signed, with the fee the signature
  // authorizes, so the user sees it while the wallet asks
  readonly onSigning?: (node: PlanNode, totalFeeStroops: bigint) => void;
  // aborting stops the close at the next step boundary, never mid-submit
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface ExecutionOutput {
  readonly receipts: Record<string, ConfirmationReceipt>;
  readonly tree: PlanTree;
}

// steps whose failure leaves something behind by design instead of stopping the
// close (a token the user asked to sweep, an allowance revoke). a skipped one
// still lets its dependents run.
export const BEST_EFFORT_KINDS: ReadonlySet<PlanNode["kind"]> = new Set([
  "TransferAsIs",
  "ConvertSorobanToXLM",
  "RevokeAllowance",
]);

export const DEPENDENCY_SKIP_PREFIX = "Skipped: dependency";

// rides out horizon blips (5xx, 429, no response) on the idempotent reads that
// prepare a classic phase. a 404 or another 4xx is a real answer and is
// rethrown at once. the sdk drops response headers, so a 429 backs off on the
// same schedule instead of honoring retry-after.
async function withHorizonRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof AccountNotFoundError) throw err;
      const status = httpStatus(err);
      if (status !== undefined && status < 500 && status !== 429) throw err;
      if (i === tries - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** i));
    }
  }
  throw lastErr;
}

function httpStatus(err: unknown): number | undefined {
  const s = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof s === "number" ? s : undefined;
}

function isNotFound(err: unknown): boolean {
  return err instanceof NotFoundError || httpStatus(err) === 404;
}

const DEFAULT_FEE_BASE = Number.parseInt(BASE_FEE, 10); // 100 stroops/op network minimum
// per-op ceiling for surge bidding (0.1 XLM/op); the spendable-balance cap and
// the u32 total-fee guard in buildClassicTransaction bound it further
export const MAX_PER_OP_FEE = 1_000_000;
const MAX_MERGE_ATTEMPTS = 3;
// one batch per phase, re-audited in between, so a close needs
// ceil(totalOps / MAX_OPS_PER_TX) + 1 phases. the ~1000 subentry ceiling keeps
// that well under 30; more means the close is not converging.
const MAX_CLOSE_PHASES = 30;
const MAX_SOROBAN_ATTEMPTS = 3;

// what a soroban step may cost before it is signed (soroban/fee-cap.ts has the
// measurements). a step that runs a token nobody vetted gets a class that also
// bounds the writes it declares: the airdrop-reachable transfer and revoke, the
// held-token swap, a soroswap lp exit, whose pair can hold any token, and the
// aquarius exits and gauge reward claims, whose router is pinned but whose pools
// and gauges are permissionless, so a pool or reward token runs inside them too.
// the blend steps run only pinned pools and backstops.
function feeClassOf(node: PlanNode): SorobanFeeClass {
  switch (node.kind) {
    case "RevokeAllowance":
    case "TransferAsIs":
      return "untrusted-token";
    case "ConvertSorobanToXLM":
    case "WithdrawSoroswapLp":
      return "untrusted-convert";
    case "WithdrawAquarius":
    case "ClaimAquariusRewards":
    case "WithdrawAquariusConcentrated":
    case "ClaimAquariusConcentratedFees":
    case "ClaimAquariusGaugeRewards":
      return "pool-exit";
    default:
      return "defi-exit";
  }
}

// the most this soroban step is signed for, whatever its rebuild re-simulates to
export function sorobanStepFeeCeiling(node: PlanNode): bigint {
  return sorobanFeeCeiling(feeClassOf(node));
}

// the exchange-forward token must outlive the merge (a classic tx valid for 300s
// from build) plus the forward that follows it (up to about 3 minutes with its
// own retries), counted from the moment the merge batch is built
const MEDIATOR_TOKEN_MARGIN_MS = (300 + 180) * 1000;
// the server's flow ttl (server/mediator-secret.ts)
const MEDIATOR_FLOW_TTL_MS = 15 * 60 * 1000;
// the forward alone (with its own retries) takes up to about 3 minutes
const FORWARD_TOKEN_MARGIN_MS = 180 * 1000;

type ClassicRejection = "fee" | "fee_too_high" | "resequence" | "expired" | "price" | "drift";

// which classic rejections a rebuild within this call can clear
function classicRejectionKind(err: unknown): ClassicRejection | null {
  const codes = rejectionCodes(err);
  if (!codes) return null;
  switch (codes.transaction) {
    case "tx_insufficient_fee":
      return "fee";
    // the bid is not covered by the spendable balance; retry at the minimum
    case "tx_insufficient_balance":
      return "fee_too_high";
    case "tx_bad_seq":
      return "resequence";
    case "tx_too_late":
      return "expired";
  }
  const ops = codes.operations ?? [];
  // a path payment missed its floor because the market moved since the quote;
  // the rebuild re-resolves paths
  if (ops.some((o) => PRICE_CODES.has(o))) return "price";
  // ledger state moved under the batch (a payment arrived, an offer filled, a
  // claimable balance went, a pool ratio moved past the withdraw floor); the
  // rebuild re-audits and recomputes every amount
  if (ops.some((o) => DRIFT_CODES.has(o))) return "drift";
  return null;
}

const PRICE_CODES = new Set(["op_under_dest_min", "op_too_few_offers", "op_over_source_max"]);
const DRIFT_CODES = new Set([
  "op_invalid_limit",
  "op_underfunded",
  "op_has_sub_entries",
  "op_src_no_trust",
  "op_offer_not_found",
  "op_does_not_exist",
  "op_cannot_claim",
  "op_cannot_delete",
  "op_under_minimum",
  "op_already_exists",
]);

// a soroban submit failure that rebuilding against fresh state can clear
function sorobanRecoverableKind(err: unknown): "resequence" | "footprint" | "refee" | null {
  if (err instanceof AmbiguousSubmitError) return null;
  const code = (err as { resultCode?: unknown } | null)?.resultCode;
  if (code === "txBadSeq") return "resequence";
  // the resource fee the simulation priced went stale; re-simulation re-prices it
  if (code === "txInsufficientFee" || code === "txSorobanInvalid") return "refee";
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes("tx_bad_seq") || msg.includes("txbadseq") || msg.includes("bad_seq")) {
    return "resequence";
  }
  if (
    msg.includes("footprint") ||
    msg.includes("restorepreamble") ||
    msg.includes("restore_preamble") ||
    msg.includes("entryarchived") ||
    msg.includes("entry_archived") ||
    msg.includes("archived") ||
    msg.includes("entry_expired") ||
    // a write the simulation did not see (blend's time-dependent emission
    // accrual) traps on chain as exceeded-limit; a re-simulation declares it
    msg.includes("scecexceededlimit") ||
    msg.includes("exceededlimit") ||
    msg.includes("exceeded_limit")
  ) {
    return "footprint";
  }
  return null;
}

// starting per-op bid from what recent ledgers actually charged (horizon's
// fee_charged is per operation). max_fee is what others offered, which sits at
// the cap on mainnet and would price ordinary accounts out of their own close.
// soroban resource fees are counted in fee_charged too, so its p90 can sit far
// above any classic surge while ledgers are mostly empty; below half capacity
// there is no surge to outbid and the most common charge is the bid, as the
// mediator forward does. an unreadable answer fails the step rather than bid
// the network minimum, which never lands while fees surge.
const SURGE_CAPACITY_USAGE = 0.5;

export async function surgeFeeBase(horizon: HorizonLike): Promise<number> {
  const unreadable = (detail: string, cause?: unknown): CloseFailure =>
    new CloseFailure(
      "network",
      `The network fees could not be read (${detail}). Retry once Horizon answers.`,
      cause === undefined ? undefined : { cause },
    );
  // typed loosely: a proxy or a misbehaving horizon can answer with any json
  let stats: Partial<Horizon.HorizonApi.FeeStatsResponse> | null;
  try {
    stats = await withHorizonRetry(() => horizon.feeStats());
  } catch (err) {
    throw unreadable(`Horizon fee_stats failed: ${errorMessage(err)}`, err);
  }
  const usageRaw = stats?.ledger_capacity_usage;
  const usage =
    typeof usageRaw === "string" && usageRaw.trim() !== "" ? Number(usageRaw) : Number.NaN;
  if (!Number.isFinite(usage)) {
    throw unreadable(`Horizon fee_stats reported ledger_capacity_usage "${String(usageRaw)}"`);
  }
  const field = usage < SURGE_CAPACITY_USAGE ? "mode" : "p90";
  const pick: unknown = stats?.fee_charged?.[field];
  const bid = typeof pick === "string" && /^\d+$/.test(pick) ? Number(pick) : Number.NaN;
  if (!Number.isFinite(bid) || bid <= 0) {
    throw unreadable(`Horizon fee_stats reported fee_charged.${field} "${String(pick)}"`);
  }
  return Math.min(Math.max(DEFAULT_FEE_BASE, bid), MAX_PER_OP_FEE);
}

async function readBaseReserve(horizon: HorizonLike): Promise<bigint> {
  const page = await latestLedgerPage(horizon);
  const reserve = page.records[0]?.base_reserve_in_stroops;
  if (typeof reserve !== "number" || reserve <= 0) {
    throw new Error("Horizon's latest ledger reported no base reserve");
  }
  return BigInt(reserve);
}

// stellar-core needs the whole fee covered by the spendable native balance
// (balance minus minimum balance minus selling liabilities)
function capFeeToBalance(
  feeBase: number,
  opCount: number,
  audit: AccountAudit,
  baseReserve: bigint,
): number {
  const native = audit.balances.find((b) => b.asset.kind === "native");
  const balance = native ? toStroops(native.amount) : 0n;
  const selling = native ? toStroops(native.sellingLiabilities) : 0n;
  const entries =
    2n +
    BigInt(audit.subentryCount) +
    BigInt(audit.sponsorship.numSponsoring) -
    BigInt(audit.sponsorship.numSponsored);
  const available = balance - entries * baseReserve - selling;
  const perOp = available / BigInt(opCount);
  if (perOp < BigInt(DEFAULT_FEE_BASE)) {
    throw new CloseFailure(
      "not_mergeable",
      `The account has ${stroopsToDecimal(available)} XLM it can spend, which does not cover the minimum ` +
        `network fee for the next ${opCount}-operation step. Add a little XLM and retry.`,
    );
  }
  return Number(perOp < BigInt(feeBase) ? perOp : BigInt(feeBase));
}

function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CloseFailure(
      "interrupted",
      "The close was stopped before its next step. Steps that already landed stay on chain; nothing further was signed.",
    );
  }
}

async function signWith(
  deps: ExecutorDeps,
  tx: Transaction,
  what: string,
): Promise<{ signedXdr: string }> {
  throwIfInterrupted(deps.signal);
  try {
    return await deps.connector.signTransaction(tx, deps.network.passphrase);
  } catch (err) {
    throw new CloseFailure("signing", `The wallet did not sign ${what}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

function hashHex(tx: Transaction): string {
  return Array.from(tx.hash(), (b) => b.toString(16).padStart(2, "0")).join("");
}

function maxTimeOf(tx: Transaction): number | null {
  const max = Number(tx.timeBounds?.maxTime ?? 0);
  return Number.isFinite(max) && max > 0 ? max : null;
}

interface Run {
  readonly publicKey: string;
  readonly tree: PlanTree;
  readonly deps: ExecutorDeps;
  readonly receipts: Record<string, ConfirmationReceipt>;
  readonly notify: (node: PlanNode) => void;
  readonly note: (text: string) => void;
}

export async function executePlanTreeOnChain(
  input: {
    publicKey: string;
    tree: PlanTree;
    // fires after every node.status mutation so the ui can re-render
    onNodeUpdate?: (node: PlanNode) => void;
    // a best-effort step did not do what the plan asked, in words for the user
    onNote?: (text: string) => void;
  },
  deps: ExecutorDeps,
): Promise<ExecutionOutput> {
  const receipts: Record<string, ConfirmationReceipt> = {};
  const run: Run = {
    publicKey: input.publicKey,
    tree: input.tree,
    deps,
    receipts,
    notify: (node) => {
      try {
        input.onNodeUpdate?.(node);
      } catch {
        // a ui listener must never abort execution
      }
    },
    note: (text) => input.onNote?.(text),
  };

  for (const node of topologicalOrder(input.tree)) {
    if (node.executed !== undefined) {
      node.status = "confirmed";
      receipts[node.id] = { txHash: node.executed.txHash, ledger: node.executed.ledger };
      run.notify(node);
      continue;
    }
    if (node.status === "skipped" || node.status === "failed") continue;
    // the forward signs nothing for the user and is what moves the balance out
    // of the temporary account, so a stop request lets it finish
    if (node.kind !== "MediatorForward") throwIfInterrupted(deps.signal);

    // a node runs only once what it depends on is done. a skipped best-effort
    // step counts as done (it leaves something behind by design); anything else
    // that did not confirm blocks, so a failed exit is never merged around and the
    // forward never runs from a mediator the merge did not reach.
    const blocking = node.dependencies
      .map((id) => input.tree.allNodes.get(id))
      .find((dep) => !dependencySatisfied(node, dep));
    if (blocking !== undefined || node.dependencies.some((id) => !input.tree.allNodes.has(id))) {
      const dep = blocking;
      node.status = "skipped";
      node.error = dep
        ? `${DEPENDENCY_SKIP_PREFIX} "${dep.id}" did not complete${dep.error ? `: ${dep.error}` : "."}`
        : `${DEPENDENCY_SKIP_PREFIX} is missing from the plan.`;
      run.notify(node);
      continue;
    }

    switch (node.kind) {
      case "FinalClassicTx": {
        let receipt: ConfirmationReceipt;
        try {
          receipt = await runFinalClassic(node, run);
        } catch (err) {
          node.status = "failed";
          node.error = errorMessage(err);
          run.notify(node);
          throw err;
        }
        confirm(node, receipt, run);
        continue;
      }
      case "MediatorForward":
        await runForward(node, run);
        continue;
      case "ClassicUnwind": {
        // never best-effort: the repays after it need the asset it frees
        let receipt: ConfirmationReceipt | null;
        try {
          receipt = await runClassicUnwind(node, run);
        } catch (err) {
          node.status = "failed";
          node.error = errorMessage(err);
          run.notify(node);
          throw err;
        }
        if (receipt === null) {
          // nothing locked a repay asset, so there was nothing to sign
          node.status = "confirmed";
          run.notify(node);
        } else {
          confirm(node, receipt, run);
        }
        continue;
      }
      case "TransferAsIs":
        await runBestEffortTransfer(node, run);
        continue;
      case "ConvertSorobanToXLM":
        await runConvert(node, run);
        continue;
      case "RevokeAllowance": {
        // the revoke targets a token contract taken from an event scan, so the
        // contract and its simulated auth tree are attacker-influenceable: it is
        // held to exactly approve(user, spender, 0). it is best-effort so a
        // hostile token can neither drain (the guard) nor block the close (skip).
        // the merge does not remove the allowance: it lives in the token
        // contract's storage, so a skipped revoke is reported.
        const md = node.metadata;
        try {
          const receipt = await signAndSubmitSorobanNode(node, run, {
            allowlist: false,
            guard: (tx) =>
              assertSafeRevokeInvocation(tx, {
                contractId: md.contractId,
                from: run.publicKey,
                spender: md.spender,
              }),
          });
          confirm(node, receipt, run);
        } catch (err) {
          if (err instanceof CloseFailure && err.kind === "interrupted") throw err;
          node.status = "skipped";
          node.error = `Allowance revoke skipped: ${errorMessage(err)}`;
          run.notify(node);
          run.note(
            (err instanceof AmbiguousSubmitError
              ? `The revoke of the allowance for spender ${shortAddress(md.spender, 4, 4)} on token ` +
                `${shortAddress(md.contractId, 4, 4)} was submitted as ${err.txHash}, but the network has not ` +
                "confirmed whether it landed. If it did not, "
              : `The allowance for spender ${shortAddress(md.spender, 4, 4)} on token ${shortAddress(md.contractId, 4, 4)} was not ` +
                `revoked (${errorMessage(err)}). `) +
              "Closing the account does not remove it: any balance of that token held at this " +
              "address stays spendable by that spender.",
          );
        }
        continue;
      }
      default: {
        // a required defi exit (or a trustline ahead of a claim or exit): an
        // allow-listed contract and exactly the auth tree its call needs. a kind
        // the auth guard has no expected tree for is refused, so a step added to
        // the plan without one is never signed. a failure stops the close before
        // the merge.
        let receipt: ConfirmationReceipt;
        try {
          receipt = await signAndSubmitSorobanNode(node, run, { allowlist: true });
        } catch (err) {
          node.status = "failed";
          node.error = errorMessage(err);
          run.notify(node);
          throw err;
        }
        confirm(node, receipt, run);
      }
    }
  }

  return { receipts, tree: input.tree };
}

function dependencySatisfied(node: PlanNode, dep: PlanNode | undefined): boolean {
  if (dep === undefined) return false;
  if (dep.status === "confirmed") return true;
  if (node.kind === "MediatorForward") return false;
  if (dep.status !== "skipped") return false;
  return BEST_EFFORT_KINDS.has(dep.kind) && !isDependencySkip(dep);
}

function isDependencySkip(node: PlanNode): boolean {
  return node.error?.startsWith(DEPENDENCY_SKIP_PREFIX) === true;
}

function confirm(node: PlanNode, receipt: ConfirmationReceipt, run: Run): void {
  node.status = "confirmed";
  node.executed = { txHash: receipt.txHash, ledger: receipt.ledger };
  run.receipts[node.id] = receipt;
  run.notify(node);
}

// the user's opted-in held-token sweep: exactly transfer(user, destination,
// amount) and nothing else, since the token is airdrop-reachable. best-effort: a
// token that can't be moved stays on the closed account and is reported.
async function runBestEffortTransfer(node: TransferAsIsNode, run: Run): Promise<void> {
  try {
    const receipt = await signAndSubmitSorobanNode(node, run, {
      allowlist: false,
      guard: transferGuard(node, run),
    });
    confirm(node, receipt, run);
  } catch (err) {
    if (err instanceof CloseFailure && err.kind === "interrupted") throw err;
    node.status = "skipped";
    node.error = `Token drain skipped: ${errorMessage(err)}`;
    run.notify(node);
    run.note(
      err instanceof AmbiguousSubmitError
        ? `The transfer of token ${tokenLabel(node.metadata.asset)} was submitted as ${err.txHash}, ` +
            "but the network has not confirmed whether it landed. If it did not, the token stays " +
            "on the closed account."
        : `Token ${tokenLabel(node.metadata.asset)} was not moved (${errorMessage(err)}); it stays on the closed account.`,
    );
  }
}

function transferGuard(node: TransferAsIsNode, run: Run): (tx: Transaction) => void {
  const md = node.metadata;
  return (tx) =>
    assertSafeTransferInvocation(tx, {
      contractId: resolveContractIdForAsset(md.asset, run.deps.network),
      from: run.publicKey,
      to: md.destination,
      amount: md.amount,
    });
}

// the opted-in conversion of a held token through the soroswap router. when it
// can't run (no market, a zero quote, a refused auth tree) the token is sent to
// the destination as-is instead; if that fails too the close stops before the
// merge, because merging now would strand the token.
async function runConvert(node: ConvertSorobanToXLMNode, run: Run): Promise<void> {
  let convertError: unknown;
  try {
    const receipt = await signAndSubmitSorobanNode(node, run, { allowlist: true });
    confirm(node, receipt, run);
    return;
  } catch (err) {
    stopUnlessSettled(node, err, run);
    convertError = err;
  }
  const label = tokenLabel(node.metadata.asset);
  // a price the user did not agree to, or a token with no route left, is a
  // question for them, not a reason to send the token somewhere else on their
  // behalf
  const refusal = conversionRefusal(convertError);
  if (refusal !== null) {
    const contractId = resolveContractIdForAsset(node.metadata.asset, run.deps.network);
    node.status = "failed";
    node.error =
      `The conversion of token ${contractId} to XLM was refused before signing: ${refusal}. ` +
      `Rebuild the plan to ${
        convertError instanceof NoSoroswapRouteError ? "" : "accept the new price, "
      }send the token as-is, or leave it out.`;
    run.notify(node);
    throw new CloseFailure("conversion_refused", node.error, { cause: convertError });
  }
  const final = [...run.tree.allNodes.values()].find(
    (n): n is FinalClassicTxNode => n.kind === "FinalClassicTx",
  );
  let fallbackError: unknown;
  if (final === undefined || final.metadata.useMediator) {
    fallbackError = new Error("an exchange destination can't receive this token as-is");
  } else {
    const transfer: TransferAsIsNode = {
      id: `${node.id}:as-is`,
      kind: "TransferAsIs",
      dependencies: [],
      description: `Send held token ${label} as-is`,
      status: "pending",
      metadata: {
        kind: "TransferAsIs",
        asset: node.metadata.asset,
        amount: node.metadata.amount,
        destination: final.metadata.destination,
      },
    };
    try {
      const receipt = await signAndSubmitSorobanNode(transfer, run, {
        allowlist: false,
        guard: transferGuard(transfer, run),
      });
      confirm(node, receipt, run);
      run.note(
        `Token ${label} could not be converted to XLM (${errorMessage(convertError)}), so it was ` +
          `sent to your destination as-is (transaction ${receipt.txHash}).`,
      );
      return;
    } catch (err) {
      stopUnlessSettled(node, err, run);
      fallbackError = err;
    }
  }
  node.status = "failed";
  node.error =
    `Could not convert token ${label} (${errorMessage(convertError)}) or send it as-is ` +
    `(${errorMessage(fallbackError)}). Remove it from the close, or move it out of the account ` +
    "yourself, then rebuild the plan.";
  run.notify(node);
  throw new CloseFailure("position_open", node.error);
}

// the reason a conversion needs the user's answer (decision: accept the new
// rate, send the token as-is, or leave it), or null when the failure is not a
// refusal
function conversionRefusal(err: unknown): string | null {
  if (err instanceof NoSoroswapRouteError) return err.message;
  if (!(err instanceof PriceImpactRefusedError)) return null;
  const quoted =
    err.expectedOut !== undefined
      ? ` (the whole balance would now get ${stroopsToTrimmedDecimal(err.expectedOut)} XLM)`
      : "";
  if (err.reason === "price_impact" && typeof err.priceImpactBps === "number") {
    return `selling it all would move the price by ${(err.priceImpactBps / 100).toFixed(2)}%${quoted}`;
  }
  if (err.reason === "requote_worse") {
    return `the market now pays less than the quote you reviewed${quoted}`;
  }
  return err.message;
}

// an interruption stops the close; a submission with an unknown outcome must not
// be followed by another action on the same token
function stopUnlessSettled(node: PlanNode, err: unknown, run: Run): void {
  if (!(err instanceof CloseFailure)) return;
  if (err.kind === "ambiguous") {
    node.status = "failed";
    node.error = err.message;
    run.notify(node);
    throw err;
  }
  if (err.kind === "interrupted") throw err;
}

function tokenLabel(asset: TransferAsIsNode["metadata"]["asset"]): string {
  switch (asset.kind) {
    case "contract":
      return shortAddress(asset.contractId, 4, 4);
    case "credit":
      return asset.code;
    case "native":
      return "XLM";
    case "liquidity_pool_shares":
      return shortAddress(asset.poolId, 4, 4);
  }
}

// signs and submits one soroban node, rebuilt from fresh state first. a
// submission from an earlier run whose outcome is unknown is looked up before
// anything is signed again.
async function signAndSubmitSorobanNode(
  node: PlanNode,
  run: Run,
  opts: {
    readonly allowlist: boolean;
    readonly guard?: (tx: Transaction) => void;
  },
): Promise<ConfirmationReceipt> {
  const { deps } = run;
  const journal = journalFor(node);
  const settled = await settlePending(journal, deps.lookupSorobanTransaction, node.description);
  if (settled !== null) return settled;

  const canRebuild = typeof deps.rebuildSorobanNode === "function";
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_SOROBAN_ATTEMPTS; attempt++) {
    throwIfInterrupted(deps.signal);
    if (deps.rebuildSorobanNode) {
      // fresh sequence and re-simulated footprint; throws the real error rather
      // than signing a stale or doomed tx
      try {
        await deps.rebuildSorobanNode(node, run.publicKey);
      } catch (err) {
        if (err instanceof BackstopEmissionsClaimError) throw claimUnavailable(err);
        throw err;
      }
    }
    const tx = nodeTransaction(node);
    if (!tx) {
      throw new Error(`executing: node "${node.id}" (${node.kind}) has no transaction attached`);
    }
    // the checks run before signing and are not retried: an unsafe tree does not
    // become safe on a rebuild
    let totalFee: bigint;
    try {
      opts.guard?.(tx);
      totalFee = opts.allowlist
        ? checkRequiredSorobanStep(node, tx, run.publicKey, deps.network)
        : stepFee(node, tx);
    } catch (err) {
      if (!isUnsafeStepError(err)) throw err;
      throw new CloseFailure(
        "unsafe",
        `Refused to sign "${node.description}": ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }
    throwIfInterrupted(deps.signal);
    deps.onSigning?.(node, totalFee);
    const signed = await signWith(deps, tx, `"${node.description}"`);
    node.status = "signed";
    run.notify(node);
    journal.pending = { hash: hashHex(tx), maxTime: maxTimeOf(tx) };
    try {
      const receipt = await deps.submitSoroban(signed.signedXdr);
      journal.pending = null;
      return receipt;
    } catch (err) {
      // an unknown outcome keeps its hash so the next run looks it up first
      if (!(err instanceof AmbiguousSubmitError)) journal.pending = null;
      lastErr = err;
      const kind = sorobanRecoverableKind(err);
      if (kind === null || !canRebuild || attempt === MAX_SOROBAN_ATTEMPTS) throw err;
    }
  }
  throw lastErr;
}

// the fee the step's signature authorizes, refused (SorobanFeeCapError) when it
// is above what its class of step legitimately costs. the classic trustline steps
// (BLND, or a pool payout asset) carry no soroban resources; one change_trust may
// bid at most the classic per-op ceiling.
function stepFee(node: PlanNode, tx: Transaction): bigint {
  if (node.kind === "AddBlndTrustline" || node.kind === "AddExitTrustline") {
    const fee = BigInt(tx.fee);
    if (fee > BigInt(MAX_PER_OP_FEE)) {
      throw new SorobanFeeCapError(
        "defi-exit",
        { totalFee: fee, inclusionFee: fee, resourceFee: 0n, writeBytes: 0, readWriteEntries: 0 },
        `a one-operation trustline bid over ${MAX_PER_OP_FEE} stroops`,
      );
    }
    return fee;
  }
  return assertSorobanFeeWithinCap(tx, feeClassOf(node)).totalFee;
}

// what every required step (a defi exit, a trustline it pays into, a held-token
// conversion) must pass before it is signed: an allow-listed contract, exactly
// the auth tree its call needs, and a fee within its class's cap. returns the
// fee the signature authorizes. the preview runs it on each built step too, so
// a refused required step blocks the confirmation instead of stopping the close
// after the independent exits already ran.
export function checkRequiredSorobanStep(
  node: PlanNode,
  tx: Transaction,
  user: string,
  network: NetworkConfig,
): bigint {
  // a gauge reward claim runs on its pool, which is allowed as the root only
  // when the build that made tx read it from the pinned router; the auth guard
  // then holds the call to that pool
  assertTransactionAllowed(
    tx,
    network,
    node.kind === "ClaimAquariusGaugeRewards" &&
      node.metadata.routerPool !== undefined &&
      node.metadata.routerPool === node.metadata.poolAddress
      ? { routerResolvedPool: node.metadata.routerPool }
      : {},
  );
  assertDefiAuthTree(node, tx, { user, network });
  return stepFee(node, tx);
}

// the refusals that mean the step asks for more than it needs, as opposed to a
// failure to check it
export function isUnsafeStepError(err: unknown): boolean {
  return (
    err instanceof UnsafeDefiAuthError ||
    err instanceof UnsafeTransferError ||
    err instanceof UnsafeRevokeError ||
    err instanceof AllowlistViolation ||
    err instanceof SorobanFeeCapError
  );
}

// a backstop emissions claim that simulated at review but no longer can. it is
// not skipped on the user's behalf: the close stops before anything else is
// signed and the rebuilt review asks them to forfeit the BLND
function claimUnavailable(err: BackstopEmissionsClaimError): CloseFailure {
  return new CloseFailure(
    "claim_unavailable",
    `The Blend backstop emissions claim for pool ${shortAddress(err.poolId, 4, 4)} can no longer run, so ` +
      `nothing further was signed. Rebuild the plan to review the ` +
      `${stroopsToTrimmedDecimal(err.accruedEmissions)} BLND it would leave unclaimed.`,
    { cause: err },
  );
}

// resolves a submission left with an unknown outcome. returns its receipt when it
// landed as the step's own transaction, null when nothing is pending or it can no
// longer land.
async function settlePending(
  journal: NodeJournal,
  lookup: ((hash: string, maxTime: number | null) => Promise<TxLookup>) | undefined,
  what: string,
): Promise<ConfirmationReceipt | null> {
  const pending = journal.pending;
  if (pending === null) return null;
  if (lookup === undefined) {
    throw new AmbiguousSubmitError(pending.hash, pending.maxTime, "no way to look it up here");
  }
  const outcome = await lookup(pending.hash, pending.maxTime);
  switch (outcome.status) {
    case "success":
      journal.pending = null;
      return { txHash: pending.hash, ledger: outcome.ledger };
    case "failed":
    case "expired":
      journal.pending = null;
      return null;
    case "pending":
      throw new AmbiguousSubmitError(
        pending.hash,
        pending.maxTime,
        `the earlier submission of "${what}" can still land; retry once it has settled`,
      );
  }
}

async function accountExists(horizon: HorizonLike, id: string): Promise<boolean> {
  try {
    await withHorizonRetry(() => horizon.loadAccount(id));
    return true;
  } catch (err) {
    if (isNotFound(err) || err instanceof AccountNotFoundError) return false;
    throw new CloseFailure(
      "network",
      `Could not confirm whether account ${shortAddress(id, 4, 4)} exists (${errorMessage(err)}); nothing was signed.`,
      { cause: err },
    );
  }
}

// keeps the exchange-forward flow safe to merge into. chain state decides: a
// mediator that exists already holds this account's funds and is never replaced;
// a new flow is minted (and recorded) only when the batch about to be signed
// funds the mediator, so its token ttl covers that batch, the merge and the
// forward, and nothing is recorded for a close that stops earlier.
function mediatorSession(run: Run) {
  const forward = run.tree.allNodes.get(MEDIATOR_FORWARD_NODE_ID);
  if (forward === undefined || forward.kind !== "MediatorForward") {
    throw new CloseFailure(
      "unknown",
      "This exchange close has no forward step, so it can't be run.",
    );
  }
  const control = run.deps.mediatorFlow;
  if (control === undefined) {
    throw new CloseFailure(
      "unknown",
      "This exchange close needs the mediator flow, which is not wired.",
    );
  }
  const now = run.deps.now ?? Date.now;
  const destination = forward.metadata.ultimateDestination;
  // when the token on the tree was issued; unknown for the token the preview
  // minted, which is never trusted for the merge
  const issued = journalFor(forward);

  const remainingMs = (): number =>
    issued.flowIssuedAt === null
      ? Number.NEGATIVE_INFINITY
      : issued.flowIssuedAt + MEDIATOR_FLOW_TTL_MS - now();
  const record = (issuedAt: number): PersistedFlow => ({
    mediatorPublicKey: forward.metadata.mediatorPublicKey,
    flowToken: forward.metadata.flowToken,
    ultimateDestination: destination,
    ...(forward.metadata.memo ? { memo: forward.metadata.memo } : {}),
    issuedAt,
  });

  // whether the mediator already holds funds. an earlier attempt's funded
  // mediator is adopted, and a funded mediator's token is renewed (or the merge
  // refused) before anything else is signed into it.
  const probe = async (): Promise<boolean> => {
    const current = forward.metadata.mediatorPublicKey;
    let funded = current.length > 0 && (await accountExists(run.deps.horizon, current));
    if (!funded) {
      const prev = control.previous();
      if (
        prev !== null &&
        prev.mediatorPublicKey !== current &&
        (await accountExists(run.deps.horizon, prev.mediatorPublicKey))
      ) {
        if (prev.ultimateDestination !== destination) {
          throw new CloseFailure(
            "not_mergeable",
            `An earlier exchange close left funds in temporary account ${shortAddress(prev.mediatorPublicKey, 4, 4)}, ` +
              `bound to ${shortAddress(prev.ultimateDestination, 4, 4)}. Resume that forward before closing to a ` +
              "different destination.",
          );
        }
        // the flow token binds the deposit memo, so a forward under the old token
        // can only carry the old memo; never adopt it for a different one
        if (!sameMemo(prev.memo, forward.metadata.memo)) {
          throw new CloseFailure(
            "not_mergeable",
            `An earlier exchange close left funds in temporary account ${shortAddress(prev.mediatorPublicKey, 4, 4)} ` +
              "with a different deposit memo. Resume that forward from the pending-forward notice " +
              "first; it delivers with the memo it was started with.",
          );
        }
        applyRefreshedMediatorFlow(run.tree, prev);
        issued.flowIssuedAt = prev.issuedAt;
        funded = true;
      }
    }
    if (!funded) return false;
    if (remainingMs() < MEDIATOR_TOKEN_MARGIN_MS && control.reissue) {
      const requestedAt = now();
      const fresh = await control.reissue(forward.metadata.flowToken);
      applyRefreshedMediatorFlow(run.tree, {
        mediatorPublicKey: forward.metadata.mediatorPublicKey,
        flowToken: fresh.flowToken,
      });
      issued.flowIssuedAt = requestedAt;
      control.persist(record(requestedAt));
    }
    if (remainingMs() < MEDIATOR_TOKEN_MARGIN_MS) {
      throw new CloseFailure(
        "mediator_expired",
        `The authorization to forward from temporary account ${shortAddress(forward.metadata.mediatorPublicKey, 4, 4)} ` +
          "is about to expire, so the merge was not signed. The funds already in that account are " +
          "recoverable through the pending-forward notice or the operator.",
      );
    }
    return true;
  };

  // called when the next batch funds the mediator. returns true when a new
  // flow (and so a new mediator address) replaced the one on the tree.
  const prepareFunding = async (): Promise<boolean> => {
    if (remainingMs() >= MEDIATOR_TOKEN_MARGIN_MS) return false;
    const requestedAt = now();
    const flow = await control.mint(destination, forward.metadata.memo);
    applyRefreshedMediatorFlow(run.tree, flow);
    issued.flowIssuedAt = requestedAt;
    control.persist(record(requestedAt));
    return true;
  };

  return {
    probe,
    prepareFunding,
    mediatorPublicKey: () => forward.metadata.mediatorPublicKey,
  };
}

function sameMemo(a: ClassicMemo | undefined, b: ClassicMemo | undefined): boolean {
  return encodeMemoCommitment(forwardMemoToSdk(a)) === encodeMemoCommitment(forwardMemoToSdk(b));
}

function fundsMediator(batch: ClassicBatch): boolean {
  return batch.operations.some((op) => op.kind === "create_account_mediator");
}

async function runFinalClassic(node: FinalClassicTxNode, run: Run): Promise<ConfirmationReceipt> {
  const { deps, publicKey } = run;
  const journal = journalFor(node);

  // a batch from an earlier run whose outcome was unknown is settled first; if
  // it was the merge, the close is already done
  const pending = journal.pending;
  const landed = await settlePending(journal, deps.lookupClassicTransaction, node.description);
  if (landed !== null) {
    journal.landedPhases.push(landed);
    if (pending?.final === true) return landed;
  }

  const mediator = node.metadata.useMediator ? mediatorSession(run) : null;
  const baseReserve = await readBaseReserve(deps.horizon);
  let lastQuotes: string | null = null;

  // one batch per phase, re-audited after each lands: a liquidity_pool_withdraw
  // credits assets a later batch must convert and remove, which the same tx
  // can't do. a fresh audit reflects applied ops, so re-entering never resubmits
  // landed work. node.executed is set only after the merge batch lands, so an
  // interrupted close resumes from fresh state instead of reporting success.
  const attemptMerge = async (
    feeBase: number,
    refusedQuotes: string | null,
  ): Promise<ConfirmationReceipt> => {
    for (let phase = 0; phase < MAX_CLOSE_PHASES; phase++) {
      throwIfInterrupted(deps.signal);
      let freshAudit: AccountAuditResult;
      try {
        freshAudit = await withHorizonRetry(() => auditAccount(publicKey, deps.network));
      } catch (err) {
        if (err instanceof AccountNotFoundError) return mergeAlreadyLanded(node, run, err);
        throw err;
      }
      const md = node.metadata;
      // the claims land before the conversions, so each credit is quoted at its
      // balance plus what this close claims into it
      const claimedIn = (audit: AccountAudit): string[] =>
        planClaimableBalances(audit, md.claimableBalanceIds, {
          feePerOpStroops: feeBase,
        }).claimed.map((c) => c.id);
      const quote = (audit: AccountAudit, claimedBalanceIds: readonly string[]) =>
        withHorizonRetry(() => resolveCreditPaths(audit, deps.network, { claimedBalanceIds }));
      const assertCreditsRoutable = (
        audit: AccountAudit,
        paths: ReadonlyMap<string, PathResultRef>,
      ): void => {
        const stuck = unroutableCredits(
          audit,
          paths,
          md.returnToIssuerAssetKeys,
          md.sendToDestinationAssetKeys,
          {
            ...(md.claimableBalanceIds !== undefined
              ? { claimableBalanceIds: md.claimableBalanceIds }
              : {}),
            ...(md.acceptedPriceImpactAssetKeys
              ? { acceptedPriceImpactAssetKeys: md.acceptedPriceImpactAssetKeys }
              : {}),
            ...(md.reviewedReferenceQuotes
              ? { reviewedReferenceQuotes: md.reviewedReferenceQuotes }
              : {}),
            ...(md.reviewedConversionQuotes
              ? { reviewedConversionQuotes: md.reviewedConversionQuotes }
              : {}),
            feePerOpStroops: feeBase,
          },
        );
        if (stuck.length > 0) throw creditsBlocked(stuck);
      };
      const quotedClaims = claimedIn(freshAudit);
      let freshPaths = await quote(freshAudit, quotedClaims);

      // the classic audit can't see soroban positions; rediscover them and
      // refuse while any is open or unreadable
      if (deps.reprobeSorobanPositions) {
        const remaining = await deps.reprobeSorobanPositions(publicKey, deps.network);
        const open = openPositionCount(remaining);
        if (open > 0) {
          // a queued backstop deposit still blocks: the account must survive the
          // queue to receive the withdrawal
          throw new Error(
            `account_merge blocked: ${open} Soroban DeFi position(s) still open ` +
              `(blend=${remaining.blend.length}, backstop=${remaining.backstop.length}, ` +
              `aquarius=${remaining.aquarius.length}, ` +
              `aquarius concentrated=${remaining.aquariusConcentrated.length}, ` +
              `soroswap=${remaining.soroswap.length}). Close them before merging, or the funds ` +
              `will be stranded on the deleted account.`,
          );
        }
        // an empty protocol list with a recorded error means "could not
        // confirm", not "nothing there"
        if (remaining.errors.length > 0) {
          const detail = remaining.errors.map((e) => `${e.protocol}: ${e.message}`).join("; ");
          throw new CloseFailure(
            "network",
            `account_merge blocked: could not confirm your DeFi positions are all closed ` +
              `(${detail}). This is a safety stop so an unreadable position isn't merged ` +
              `around and stranded. Retry once the network is responsive.`,
          );
        }
      }

      assertCreditsRoutable(freshAudit, freshPaths);
      await assertResidueDeliverable(freshAudit, freshPaths, node, deps.horizon);

      // the network clock this batch's time bounds and claims are judged by, read
      // after the slow path and position reads above. a claim that would not stay
      // claimable for the whole signing window is left out of the batch.
      const clock = await readLedgerClock(deps.horizon);
      const auditNow = withClaimWindow(freshAudit, publicKey, clock);
      // a claim the signing window leaves out is not sold either, so the batch is
      // quoted again for what it really holds
      const claimedNow = claimedIn(auditNow);
      if (claimedNow.join(",") !== quotedClaims.join(",")) {
        freshPaths = await quote(auditNow, claimedNow);
        assertCreditsRoutable(auditNow, freshPaths);
      }

      const mediatorFunded = mediator ? await mediator.probe() : false;
      // the options the plan was reviewed with, plus what only execute time
      // knows: the mediator in use, whether it is funded, and the fee bid the
      // batcher's reserve checks (close marker, new trustlines) must cover
      const rebatch = () => {
        const mediatorPublicKey = mediator?.mediatorPublicKey();
        return batchClassicDemolition(
          auditNow,
          finalBatchOptions(md, {
            ...(mediatorPublicKey ? { mediatorPublicKey } : {}),
            mediatorAlreadyFunded: mediatorFunded,
            feePerOpStroops: feeBase,
          }),
          freshPaths,
        );
      };
      let freshBatches = rebatch();
      if (freshBatches.length === 0) {
        throw new Error(`executing: node "${node.id}" produced no fresh batches`);
      }
      const isFinal = freshBatches.length === 1;

      // execute-time re-check against what this close really claims and how many
      // transactions it still sources before the merge: preview passed, but the
      // world may have moved. these run before a flow is minted, so a close that
      // can't merge leaves no recovery record behind.
      const merge = assessMergeability(auditNow, {
        ledger: clock,
        // the claims the batch makes, judged at the fee it is bid at
        claimedBalanceIds: claimedNow,
        transactionsBeforeMerge: freshBatches.length,
      });
      if (!merge.mergeable) {
        throw new CloseFailure(
          "not_mergeable",
          `account_merge blocked: ${merge.reason}: ${merge.detail}`,
        );
      }

      // the funding op fails op_underfunded when the account can't spare the
      // mediator's starting balance; refuse before signing instead
      if (fundsMediator(freshBatches[0]!)) {
        const funding = mediatorFundingCheck(auditNow, [freshBatches[0]!], feeBase);
        if (funding !== null && !funding.sufficient) {
          throw new CloseFailure(
            "not_mergeable",
            "account_merge blocked: not enough XLM to fund the exchange forward. The temporary " +
              `account needs ${stroopsToDecimal(funding.requiredStroops)} XLM and this account can spare ` +
              `about ${stroopsToDecimal(funding.availableStroops < 0n ? 0n : funding.availableStroops)} XLM ` +
              "at that point. Add XLM and retry.",
          );
        }
      }

      // tokens the defi exits paid out that are not classic balances are swept
      // before the merge; one still held here would be deleted with the account
      if (isFinal) await assertExitPayoutsSwept(run, auditNow, node);

      if (
        mediator !== null &&
        !mediatorFunded &&
        fundsMediator(freshBatches[0]!) &&
        (await mediator.prepareFunding())
      ) {
        freshBatches = rebatch();
      }
      const batch = freshBatches[0]!;

      // the batcher never puts two conversions over one market in a batch, so a
      // missed floor means the market pays less than Horizon quotes for it. a
      // rebuild that quotes exactly what just failed would fail the same way.
      const quotes = quoteSignature(batch, freshPaths);
      if (refusedQuotes !== null && quotes === refusedQuotes) {
        throw new CloseFailure(
          "not_mergeable",
          "Converting these balances to XLM failed twice against the same market quotes: the " +
            "market pays less than its quote, so the sale misses the 1% limit. Nothing in that " +
            "transaction was sold. Convert them yourself, or return them to their issuer, then " +
            "rebuild the plan.",
        );
      }

      let sourceAccount: Awaited<ReturnType<HorizonLike["loadAccount"]>>;
      try {
        sourceAccount = await withHorizonRetry(() => deps.horizon.loadAccount(publicKey));
      } catch (err) {
        // gone since the audit: an earlier submit of this close may have landed
        if (isNotFound(err)) return mergeAlreadyLanded(node, run, err);
        throw err;
      }
      const fee = capFeeToBalance(feeBase, batch.operations.length, freshAudit, baseReserve);
      const built = buildClassicTransaction(
        batch,
        sourceAccount,
        deps.network,
        fee,
        DEFAULT_TX_VALIDITY_SECONDS,
        clock.closedAt,
      ).transaction;
      if ("innerTransaction" in built) {
        throw new Error("buildClassicTransaction returned a fee-bump transaction unexpectedly");
      }
      const signed = await signWith(deps, built, `"${node.description}"`);
      node.status = "signed";
      run.notify(node);
      lastQuotes = quotes;
      journal.pending = {
        hash: hashHex(built),
        maxTime: maxTimeOf(built),
        final: isFinal,
      };
      let receipt: ConfirmationReceipt;
      try {
        receipt = await deps.submitClassic(signed.signedXdr);
      } catch (err) {
        if (!(err instanceof AmbiguousSubmitError)) journal.pending = null;
        throw err;
      }
      journal.pending = null;
      journal.landedPhases.push(receipt);
      node.status = "submitted";
      run.notify(node);
      if (isFinal) return receipt;
    }
    // the phase budget ran out before the merge batch: not a success
    throw new Error(
      `executing: node "${node.id}" did not converge within ${MAX_CLOSE_PHASES} phases`,
    );
  };

  let feeBase = await surgeFeeBase(deps.horizon);
  let refusedQuotes: string | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptMerge(feeBase, refusedQuotes);
    } catch (err) {
      const kind = classicRejectionKind(err);
      if (kind === null || attempt === MAX_MERGE_ATTEMPTS) throw err;
      refusedQuotes = null;
      switch (kind) {
        case "fee":
          feeBase = Math.min(feeBase * 3, MAX_PER_OP_FEE);
          break;
        case "fee_too_high":
          if (feeBase <= DEFAULT_FEE_BASE) throw err;
          feeBase = DEFAULT_FEE_BASE;
          break;
        case "price":
          refusedQuotes = lastQuotes;
          break;
        case "resequence":
        case "expired":
        case "drift":
          // the next attempt reloads the account and re-audits from fresh state
          break;
      }
    }
  }
}

// the classic phase ahead of the repays: cancels the offers selling a repay
// asset and withdraws the classic pool shares holding one, so the repay's SAC
// transfer can spend it. each batch is planned from a fresh audit and the
// account is re-audited after it lands; a batch that landed is never resent.
// returns the last landed batch, or null when nothing was left to unwind.
async function runClassicUnwind(
  node: ClassicUnwindNode,
  run: Run,
): Promise<ConfirmationReceipt | null> {
  const { deps, publicKey } = run;
  const journal = journalFor(node);
  const landed = await settlePending(journal, deps.lookupClassicTransaction, node.description);
  if (landed !== null) journal.landedPhases.push(landed);

  const baseReserve = await readBaseReserve(deps.horizon);
  let feeBase = await surgeFeeBase(deps.horizon);
  let rejections = 0;
  for (let phase = 0; phase < MAX_CLOSE_PHASES; phase++) {
    throwIfInterrupted(deps.signal);
    let audit: AccountAuditResult;
    try {
      audit = await withHorizonRetry(() => auditAccount(publicKey, deps.network));
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        throw new CloseFailure(
          "not_mergeable",
          "The account no longer exists on the network, so its offers and pools can't be unwound.",
          { cause: err },
        );
      }
      throw err;
    }
    // only the offers and pools the review listed; one gone since is skipped,
    // and anything new is left for the user to see in a rebuilt plan
    const batch = buildClassicUnwindBatches(audit, node.metadata)[0];
    if (batch === undefined) return journal.landedPhases.at(-1) ?? null;

    const clock = await readLedgerClock(deps.horizon);
    const sourceAccount = await withHorizonRetry(() => deps.horizon.loadAccount(publicKey));
    const fee = capFeeToBalance(feeBase, batch.operations.length, audit, baseReserve);
    const built = buildClassicTransaction(
      batch,
      sourceAccount,
      deps.network,
      fee,
      DEFAULT_TX_VALIDITY_SECONDS,
      clock.closedAt,
    ).transaction;
    if ("innerTransaction" in built) {
      throw new Error("buildClassicTransaction returned a fee-bump transaction unexpectedly");
    }
    const signed = await signWith(deps, built, `"${node.description}"`);
    node.status = "signed";
    run.notify(node);
    journal.pending = { hash: hashHex(built), maxTime: maxTimeOf(built) };
    try {
      const receipt = await deps.submitClassic(signed.signedXdr);
      journal.pending = null;
      journal.landedPhases.push(receipt);
      node.status = "submitted";
      run.notify(node);
    } catch (err) {
      if (!(err instanceof AmbiguousSubmitError)) journal.pending = null;
      const kind = classicRejectionKind(err);
      rejections += 1;
      if (kind === null || rejections >= MAX_MERGE_ATTEMPTS) throw err;
      if (kind === "fee") feeBase = Math.min(feeBase * 3, MAX_PER_OP_FEE);
      if (kind === "fee_too_high") {
        if (feeBase <= DEFAULT_FEE_BASE) throw err;
        feeBase = DEFAULT_FEE_BASE;
      }
      // every other rejection is cleared by planning again from a fresh audit
    }
  }
  throw new Error(
    `executing: node "${node.id}" did not converge within ${MAX_CLOSE_PHASES} phases`,
  );
}

// the account is gone. if a merge from it landed into the account this close
// merges into (its reply was lost), the merge is done; anything else is a real
// "nothing left to merge".
async function mergeAlreadyLanded(
  node: FinalClassicTxNode,
  run: Run,
  cause: unknown,
): Promise<ConfirmationReceipt> {
  const target = node.metadata.useMediator
    ? run.tree.allNodes.get(MEDIATOR_FORWARD_NODE_ID)?.metadata
    : undefined;
  const expected =
    target !== undefined && "mediatorPublicKey" in target
      ? target.mediatorPublicKey
      : node.metadata.destination;
  const landed = run.deps.findAccountMerge ? await run.deps.findAccountMerge(run.publicKey) : null;
  if (landed !== null && landed.into === expected) {
    return { txHash: landed.txHash, ledger: landed.ledger };
  }
  throw new CloseFailure(
    "not_mergeable",
    landed !== null
      ? `The account was already merged into ${shortAddress(landed.into, 4, 4)} by transaction ${landed.txHash}, ` +
          "not by this close."
      : "The account no longer exists on the network, so there is nothing left to merge.",
    { cause },
  );
}

function quoteSignature(
  batch: ClassicBatch,
  paths: ReadonlyMap<string, PathResultRef>,
): string | null {
  const parts: string[] = [];
  for (const op of batch.operations) {
    if (op.kind !== "path_payment_strict_send") continue;
    const asset = op.metadata.sendAsset as Parameters<typeof pathKey>[0];
    const key = pathKey(asset);
    parts.push(`${key}=${paths.get(key)?.destinationAmount ?? "?"}`);
  }
  return parts.length === 0 ? null : parts.sort().join("|");
}

// a horizon that serves no ledgers can't time a batch or size its fee, and the
// browser's clock must not stand in for the network's
async function latestLedgerPage(horizon: HorizonLike) {
  if (typeof horizon.ledgers !== "function") {
    throw new Error("Horizon serves no latest ledger, so the close can't be timed safely");
  }
  return withHorizonRetry(() => horizon.ledgers().order("desc").limit(1).call());
}

// the latest closed ledger from the executor's horizon
async function readLedgerClock(horizon: HorizonLike): Promise<LedgerClock> {
  const page = await latestLedgerPage(horizon);
  const record = page.records[0];
  const ms = Date.parse(String(record?.closed_at));
  const sequence = record?.sequence;
  if (record === undefined || !Number.isFinite(ms) || !Number.isSafeInteger(sequence)) {
    throw new Error("Horizon's latest ledger is unreadable, so the merge can't be timed safely");
  }
  return { sequence: sequence as number, closedAt: Math.floor(ms / 1000) };
}

// the audit with every claimable balance that would not stay claimable for the
// whole signing window marked not claimable, so the batch leaves it out
function withClaimWindow(
  audit: AccountAuditResult,
  publicKey: string,
  clock: LedgerClock,
): AccountAuditResult {
  const open = new Set(
    filterClaimableNow(
      audit.claimableBalances,
      publicKey,
      new Date(clock.closedAt * 1000),
      DEFAULT_TX_VALIDITY_SECONDS,
    ).map((cb) => cb.id),
  );
  return {
    ...audit,
    claimableBalances: audit.claimableBalances.map((cb) =>
      open.has(cb.id) ? cb : { ...cb, claimableNow: false },
    ),
  };
}

// a conversion the batcher refuses at execute time: the market moved past what
// the user reviewed, or over the price-impact cap. the close stops before
// signing and the rebuilt plan asks per token.
function creditsBlocked(stuck: readonly UnroutableCredit[]): CloseFailure {
  const reasons = stuck.map((c) => `${c.code}: ${blockReason(c)}`).join("; ");
  const priced = stuck.some((c) => c.reason !== "no_path");
  return new CloseFailure(
    priced ? "conversion_refused" : "not_mergeable",
    `account_merge blocked: ${stuck.length} credit balance(s) can't be disposed of as reviewed ` +
      `(${reasons}). Nothing was signed. Rebuild the plan to choose for each one: sell at the ` +
      "new price, send it to your destination as-is, or return it to its issuer.",
  );
}

function blockReason(c: UnroutableCredit): string {
  switch (c.reason) {
    case "no_path":
      return "no market path to XLM";
    case "unpriced":
      return "the price could not be checked against a reference quote";
    case "price_impact":
      return `selling it all would move the price by ${((c.priceImpactBps ?? 0) / 100).toFixed(2)}%`;
    case "requote_worse":
      return "the market price fell below the one you reviewed";
  }
}

// the payout of a classic asset's SAC is a classic balance the batches already
// handle. that covers the assets the account holds now and every asset the
// reviewed batches touch: an earlier phase of a long close may have removed a
// payout asset's trustline, and its SAC then traps on balance() (contract
// error #13) instead of reading zero, which would wedge the merge.
async function assertExitPayoutsSwept(
  run: Run,
  audit: AccountAudit,
  final: FinalClassicTxNode,
): Promise<void> {
  const passphrase = run.deps.network.passphrase;
  const classic = new Set([Asset.native().contractId(passphrase)]);
  const addCredit = (asset: unknown): void => {
    const a = asset as { kind?: unknown; code?: unknown; issuer?: unknown } | null;
    if (a?.kind === "credit" && typeof a.code === "string" && typeof a.issuer === "string") {
      classic.add(new Asset(a.code, a.issuer).contractId(passphrase));
    }
  };
  for (const b of audit.balances) addCredit(b.asset);
  for (const batch of final.metadata.batches) {
    for (const op of batch.operations) {
      addCredit(op.metadata.asset);
      addCredit(op.metadata.sendAsset);
    }
  }
  const tokens = planExitPayoutTokens(run.tree).filter((id) => !classic.has(id));
  if (tokens.length === 0) return;
  const read = run.deps.readTokenBalance;
  if (read === undefined) {
    throw new CloseFailure(
      "not_mergeable",
      "account_merge blocked: this close can't read the tokens its DeFi exits paid out, so it " +
        "can't confirm none is left on the account.",
    );
  }
  for (const id of tokens) {
    let held: bigint;
    try {
      held = await read(id, run.publicKey);
    } catch (err) {
      throw new CloseFailure(
        "network",
        `account_merge blocked: could not read the balance of token ${shortAddress(id, 4, 4)} paid out by ` +
          `your DeFi exits (${errorMessage(err)}). Retry once the network is responsive.`,
        { cause: err },
      );
    }
    if (held > 0n) {
      throw new CloseFailure(
        "not_mergeable",
        `account_merge blocked: token ${shortAddress(id, 4, 4)} paid out by your DeFi exits is still on the ` +
          "account. Merging now would delete it with the account.",
      );
    }
  }
}

// a residue the user chose to send to the destination must still be receivable
// there: the line can be removed, deauthorized or filled after the preview
async function assertResidueDeliverable(
  audit: AccountAudit,
  paths: ReadonlyMap<string, PathResultRef>,
  node: FinalClassicTxNode,
  horizon: HorizonLike,
): Promise<void> {
  const chosen = new Set(node.metadata.sendToDestinationAssetKeys ?? []);
  if (chosen.size === 0) return;
  const residues = audit.balances.filter((b) => {
    if (b.asset.kind !== "credit") return false;
    const key = pathKey(b.asset);
    return chosen.has(key) && !paths.has(key) && toStroops(b.amount) > 0n;
  });
  if (residues.length === 0) return;
  const destination = node.metadata.destination;
  let lines: readonly DestinationLine[] = [];
  try {
    const account = await withHorizonRetry(() => horizon.loadAccount(destination));
    lines = account.balances as readonly DestinationLine[];
  } catch (err) {
    if (!(isNotFound(err) || err instanceof AccountNotFoundError)) throw err;
  }
  for (const r of residues) {
    if (r.asset.kind !== "credit") continue;
    const problem = residueLineProblem(destination, lines, pathKey(r.asset), r.amount);
    if (problem !== null) {
      throw new CloseFailure(
        "not_mergeable",
        `Your destination can no longer receive ${r.amount} ${r.asset.code}: ${problem}. ` +
          "Choose another way to handle that balance and rebuild the plan.",
      );
    }
  }
}

async function runForward(node: MediatorForwardNode, run: Run): Promise<void> {
  const { deps } = run;
  const md = node.metadata;
  const control = deps.mediatorFlow;

  // the forward's own merge removes the mediator, so a mediator that is gone
  // after the merge into it landed means a forward already ran (its reply may
  // have been lost); find it instead of failing on a missing account
  if (!(await accountExists(deps.horizon, md.mediatorPublicKey))) {
    const delivered = control?.findForward
      ? await control.findForward(md.mediatorPublicKey, md.ultimateDestination)
      : null;
    if (delivered === null) {
      node.status = "failed";
      node.error =
        `The temporary account ${shortAddress(md.mediatorPublicKey, 4, 4)} no longer exists and no forward ` +
        "out of it was found.";
      run.notify(node);
      throw new CloseFailure("unknown", node.error);
    }
    confirm(node, delivered, run);
    control?.forwarded(md.mediatorPublicKey);
    return;
  }

  // a token of unknown age, or one close to expiry, is renewed first when the
  // deployment offers renewal; otherwise the server is the judge of it
  const issued = journalFor(node);
  const now = deps.now ?? Date.now;
  const remaining =
    issued.flowIssuedAt === null
      ? Number.NEGATIVE_INFINITY
      : issued.flowIssuedAt + MEDIATOR_FLOW_TTL_MS - now();
  if (control?.reissue && remaining < FORWARD_TOKEN_MARGIN_MS) {
    const requestedAt = now();
    const fresh = await control.reissue(md.flowToken);
    applyRefreshedMediatorFlow(run.tree, {
      mediatorPublicKey: md.mediatorPublicKey,
      flowToken: fresh.flowToken,
    });
    issued.flowIssuedAt = requestedAt;
    control.persist({
      mediatorPublicKey: md.mediatorPublicKey,
      flowToken: fresh.flowToken,
      ultimateDestination: md.ultimateDestination,
      ...(md.memo ? { memo: md.memo } : {}),
      issuedAt: requestedAt,
    });
  }

  node.status = "signed";
  run.notify(node);
  // before any renewal the forward may make, so a renewed token's age is never
  // understated
  const startedAt = now();
  const result = await submitMediatorForward({
    mediatorPublicKey: md.mediatorPublicKey,
    flowToken: node.metadata.flowToken,
    destination: md.ultimateDestination,
    network: deps.network,
    // only a merge from this account counts as the one the forward waits for
    closedAccount: run.publicKey,
    // the full memo reaches the exchange on this hop
    ...(md.memo ? { memo: md.memo } : {}),
  });
  if (result.flowToken !== md.flowToken) {
    // the forward renewed an expired token; keep the new one for a retry
    applyRefreshedMediatorFlow(run.tree, {
      mediatorPublicKey: md.mediatorPublicKey,
      flowToken: result.flowToken,
    });
    if (!result.ok) {
      control?.persist({
        mediatorPublicKey: md.mediatorPublicKey,
        flowToken: result.flowToken,
        ultimateDestination: md.ultimateDestination,
        ...(md.memo ? { memo: md.memo } : {}),
        issuedAt: startedAt,
      });
    }
  }
  if (!result.ok) {
    node.status = "failed";
    node.error = result.error;
    run.notify(node);
    throw new CloseFailure(
      "forward_pending",
      `Your account was merged into the temporary exchange-forward account ` +
        `${shortAddress(md.mediatorPublicKey, 4, 4)}, but the forward to the exchange did not finish: ` +
        `${result.error}. Retry resumes the forward.`,
    );
  }
  confirm(node, { txHash: result.txHash, ledger: result.ledger }, run);
  control?.forwarded(md.mediatorPublicKey);
}
