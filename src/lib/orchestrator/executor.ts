// walks a hydrated plan tree in topological order and signs and submits each
// node. used by the page-flow machine's execute actor.

import { BASE_FEE, NotFoundError, type Horizon, type Transaction } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import type { Connector } from "@/lib/wallet/connector";
import {
  auditAccount,
  AccountNotFoundError,
  computeMergeability,
} from "@/lib/stellar/account-audit";
import { AllowlistViolation, assertTransactionAllowed } from "@/lib/stellar/allowlist";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { batchClassicDemolition, unroutableCredits } from "@/lib/plan/classic-batcher";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { submitMediatorForward } from "@/lib/mediator/forward";
import { applyRefreshedMediatorFlow, MEDIATOR_FORWARD_NODE_ID } from "@/lib/mediator/refresh";
import { resolveContractIdForAsset } from "@/lib/plan/hydration";
import { assertSafeTransferInvocation, UnsafeTransferError } from "@/lib/soroban/transfer-guard";
import { assertSafeRevokeInvocation, UnsafeRevokeError } from "@/lib/soroban/revoke-guard";
import { assertDefiAuthTree, UnsafeDefiAuthError } from "@/lib/soroban/defi-auth-guard";
import {
  isSorobanNode,
  topologicalOrder,
  type ConvertSorobanToXLMNode,
  type FinalClassicTxNode,
  type MediatorForwardNode,
  type PlanNode,
  type PlanTree,
  type TransferAsIsNode,
} from "@/lib/plan/tree";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { AccountAudit } from "@/lib/types/account";
import { pathKey, type ClassicBatch, type PathResultRef } from "@/lib/types/plan";
import { AmbiguousSubmitError, CloseFailure, rejectionCodes } from "@/lib/orchestrator/failures";
import { journalFor, type NodeJournal } from "@/lib/orchestrator/journal";
import { residueLineProblem, toStroops, type DestinationLine } from "@/lib/orchestrator/residue";

export interface ConfirmationReceipt {
  readonly txHash: string;
  readonly ledger: number;
}

// the horizon surface the executor reads. feeStats and ledgers are optional so
// test doubles can leave them out; production passes a Horizon.Server, so the
// surge bid and the spendable-balance fee cap are always on there.
export type HorizonLike = Pick<Horizon.Server, "loadAccount"> & {
  readonly feeStats?: Horizon.Server["feeStats"];
  readonly ledgers?: Horizon.Server["ledgers"];
};

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
  readonly memo?: { readonly type: "text" | "id" | "hash" | "return"; readonly value: string };
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
  // the hash of the forward that emptied this mediator, if one landed
  findForward?(mediatorPublicKey: string): Promise<string | null>;
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
  // aborting stops the close at the next step boundary, never mid-submit
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface ExecutionOutput {
  readonly receipts: Record<string, ConfirmationReceipt>;
  readonly tree: PlanTree;
}

