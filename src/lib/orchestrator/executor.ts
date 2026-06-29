// shared on-chain executor: walks a hydrated plan tree in topological order and
// signs + submits each node. Used by the page-flow machine's execution actor.

import { BASE_FEE, type Horizon } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import type { Connector } from "@/lib/wallet/connector";
import {
  auditAccount,
  AccountNotFoundError,
  computeMergeability,
} from "@/lib/stellar/account-audit";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { batchClassicDemolition, unroutableCredits } from "@/lib/plan/classic-batcher";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { submitMediatorForward } from "@/lib/mediator/forward";
import { isSorobanNode, topologicalOrder, type PlanNode, type PlanTree } from "@/lib/plan/tree";

export interface ConfirmationReceipt {
  readonly txHash: string;
  readonly ledger: number;
}

// narrow subset of horizon.server the executor touches. feeStats is optional so
// tests can supply a minimal double; when present it drives surge-aware fees.
export type HorizonLike = Pick<Horizon.Server, "loadAccount"> & {
  readonly feeStats?: Horizon.Server["feeStats"];
};

export interface ExecutorDeps {
  readonly network: NetworkConfig;
  readonly connector: Connector;
  readonly horizon: HorizonLike;
  readonly submitClassic: (signedXdr: string) => Promise<ConfirmationReceipt>;
  readonly submitSoroban: (signedXdr: string) => Promise<ConfirmationReceipt>;
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

// rides out transient horizon blips (5xx / network) on the pure, idempotent
// reads that prep the final merge, so a momentary outage doesn't abort execution
// after the soroban exits have already confirmed on-chain. Deterministic outcomes
// (404 AccountNotFound, other 4xx) are rethrown immediately — never retried.
async function withHorizonRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // a merged/missing account is a real, terminal answer — don't retry it
      if (err instanceof AccountNotFoundError) throw err;
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== undefined && status < 500) throw err;
      if (i === tries - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** i));
    }
  }
  throw lastErr;
}

const DEFAULT_FEE_BASE = Number.parseInt(BASE_FEE, 10); // 100 stroops/op network minimum
// generous per-op ceiling for surge bidding (0.1 XLM/op); the u32 total-fee guard
// in buildClassicTransaction is the hard limit
const MAX_PER_OP_FEE = 1_000_000;
const MAX_MERGE_ATTEMPTS = 3;

// classify a classic submit rejection to decide whether a rebuild-and-retry can
// help. Horizon surfaces result codes in the thrown message (see submitClassic).
// "fee": bid too low for current congestion -> retry with a higher fee.
// "reprice": a path-payment/offer floor missed because the market moved between
//   quote and submit -> retry, which re-resolves paths and recomputes destMin.
// null: deterministic (bad seq, no trust, etc.) -> never retry.
function classicRejectionKind(err: unknown): "fee" | "reprice" | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("tx_insufficient_fee")) return "fee";
  if (
    msg.includes("op_under_dest_min") ||
    msg.includes("op_too_few_offers") ||
    msg.includes("op_over_source_max") ||
    msg.includes("tx_too_late")
  ) {
    return "reprice";
  }
  return null;
}

// a competitive starting per-op fee from Horizon's recent fee stats, clamped to
// [network minimum, MAX_PER_OP_FEE]. Falls back to the minimum if feeStats is
// unavailable or malformed — the retry loop escalates from there on a fee reject.
async function surgeFeeBase(horizon: HorizonLike): Promise<number> {
  if (typeof horizon.feeStats !== "function") return DEFAULT_FEE_BASE;
  try {
    const stats = await horizon.feeStats();
    const p90 = Number.parseInt(stats.max_fee?.p90 ?? "", 10);
    if (!Number.isFinite(p90) || p90 <= 0) return DEFAULT_FEE_BASE;
    return Math.min(Math.max(DEFAULT_FEE_BASE, p90), MAX_PER_OP_FEE);
  } catch {
    return DEFAULT_FEE_BASE;
  }
}

