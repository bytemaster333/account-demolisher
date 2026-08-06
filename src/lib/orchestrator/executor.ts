// shared on-chain executor: walks a hydrated plan tree in topological order and
// signs + submits each node. Used by the page-flow machine's execution actor.

import { BASE_FEE, type Horizon, type Transaction } from "@stellar/stellar-sdk";

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
import { resolveContractIdForAsset } from "@/lib/plan/hydration";
import { assertSafeTransferInvocation } from "@/lib/soroban/transfer-guard";
import { isSorobanNode, topologicalOrder, type PlanNode, type PlanTree } from "@/lib/plan/tree";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";

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
  // execute-time Soroban re-probe used by the FinalClassicTx merge guard. The
  // classic re-audit does NOT see Soroban DeFi positions, so without this an
  // undiscovered / skipped / failed-to-close position is merged around and
  // stranded. Optional so lighter callers/tests can omit it; production wires it
  // to the position provider's discovery.
  readonly reprobeSorobanPositions?: (
    publicKey: string,
    network: NetworkConfig,
  ) => Promise<ProtocolPositions>;
  // Rebuild a Soroban node's transaction from fresh on-chain state (fresh
  // sequence number, footprint, and timebound) immediately before signing.
  // Optional: when absent, the pre-built (preview-time) transaction is signed
  // as-is — the behaviour lighter callers/tests rely on. Production wires this to
  // single-node re-hydration so a slow review can't submit a stale tx, and so a
  // stale-sequence / stale-footprint rejection can be recovered by rebuilding.
  readonly rebuildSorobanNode?: (node: PlanNode, publicKey: string) => Promise<void>;
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
// (404 AccountNotFound, other 4xx) are rethrown immediately, never retried.
async function withHorizonRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // a merged/missing account is a real, terminal answer, so don't retry it
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
// Two-phase close (SEC-13) submits one batch per phase and re-audits between
// them, so a close needs ceil(totalOps / MAX_OPS_PER_TX) + 1 phases. The classic
// subentry ceiling (~1000) bounds this well under 30; exceeding it means the
// close is not converging (a batch that doesn't reduce on-chain state), so we
// throw rather than loop forever.
const MAX_CLOSE_PHASES = 30;

// classify a classic submit rejection to decide whether a rebuild-and-retry can
// help. Horizon surfaces result codes in the thrown message (see submitClassic).
// "fee": bid too low for current congestion -> retry with a higher fee.
// "reprice": a path-payment/offer floor missed because the market moved between
//   quote and submit -> retry, which re-resolves paths and recomputes destMin.
// "resequence": the source account's sequence advanced between build and submit
//   (tx_bad_seq) -> retry; attemptMerge reloads the account fresh each attempt,
//   so the rebuild picks up the current sequence. Bounded by MAX_MERGE_ATTEMPTS,
//   so a persistent bad-seq (not a recoverable race) still fails loudly.
// null: deterministic (no trust, malformed, etc.) -> never retry.
function classicRejectionKind(err: unknown): "fee" | "reprice" | "resequence" | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("tx_insufficient_fee")) return "fee";
  if (msg.includes("tx_bad_seq")) return "resequence";
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

const MAX_SOROBAN_ATTEMPTS = 3;

// A Soroban submit failure recoverable by rebuilding the node against fresh
// on-chain state and retrying. "resequence": the account's sequence moved since
// we built (tx_bad_seq). "footprint": the ledger entries the tx declared changed
// or were archived between simulation and submit. A rebuild re-reads the sequence
// and re-simulates (which re-derives the footprint and resource fee), so a
// bounded retry clears both. A genuine contract revert is NOT classified here:
// the rebuild's re-simulation fails fast and surfaces the real error instead of
// looping on an unrecoverable step.
function sorobanRecoverableKind(err: unknown): "resequence" | "footprint" | null {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
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
    msg.includes("entry_expired")
  ) {
    return "footprint";
  }
  return null;
}