// reads a node's pre-built transaction; undefined for classic-only kinds
export function pickTransaction(node: PlanNode) {
  switch (node.kind) {
    case "RevokeAllowance":
    case "RepayBlend":
    case "PayFxDAODebt":
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
    case "ConvertSorobanToXLM":
    case "TransferAsIs":
    case "BackstopQueue":
      return node.metadata.transaction;
    case "FinalClassicTx":
    case "MediatorForward":
      return undefined;
  }
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
const MAX_PER_OP_FEE = 1_000_000;
const MAX_MERGE_ATTEMPTS = 3;
// one batch per phase, re-audited in between, so a close needs
// ceil(totalOps / MAX_OPS_PER_TX) + 1 phases. the ~1000 subentry ceiling keeps
// that well under 30; more means the close is not converging.
const MAX_CLOSE_PHASES = 30;
const MAX_SOROBAN_ATTEMPTS = 3;

// fee ceiling for the guarded token transfer and allowance revoke. measured on
// mainnet 2026-10-02: a SAC transfer simulates at 24,201 stroops of resources, a
// custom-token transfer that creates a balance entry at 352,944, an approve(0)
// at 24,145, plus the 100,000 inclusion fee. 0.2 XLM leaves room for a costlier
// honest token and stops a hostile one from burning the user's XLM on resources.
const BEST_EFFORT_FEE_CEILING_STROOPS = 2_000_000n;

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
// a failed or malformed fee_stats read starts at the network minimum; the fee
// retry escalates from there.
async function surgeFeeBase(horizon: HorizonLike): Promise<number> {
  if (typeof horizon.feeStats !== "function") return DEFAULT_FEE_BASE;
  let p90: number;
  try {
    const stats = await horizon.feeStats();
    p90 = Number.parseInt(stats.fee_charged?.p90 ?? "", 10);
  } catch {
    return DEFAULT_FEE_BASE;
  }
  if (!Number.isFinite(p90) || p90 <= 0) return DEFAULT_FEE_BASE;
  return Math.min(Math.max(DEFAULT_FEE_BASE, p90), MAX_PER_OP_FEE);
}

async function readBaseReserve(horizon: HorizonLike): Promise<bigint | null> {
  const ledgers = horizon.ledgers;
  if (typeof ledgers !== "function") return null;
  const page = await withHorizonRetry(() => ledgers.call(horizon).order("desc").limit(1).call());
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
  baseReserve: bigint | null,
): number {
  if (baseReserve === null) return feeBase;
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
      `The account has ${formatXlm(available)} XLM it can spend, which does not cover the minimum ` +
        `network fee for the next ${opCount}-operation step. Add a little XLM and retry.`,
    );
  }
  return Number(perOp < BigInt(feeBase) ? perOp : BigInt(feeBase));
}