export async function executePlanTreeOnChain(
  input: {
    publicKey: string;
    tree: PlanTree;
    previousReceipts: Record<string, ConfirmationReceipt>;
    // fires after every node.status mutation so the ui can re-render
    onNodeUpdate?: (node: PlanNode) => void;
  },
  deps: ExecutorDeps,
): Promise<ExecutionOutput> {
  const receipts: Record<string, ConfirmationReceipt> = { ...input.previousReceipts };
  const ordered = topologicalOrder(input.tree);
  const notify = (node: PlanNode): void => {
    try {
      input.onNodeUpdate?.(node);
    } catch {
      // notifications must never abort execution
    }
  };

  for (const node of ordered) {
    if (receipts[node.id] !== undefined) {
      const prior = receipts[node.id]!;
      node.status = "confirmed";
      node.executed = { txHash: prior.txHash, ledger: prior.ledger };
      notify(node);
      continue;
    }
    if (node.executed !== undefined) {
      node.status = "confirmed";
      receipts[node.id] = { txHash: node.executed.txHash, ledger: node.executed.ledger };
      notify(node);
      continue;
    }
    if (node.status === "skipped" || node.status === "failed") continue;

    // cascade-skip: never run a node whose dependency didn't complete.
    // topologicalOrder guarantees deps are terminal (confirmed/skipped/failed)
    // by the time we reach a dependent, so a FAILED DeFi exit correctly blocks
    // the FinalClassicTx merge instead of merging around a still-open position.
    // A deliberately-skipped dep is acceptable (the fresh-state merge guard below
    // re-audits and refuses if anything material remains).
    const blockingDep = node.dependencies.find((depId) => {
      const dep = input.tree.allNodes.get(depId);
      return !dep || (dep.status !== "confirmed" && dep.status !== "skipped");
    });
    if (blockingDep !== undefined) {
      node.status = "skipped";
      node.error = `Skipped: dependency "${blockingDep}" did not complete.`;
      notify(node);
      continue;
    }

    try {
      await deps.horizon.loadAccount(input.publicKey);
    } catch {
      // transient horizon 5xx — continue; submit will surface a real failure
    }

    if (node.kind === "FinalClassicTx") {
      // one attempt: re-audit fresh state, re-check mergeability, rebuild the
      // batches (with freshly-resolved XLM paths + destMins), and submit them at
      // the given per-op fee. Returns the final receipt. Re-running this after a
      // batch confirms is SAFE: a fresh audit reflects the applied ops, so a
      // retry rebuilds only the REMAINING work — never re-submitting a confirmed
      // batch. That's what lets the bounded retry below recover from a fee/price
      // rejection without leaving the account half-closed.
      const attemptMerge = async (feeBase: number): Promise<ConfirmationReceipt> => {
        // soroban exits shift classical balances, so the cached batches are
        // rebuilt against fresh state — including freshly-resolved XLM paths so
        // credit balances convert via path payment instead of routing to issuer.
        const freshAudit = await withHorizonRetry(() =>
          auditAccount(input.publicKey, deps.network),
        );
        const freshPaths = await withHorizonRetry(() =>
          resolveCreditPaths(freshAudit, deps.network),
        );

        // execute-time re-check against fresh state: preview passed, but the world
        // may have diverged (a DeFi exit failed, a credit lost its XLM path). Refuse
        // to build/sign a doomed or fund-losing merge rather than committing part of
        // a multi-batch close and leaving the account wedged.
        const merge = computeMergeability(freshAudit.flags, freshAudit.sponsorship);
        if (!merge.mergeable) {
          throw new Error(
            `account_merge blocked: ${merge.reason}${merge.detail ? ` — ${merge.detail}` : ""}`,
          );
        }
        const stuck = unroutableCredits(
          freshAudit,
          freshPaths,
          node.metadata.returnToIssuerAssetKeys,
        );
        if (stuck.length > 0) {
          throw new Error(
            `account_merge blocked: ${stuck.length} credit balance(s) have no XLM path and no ` +
              `return-to-issuer consent (${stuck.map((c) => c.code).join(", ")})`,
          );
        }

        const freshBatches = batchClassicDemolition(
          freshAudit,
          {
            destination: node.metadata.destination,
            useMediator: node.metadata.useMediator,
            ...(node.metadata.claimableBalanceIds
              ? { claimableBalanceIds: node.metadata.claimableBalanceIds }
              : {}),
            ...(node.metadata.returnToIssuerAssetKeys
              ? { returnToIssuerAssetKeys: node.metadata.returnToIssuerAssetKeys }
              : {}),
            ...(node.metadata.userFallbackAddress
              ? { userFallbackAddress: node.metadata.userFallbackAddress }
              : {}),
            ...(node.metadata.mediatorPublicKey
              ? { mediatorPublicKey: node.metadata.mediatorPublicKey }
              : {}),
          },
          freshPaths,
        );
        if (freshBatches.length === 0) {
          throw new Error(`executing: node "${node.id}" produced no fresh batches`);
        }
        let receipt: ConfirmationReceipt | null = null;
        for (let i = 0; i < freshBatches.length; i++) {
          const sourceAccount = await withHorizonRetry(() =>
            deps.horizon.loadAccount(input.publicKey),
          );
          const built = buildClassicTransaction(
            freshBatches[i]!,
            sourceAccount,
            deps.network,
            feeBase,
          );
          const signed = await deps.connector.signTransaction(
            built.transaction,
            deps.network.passphrase,
          );
          node.status = "signed";
          notify(node);
          receipt = await deps.submitClassic(signed.signedXdr);
          node.status = "submitted";
          node.executed = { txHash: receipt.txHash, ledger: receipt.ledger };
          notify(node);
        }
        if (receipt === null) {
          throw new Error(`executing: node "${node.id}" produced no receipt`);
        }
        return receipt;
      };

      // bounded retry: recover from congestion (bid a higher fee) or a
      // path/offer floor missed because the market moved between quote and submit
      // (rebuild re-resolves paths + destMin). Deterministic rejections never retry.
      let feeBase = await surgeFeeBase(deps.horizon);
      let lastReceipt: ConfirmationReceipt | null = null;
      for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
        try {
          lastReceipt = await attemptMerge(feeBase);
          break;
        } catch (err) {
          const kind = classicRejectionKind(err);
          if (kind === null || attempt === MAX_MERGE_ATTEMPTS) throw err;
          if (kind === "fee") feeBase = Math.min(feeBase * 3, MAX_PER_OP_FEE);
          // "reprice": next attemptMerge re-resolves paths and recomputes destMin
        }
      }
      if (lastReceipt === null) {
        throw new Error(`executing: node "${node.id}" produced no receipt`);
      }
      node.status = "confirmed";
      node.executed = { txHash: lastReceipt.txHash, ledger: lastReceipt.ledger };
      receipts[node.id] = lastReceipt;
      notify(node);
      continue;
    }

    if (node.kind === "MediatorForward") {
      const forwardInput: Parameters<typeof submitMediatorForward>[0] = {
        mediatorPublicKey: node.metadata.mediatorPublicKey,
        flowToken: node.metadata.flowToken,
        destination: node.metadata.ultimateDestination,
        network: deps.network,
        ...(node.metadata.memo
          ? { memo: { type: "text" as const, value: node.metadata.memo } }
          : {}),
      };
      node.status = "signed";
      notify(node);
      const forwardResult = await submitMediatorForward(forwardInput);
      if (!forwardResult.ok) {
        node.status = "failed";
        node.error = forwardResult.error;
        notify(node);
        throw new Error(`MediatorForward failed: ${forwardResult.error}`);
      }
      node.status = "confirmed";
      node.executed = { txHash: forwardResult.txHash, ledger: 0 };
      receipts[node.id] = { txHash: forwardResult.txHash, ledger: 0 };
      notify(node);
      continue;
    }

    const tx = pickTransaction(node);
    if (!tx) {
      throw new Error(`executing: node "${node.id}" (${node.kind}) has no transaction attached`);
    }
    // Pre-sign allow-list gate (defense-in-depth on top of each adapter's own
    // build-time check): every DeFi-protocol node must invoke only allow-listed
    // contracts. RevokeAllowance is the deliberate exception — it targets the
    // user's own token contracts (chosen from an RPC allowance scan, not the DeFi
    // allow-list) and only ever builds a safe approve(0) sourced from the user.
    if (node.kind !== "RevokeAllowance") {
      assertTransactionAllowed(tx, deps.network);
    }
    const signed = await deps.connector.signTransaction(tx, deps.network.passphrase);
    node.status = "signed";
    notify(node);

    const submit = isSorobanNode(node) ? deps.submitSoroban : deps.submitClassic;
    const receipt = await submit(signed.signedXdr);

    node.status = "confirmed";
    node.executed = { txHash: receipt.txHash, ledger: receipt.ledger };
    receipts[node.id] = receipt;
    notify(node);
  }

  return { receipts, tree: input.tree };
}
