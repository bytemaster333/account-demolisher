// shared on-chain executor: walks a hydrated plan tree in topological order and
// signs + submits each node. Used by the page-flow machine's execution actor.

import type { Horizon } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import type { Connector } from "@/lib/wallet/connector";
import { auditAccount, AccountNotFoundError } from "@/lib/stellar/account-audit";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { resolveCreditPaths } from "@/lib/stellar/path-finder";
import { submitMediatorForward } from "@/lib/mediator/forward";
import { isSorobanNode, topologicalOrder, type PlanNode, type PlanTree } from "@/lib/plan/tree";

export interface ConfirmationReceipt {
  readonly txHash: string;
  readonly ledger: number;
}

// narrow subset of horizon.server the executor touches
export type HorizonLike = Pick<Horizon.Server, "loadAccount">;

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
    case "RedeemFxDAO":
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

    try {
      await deps.horizon.loadAccount(input.publicKey);
    } catch {
      // transient horizon 5xx — continue; submit will surface a real failure
    }

    if (node.kind === "FinalClassicTx") {
      // soroban exits shift classical balances, so the cached batches are
      // rebuilt against fresh state — including freshly-resolved XLM paths so
      // credit balances convert via path payment instead of routing to issuer.
      const freshAudit = await withHorizonRetry(() => auditAccount(input.publicKey, deps.network));
      const freshPaths = await withHorizonRetry(() => resolveCreditPaths(freshAudit, deps.network));
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
      let lastReceipt: ConfirmationReceipt | null = null;
      for (let i = 0; i < freshBatches.length; i++) {
        const sourceAccount = await withHorizonRetry(() =>
          deps.horizon.loadAccount(input.publicKey),
        );
        const built = buildClassicTransaction(freshBatches[i]!, sourceAccount, deps.network);
        const signed = await deps.connector.signTransaction(
          built.transaction,
          deps.network.passphrase,
        );
        node.status = "signed";
        notify(node);
        lastReceipt = await deps.submitClassic(signed.signedXdr);
        node.status = "submitted";
        node.executed = { txHash: lastReceipt.txHash, ledger: lastReceipt.ledger };
        notify(node);
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