function formatXlm(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  return `${neg ? "-" : ""}${abs / 10_000_000n}.${(abs % 10_000_000n).toString().padStart(7, "0")}`;
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

function short(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
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
    // receipts of nodes confirmed outside this tree's own record; seeded as done
    previousReceipts?: Record<string, ConfirmationReceipt>;
    // fires after every node.status mutation so the ui can re-render
    onNodeUpdate?: (node: PlanNode) => void;
    // a best-effort step did not do what the plan asked, in words for the user
    onNote?: (text: string) => void;
  },
  deps: ExecutorDeps,
): Promise<ExecutionOutput> {
  const receipts: Record<string, ConfirmationReceipt> = { ...(input.previousReceipts ?? {}) };
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
    throwIfInterrupted(deps.signal);
    const prior = receipts[node.id];
    if (prior !== undefined) {
      node.status = "confirmed";
      node.executed = { txHash: prior.txHash, ledger: prior.ledger };
      run.notify(node);
      continue;
    }
    if (node.executed !== undefined) {
      node.status = "confirmed";
      receipts[node.id] = { txHash: node.executed.txHash, ledger: node.executed.ledger };
      run.notify(node);
      continue;
    }
    if (node.status === "skipped" || node.status === "failed") continue;

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
            feeCeiling: BEST_EFFORT_FEE_CEILING_STROOPS,
          });
          confirm(node, receipt, run);
        } catch (err) {
          if (err instanceof CloseFailure && err.kind === "interrupted") throw err;
          node.status = "skipped";
          node.error = `Allowance revoke skipped: ${errorMessage(err)}`;
          run.notify(node);
          run.note(
            `The allowance for spender ${short(md.spender)} on token ${short(md.contractId)} was not ` +
              `revoked (${errorMessage(err)}). Closing the account does not remove it: any balance of ` +
              "that token held at this address stays spendable by that spender.",
          );
        }
        continue;
      }
      default: {
        if (!isSorobanNode(node)) {
          throw new Error(`executing: node "${node.id}" (${node.kind}) is not a Soroban node`);
        }
        // a required defi exit: allow-listed contract and exactly the auth tree
        // its protocol call needs. a failure stops the close before the merge.
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
  return dep.status === "skipped" && BEST_EFFORT_KINDS.has(dep.kind) && !isDependencySkip(dep);
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
      feeCeiling: BEST_EFFORT_FEE_CEILING_STROOPS,
    });
    confirm(node, receipt, run);
  } catch (err) {
    if (err instanceof CloseFailure && err.kind === "interrupted") throw err;
    node.status = "skipped";
    node.error = `Token drain skipped: ${errorMessage(err)}`;
    run.notify(node);
    run.note(
      `Token ${tokenLabel(node.metadata.asset)} was not moved (${errorMessage(err)}); it stays on the closed account.`,
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
        feeCeiling: BEST_EFFORT_FEE_CEILING_STROOPS,
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
      return short(asset.contractId);
    case "credit":
      return asset.code;
    case "native":
      return "XLM";
    case "liquidity_pool_shares":
      return short(asset.poolId);
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
    readonly feeCeiling?: bigint;
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
      await deps.rebuildSorobanNode(node, run.publicKey);
    }
    const tx = pickTransaction(node);
    if (!tx) {
      throw new Error(`executing: node "${node.id}" (${node.kind}) has no transaction attached`);
    }
    // the checks run before signing and are not retried: an unsafe tree does not
    // become safe on a rebuild
    try {
      opts.guard?.(tx);
      if (opts.allowlist) {
        assertTransactionAllowed(tx, deps.network);
        assertDefiAuthTree(node, tx, { user: run.publicKey, network: deps.network });
      }
      if (opts.feeCeiling !== undefined && BigInt(tx.fee) > opts.feeCeiling) {
        throw new Error(
          `its fee is ${tx.fee} stroops, above the ${opts.feeCeiling.toString()} stroop limit for this step`,
        );
      }
    } catch (err) {
      const unsafe =
        err instanceof UnsafeDefiAuthError ||
        err instanceof UnsafeTransferError ||
        err instanceof UnsafeRevokeError ||
        err instanceof AllowlistViolation ||
        (err instanceof Error && err.message.startsWith("its fee is"));
      if (!unsafe) throw err;
      throw new CloseFailure(
        "unsafe",
        `Refused to sign "${node.description}": ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }
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
      `Could not confirm whether account ${short(id)} exists (${errorMessage(err)}); nothing was signed.`,
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
            `An earlier exchange close left funds in temporary account ${short(prev.mediatorPublicKey)}, ` +
              `bound to ${short(prev.ultimateDestination)}. Resume that forward before closing to a ` +
              "different destination.",
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
        `The authorization to forward from temporary account ${short(forward.metadata.mediatorPublicKey)} ` +
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
      let freshAudit: AccountAudit;
      try {
        freshAudit = await withHorizonRetry(() => auditAccount(publicKey, deps.network));
      } catch (err) {
        if (err instanceof AccountNotFoundError) return mergeAlreadyLanded(node, run, err);
        throw err;
      }
      const freshPaths = await withHorizonRetry(() => resolveCreditPaths(freshAudit, deps.network));

      // execute-time re-check: preview passed, but the world may have moved
      const merge = computeMergeability(freshAudit.flags, freshAudit.sponsorship);
      if (!merge.mergeable) {
        throw new Error(
          `account_merge blocked: ${merge.reason}${merge.detail ? `: ${merge.detail}` : ""}`,
        );
      }

      // the classic audit can't see soroban positions; rediscover them and
      // refuse while any is open or unreadable
      if (deps.reprobeSorobanPositions) {
        const remaining = await deps.reprobeSorobanPositions(publicKey, deps.network);
        const open =
          remaining.blend.length +
          remaining.backstop.length +
          remaining.aquarius.length +
          remaining.soroswap.length +
          remaining.fxdao.length;
        if (open > 0) {
          // a queued backstop deposit still blocks: the account must survive the
          // queue to receive the withdrawal
          throw new Error(
            `account_merge blocked: ${open} Soroban DeFi position(s) still open ` +
              `(blend=${remaining.blend.length}, backstop=${remaining.backstop.length}, ` +
              `aquarius=${remaining.aquarius.length}, soroswap=${remaining.soroswap.length}, ` +
              `fxdao=${remaining.fxdao.length}). Close them before merging, or the funds ` +
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

      const stuck = unroutableCredits(
        freshAudit,
        freshPaths,
        node.metadata.returnToIssuerAssetKeys,
        node.metadata.sendToDestinationAssetKeys,
      );
      if (stuck.length > 0) {
        throw new Error(
          `account_merge blocked: ${stuck.length} credit balance(s) have no XLM path and no ` +
            `return-to-issuer consent (${stuck.map((c) => c.code).join(", ")})`,
        );
      }
      await assertResidueDeliverable(freshAudit, freshPaths, node, deps.horizon);

      const mediatorFunded = mediator ? await mediator.probe() : false;
      const rebatch = () => {
        const mediatorPublicKey = mediator?.mediatorPublicKey();
        return batchClassicDemolition(
          freshAudit,
          {
            destination: node.metadata.destination,
            useMediator: node.metadata.useMediator,
            ...(mediatorFunded ? { mediatorAlreadyFunded: true } : {}),
            ...(node.metadata.claimableBalanceIds
              ? { claimableBalanceIds: node.metadata.claimableBalanceIds }
              : {}),
            ...(node.metadata.returnToIssuerAssetKeys
              ? { returnToIssuerAssetKeys: node.metadata.returnToIssuerAssetKeys }
              : {}),
            ...(node.metadata.sendToDestinationAssetKeys
              ? { sendToDestinationAssetKeys: node.metadata.sendToDestinationAssetKeys }
              : {}),
            ...(node.metadata.userFallbackAddress
              ? { userFallbackAddress: node.metadata.userFallbackAddress }
              : {}),
            ...(mediatorPublicKey ? { mediatorPublicKey } : {}),
            // the batcher puts the deposit memo only on a direct final merge; a
            // mediator close carries it on the forward instead
            ...(node.metadata.memo ? { memo: node.metadata.memo } : {}),
          },
          freshPaths,
        );
      };
      let freshBatches = rebatch();
      if (
        mediator !== null &&
        !mediatorFunded &&
        freshBatches[0] !== undefined &&
        fundsMediator(freshBatches[0]) &&
        (await mediator.prepareFunding())
      ) {
        freshBatches = rebatch();
      }
      if (freshBatches.length === 0) {
        throw new Error(`executing: node "${node.id}" produced no fresh batches`);
      }
      const batch = freshBatches[0]!;
      const isFinal = freshBatches.length === 1;

      // conversions in one batch are quoted one by one against the same book; if
      // they share a market, the later ones miss their floor. a rebuild that
      // quotes exactly what just failed would fail the same way.
      const quotes = quoteSignature(batch, freshPaths);
      if (refusedQuotes !== null && quotes === refusedQuotes) {
        throw new CloseFailure(
          "not_mergeable",
          "Converting these balances to XLM failed twice against the same market quotes. They " +
            "trade through a shared market, so selling them in one transaction moves its price past " +
            "the 1% limit. Nothing was sold. Convert some of them yourself, or return them to their " +
            "issuer, then rebuild the plan.",
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
      const built = buildClassicTransaction(batch, sourceAccount, deps.network, fee).transaction;
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
      ? `The account was already merged into ${short(landed.into)} by transaction ${landed.txHash}, ` +
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
  throwIfInterrupted(deps.signal);

  // the forward's own merge removes the mediator, so a mediator that is gone
  // after the merge into it landed means a forward already ran (its reply may
  // have been lost); find it instead of failing on a missing account
  if (!(await accountExists(deps.horizon, md.mediatorPublicKey))) {
    const hash = control?.findForward ? await control.findForward(md.mediatorPublicKey) : null;
    if (hash === null) {
      node.status = "failed";
      node.error =
        `The temporary account ${short(md.mediatorPublicKey)} no longer exists and no forward ` +
        "out of it was found.";
      run.notify(node);
      throw new CloseFailure("unknown", node.error);
    }
    confirm(node, { txHash: hash, ledger: 0 }, run);
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
  const result = await submitMediatorForward({
    mediatorPublicKey: md.mediatorPublicKey,
    flowToken: node.metadata.flowToken,
    destination: md.ultimateDestination,
    network: deps.network,
    // the full memo reaches the exchange on this hop
    ...(md.memo ? { memo: md.memo } : {}),
  });
  if (!result.ok) {
    node.status = "failed";
    node.error = result.error;
    run.notify(node);
    throw new CloseFailure(
      "forward_pending",
      `Your account was merged into the temporary exchange-forward account ` +
        `${short(md.mediatorPublicKey)}, but the forward to the exchange did not finish: ` +
        `${result.error}. Retry resumes the forward.`,
    );
  }
  confirm(node, { txHash: result.txHash, ledger: 0 }, run);
  control?.forwarded(md.mediatorPublicKey);
}