// a competitive starting per-op fee from Horizon's recent fee stats, clamped to
// [network minimum, MAX_PER_OP_FEE]. Falls back to the minimum if feeStats is
// unavailable or malformed; the retry loop escalates from there on a fee reject.
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
      // transient horizon 5xx, continue; submit will surface a real failure
    }

    if (node.kind === "FinalClassicTx") {
      // Two-phase close (SEC-13): some batches CREATE classic balances a later
      // batch must clear. A liquidity_pool_withdraw credits the pool's underlying
      // assets to the account; converting/removing those trustlines or merging in
      // the SAME tx reverts, because the pre-withdraw audit never saw the credited
      // balance. So the batcher isolates withdraws into a leading batch, and here
      // we submit ONE batch per phase, re-auditing (and re-resolving XLM paths)
      // AFTER each confirms so the remainder is rebuilt from the new on-chain
      // state. The loop ends when a single batch remains — the one carrying the
      // account_merge. Re-entering this after a batch confirms is SAFE: a fresh
      // audit reflects applied ops, so a rebuild never re-submits confirmed work.
      // That is also what lets the bounded retry below recover from a fee/price
      // rejection without leaving the account half-closed.
      const attemptMerge = async (feeBase: number): Promise<ConfirmationReceipt> => {
        let receipt: ConfirmationReceipt | null = null;
        let converged = false;
        // The ephemeral mediator is a separate account funded by the first batch.
        // Probe it once so a re-audit phase (or a retry after a prior attempt
        // already funded it) does not re-emit the create-account op, which would
        // revert with op_already_exists. Within this call the per-batch check
        // below keeps it current; a transient probe failure defaults to "not
        // funded" (a redundant funding op is caught by the outer retry).
        let mediatorFunded = false;
        if (node.metadata.useMediator && node.metadata.mediatorPublicKey) {
          try {
            await withHorizonRetry(() =>
              deps.horizon.loadAccount(node.metadata.mediatorPublicKey as string),
            );
            mediatorFunded = true;
          } catch {
            mediatorFunded = false;
          }
        }

        for (let phase = 0; phase < MAX_CLOSE_PHASES; phase++) {
          // soroban exits shift classical balances, so batches are rebuilt against
          // fresh state each phase, including freshly-resolved XLM paths so credit
          // balances convert via path payment instead of routing to issuer.
          const freshAudit = await withHorizonRetry(() =>
            auditAccount(input.publicKey, deps.network),
          );
          const freshPaths = await withHorizonRetry(() =>
            resolveCreditPaths(freshAudit, deps.network),
          );

          // execute-time re-check against fresh state: preview passed, but the
          // world may have diverged (a DeFi exit failed, a credit lost its XLM
          // path). Refuse to build/sign a doomed or fund-losing merge rather than
          // committing part of a multi-batch close and leaving the account wedged.
          const merge = computeMergeability(freshAudit.flags, freshAudit.sponsorship);
          if (!merge.mergeable) {
            throw new Error(
              `account_merge blocked: ${merge.reason}${merge.detail ? `: ${merge.detail}` : ""}`,
            );
          }

          // Execute-time Soroban re-probe: the classic re-audit above sees only
          // classic state, so an undiscovered / skipped / failed-to-close Soroban
          // DeFi position would be merged around and stranded. Re-run discovery
          // and refuse the merge if any position remains. If discovery cannot
          // confirm a clean state it throws (fail-closed), which also blocks it.
          if (deps.reprobeSorobanPositions) {
            const remaining = await deps.reprobeSorobanPositions(input.publicKey, deps.network);
            const open =
              remaining.blend.length +
              remaining.aquarius.length +
              remaining.soroswap.length +
              remaining.fxdao.length;
            if (open > 0) {
              throw new Error(
                `account_merge blocked: ${open} Soroban DeFi position(s) still open ` +
                  `(blend=${remaining.blend.length}, aquarius=${remaining.aquarius.length}, ` +
                  `soroswap=${remaining.soroswap.length}, fxdao=${remaining.fxdao.length}). ` +
                  `Close them before merging, or the funds will be stranded on the deleted account.`,
              );
            }
            // getPositions uses allSettled: a rate-limited / timed-out protocol
            // probe returns an EMPTY array AND records the failure in errors[].
            // An empty array with a recorded error means "could not confirm",
            // NOT "no position" — so treating open===0 as safe would merge around
            // an unreadable position. Fail closed on any probe error. (The
            // multi-endpoint RPC failover makes this a rare, genuine outage rather
            // than routine rate-limiting.)
            if (remaining.errors.length > 0) {
              const detail = remaining.errors
                .map((e) => `${e.protocol}: ${e.message}`)
                .join("; ");
              throw new Error(
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

          const freshBatches = batchClassicDemolition(
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
              ...(node.metadata.mediatorPublicKey
                ? { mediatorPublicKey: node.metadata.mediatorPublicKey }
                : {}),
              // re-apply the deposit memo dropped previously: the batcher attaches
              // it only to a DIRECT final merge (mediator closes carry it on the
              // forward), so a memo-required non-registry exchange close keeps it
              ...(node.metadata.memo ? { memo: node.metadata.memo } : {}),
            },
            freshPaths,
          );
          if (freshBatches.length === 0) {
            throw new Error(`executing: node "${node.id}" produced no fresh batches`);
          }

          const batch = freshBatches[0]!;
          const sourceAccount = await withHorizonRetry(() =>
            deps.horizon.loadAccount(input.publicKey),
          );
          const built = buildClassicTransaction(batch, sourceAccount, deps.network, feeBase);
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

          // once the mediator-funding op has landed, later phases must not
          // re-emit it (the account exists; a second create_account reverts).
          if (
            node.metadata.useMediator &&
            batch.operations.some((op) => op.kind === "create_account_mediator")
          ) {
            mediatorFunded = true;
          }

          // the account_merge always lands in the final batch; when it's the only
          // one left the close is complete. Otherwise re-audit and continue.
          if (freshBatches.length === 1) {
            converged = true;
            break;
          }
        }
        if (!converged || receipt === null) {
          // exhausted the phase budget without submitting the merge batch: the
          // close is NOT complete, so fail loudly rather than report the last
          // intermediate receipt as success.
          throw new Error(
            `executing: node "${node.id}" did not converge within ${MAX_CLOSE_PHASES} phases`,
          );
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
          // "reprice": next attemptMerge re-resolves paths and recomputes destMin.
          // "resequence": next attemptMerge reloads the account, picking up the
          // advanced sequence number, so the rebuilt merge tx is in-sequence.
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
        // the full memo (any type) reaches the CEX on this forward hop
        ...(node.metadata.memo ? { memo: node.metadata.memo } : {}),
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

    // Everything past the FinalClassicTx / MediatorForward branches is a
    // single-transaction Soroban node (isSorobanNode === true for all of them).
    if (!isSorobanNode(node)) {
      throw new Error(`executing: node "${node.id}" (${node.kind}) is not a Soroban node`);
    }

    // TransferAsIs is the auto-drain of a discovered standalone SEP-41 token, and
    // it is BEST-EFFORT. The token is airdrop-reachable, i.e. attacker-controlled,
    // so (a) it is held to an EXACT transfer(user, destination, amount) with no
    // smuggled auth — the DeFi allow-list doesn't apply since it targets the
    // user's own token contract — and (b) any failure (unsafe auth tree, a
    // revert-on-transfer griefing token, an rpc error) is SKIPPED, never fatal:
    // it runs before the merge only for ordering, and a "skipped" dependency
    // still lets the merge proceed, so one un-drainable token can't wedge the
    // close (it is simply left behind on the account being deleted).
    if (node.kind === "TransferAsIs") {
      try {
        const transferReceipt = await signAndSubmitSorobanNode(node, input.publicKey, deps, {
          allowlist: false,
          guard: (tx) =>
            assertSafeTransferInvocation(tx, {
              contractId: resolveContractIdForAsset(node.metadata.asset, deps.network),
              from: input.publicKey,
              to: node.metadata.destination,
              amount: node.metadata.amount,
            }),
          onSigned: () => notify(node),
        });
        node.status = "confirmed";
        node.executed = { txHash: transferReceipt.txHash, ledger: transferReceipt.ledger };
        receipts[node.id] = transferReceipt;
        notify(node);
      } catch (err) {
        node.status = "skipped";
        node.error = `Token drain skipped: ${err instanceof Error ? err.message : String(err)}`;
        notify(node);
      }
      continue;
    }

    // Pre-sign allow-list gate (defense-in-depth on top of each adapter's own
    // build-time check): every DeFi-protocol node must invoke only allow-listed
    // contracts. RevokeAllowance is the deliberate exception: it targets the
    // user's own token contracts (chosen from an RPC allowance scan, not the DeFi
    // allow-list) and only ever builds a safe approve(0) sourced from the user.
    const receipt = await signAndSubmitSorobanNode(node, input.publicKey, deps, {
      allowlist: node.kind !== "RevokeAllowance",
      onSigned: () => notify(node),
    });

    node.status = "confirmed";
    node.executed = { txHash: receipt.txHash, ledger: receipt.ledger };
    receipts[node.id] = receipt;
    notify(node);
  }

  return { receipts, tree: input.tree };
}

// Sign + submit ONE Soroban node with pre-signature freshness and recovery.
// Before signing, rebuild the node against fresh on-chain state (fresh sequence
// number, re-simulated footprint/resource fee, fresh timebound) so a plan that
// sat in review isn't submitted stale. On a stale-sequence / stale-footprint
// rejection, rebuild and retry (bounded by MAX_SOROBAN_ATTEMPTS). When deps has
// no rebuildSorobanNode callback (lighter callers/tests), the pre-built tx is
// signed as-is and a failure is NOT retried — resubmitting the identical stale
// transaction would only reproduce the rejection.
async function signAndSubmitSorobanNode(
  node: PlanNode,
  publicKey: string,
  deps: ExecutorDeps,
  opts: {
    readonly allowlist: boolean;
    readonly guard?: (tx: Transaction) => void;
    readonly onSigned: () => void;
  },
): Promise<ConfirmationReceipt> {
  const canRebuild = typeof deps.rebuildSorobanNode === "function";
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_SOROBAN_ATTEMPTS; attempt++) {
    if (deps.rebuildSorobanNode) {
      // fresh sequence + re-simulated footprint; throws (surfacing the real
      // error) rather than signing a stale/doomed tx
      await deps.rebuildSorobanNode(node, publicKey);
    }
    const tx = pickTransaction(node);
    if (!tx) {
      throw new Error(`executing: node "${node.id}" (${node.kind}) has no transaction attached`);
    }
    // guard (e.g. the held-token transfer auth check) runs BEFORE signing and is
    // not a recoverable rejection: a hostile auth tree won't become safe on retry.
    opts.guard?.(tx);
    if (opts.allowlist) assertTransactionAllowed(tx, deps.network);
    const signed = await deps.connector.signTransaction(tx, deps.network.passphrase);
    node.status = "signed";
    opts.onSigned();
    try {
      return await deps.submitSoroban(signed.signedXdr);
    } catch (err) {
      lastErr = err;
      const kind = sorobanRecoverableKind(err);
      if (kind === null || !canRebuild || attempt === MAX_SOROBAN_ATTEMPTS) throw err;
      // loop: the next iteration rebuilds against fresh state — a fresh sequence
      // for "resequence", a re-simulated footprint for "footprint".
    }
  }
  throw lastErr;
}
