// the shared-account (signing request) path: when it may be offered, how the
// one bundled transaction is built from the reviewed plan, and the checks run
// right before it is published for co-signers.

import type { Horizon, Transaction } from "@stellar/stellar-sdk";

import { openPositionCount, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import {
  SIGNING_WINDOW_SECONDS,
  assessBundleability,
  type BundleabilityResult,
} from "@/lib/multisig/signing-request";
import type { PlanTree } from "@/lib/plan/tree";
import { decimalToStroops } from "@/lib/stellar/amount";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { filterClaimableNow } from "@/lib/stellar/claimable-balances";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";
import type { ClassicBatch, ClassicMemo } from "@/lib/types/plan";

// a classic pool share is withdrawn in its own leading batch, so an account that
// holds one can never be closed by one signed transaction
export function hasClassicPoolShares(audit: AccountAudit): boolean {
  return audit.poolShares.some((p) => decimalToStroops(p.shareBalance) > 0n);
}

// whether the reviewed close can be published as a signing request. Everything a
// single bundled classic transaction can't carry, or anything discovery couldn't
// confirm, refuses it: a bundle that merges around an open position, a backstop
// (even one fully queued, which yields no plan step) or a token strands it on the
// deleted account once every co-signer has signed.
export function assessSigningRequest(input: {
  readonly positions: ProtocolPositions;
  readonly allowanceCount: number;
  readonly useMediator: boolean;
  // standalone tokens picked to sweep, on the page or in the built plan
  readonly heldTokensSelected: number;
  readonly hasClassicPoolShares: boolean;
  readonly tree: PlanTree | null;
  // the plan was built with deterministic disposal (no market sells)
  readonly deterministic: boolean;
}): BundleabilityResult {
  const base = assessBundleability({
    hasSorobanPositions: openPositionCount(input.positions) > 0,
    hasSelectedAllowances: input.allowanceCount > 0,
    useMediator: input.useMediator,
    hasClassicPoolShares: input.hasClassicPoolShares,
    hasSelectedHeldTokens: input.heldTokensSelected > 0,
  });
  if (!base.ok) return base;

  if (input.positions.errors.length > 0) {
    const protocols = input.positions.errors.map((e) => e.protocol).join(", ");
    return {
      ok: false,
      reason:
        `We couldn't confirm this account's DeFi positions (${protocols}). A signing request ` +
        "closes the account in one transaction, so it can't be offered while a position might " +
        "be missed. Try again once the network responds.",
    };
  }

  if (input.tree !== null) {
    // regardless of status: a skipped or failed step still means the position or
    // token it was meant to handle is there, and the bundle would close around it
    const stray = [...input.tree.allNodes.values()].find((n) => n.kind !== "FinalClassicTx");
    if (stray) {
      return {
        ok: false,
        reason:
          `This close includes a step (${stray.kind}) that needs its own transaction, so it ` +
          "can't be packaged as one signing request. Handle it with all signers present first.",
      };
    }
  }

  if (!input.deterministic) {
    return {
      ok: false,
      reason:
        "This plan was built for a single signer and may sell assets on the market. Rebuild it " +
        "as a shared-account close before creating a signing request.",
    };
  }

  return { ok: true };
}

function sameMemo(a: ClassicMemo | undefined, b: ClassicMemo | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.type === b.type && a.value === b.value;
}

// the one transaction co-signers sign, built from the batch the user reviewed
// rather than rebuilt from form state, so its operations, claimable selection and
// memo are exactly what Review showed. Throws if the reviewed plan isn't a single
// direct-merge batch to the reviewed destination with the reviewed memo.
export function buildReviewedBundle(args: {
  readonly tree: PlanTree;
  readonly input: {
    readonly destination: string;
    readonly useMediator: boolean;
    readonly memo?: ClassicMemo;
  };
  readonly sourceAccount: Horizon.AccountResponse;
  readonly network: NetworkConfig;
  // close time (unix seconds) of the latest ledger: the request's expiry is
  // counted from the network's clock, the same one the claim window check uses.
  // required, so no caller can end up with an expiry from the browser's clock
  readonly ledgerCloseTime: number;
}): Transaction {
  const { tree, input } = args;
  const final = tree.allNodes.get("final-classic-tx");
  if (!final || final.kind !== "FinalClassicTx") {
    throw new Error("The reviewed plan has no closing transaction to sign.");
  }
  if (input.useMediator || final.metadata.useMediator) {
    throw new Error("An exchange close goes through the mediator and can't be a signing request.");
  }
  const batches = final.metadata.batches;
  if (batches.length !== 1) {
    throw new Error(
      `The reviewed close needs ${batches.length} transactions, but a signing request must be exactly one.`,
    );
  }
  const batch: ClassicBatch = batches[0]!;
  if (batch.destination !== input.destination || final.metadata.destination !== input.destination) {
    throw new Error("The reviewed plan's destination doesn't match the destination you confirmed.");
  }
  if (
    batch.mediator !== undefined ||
    batch.operations.some((o) => o.kind === "create_account_mediator")
  ) {
    throw new Error("The reviewed close funds a mediator, which a signing request can't include.");
  }
  if (!sameMemo(batch.memo, input.memo)) {
    throw new Error("The reviewed plan's memo doesn't match the memo you entered.");
  }
  const last = batch.operations[batch.operations.length - 1];
  if (last?.kind !== "account_merge") {
    throw new Error("The reviewed close doesn't end with the account merge.");
  }

  const built = buildClassicTransaction(
    batch,
    args.sourceAccount,
    args.network,
    undefined,
    SIGNING_WINDOW_SECONDS,
    args.ledgerCloseTime,
  );
  return built.transaction as Transaction;
}

export interface ClaimAtRisk {
  readonly id: string;
  readonly asset: AssetIdentifier;
  readonly amount: string;
  // expires: this account's claim window closes inside the signing window;
  // reclaimable: another claimant (usually the sender) can take it first;
  // untrusted: the account has no trustline for the asset, so the claim fails
  readonly reason: "expires" | "reclaimable" | "untrusted";
}

// absolute time thresholds (ms) in a Horizon predicate tree; a predicate only
// changes value at these instants
function predicateThresholds(node: unknown, out: number[]): void {
  if (Array.isArray(node)) {
    for (const n of node) predicateThresholds(n, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if ((key === "abs_before_epoch" || key === "absBeforeEpoch") && value !== null) {
      const s = Number(value);
      if (Number.isFinite(s)) out.push(s * 1000);
    } else if ((key === "abs_before" || key === "absBefore") && typeof value === "string") {
      const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value);
      if (Number.isFinite(ms)) out.push(ms);
    } else {
      predicateThresholds(value, out);
    }
  }
}

// claimable balances in the reviewed bundle whose claim can fail before the
// request expires. Collecting signatures takes up to the signing window, and if
// any claim op fails then, the whole bundle fails after everyone signed.
export function claimsAtRiskInWindow(args: {
  readonly audit: AccountAudit;
  readonly tree: PlanTree;
  readonly publicKey: string;
  readonly nowMs: number;
  readonly windowSeconds: number;
}): readonly ClaimAtRisk[] {
  const final = args.tree.allNodes.get("final-classic-tx");
  if (!final || final.kind !== "FinalClassicTx") return [];
  const claimed = new Set(
    final.metadata.batches
      .flatMap((b) => b.operations)
      .filter((o) => o.kind === "claim_claimable_balance")
      .map((o) => String(o.metadata["balanceId"])),
  );
  const end = args.nowMs + args.windowSeconds * 1000;
  const ops = final.metadata.batches.flatMap((b) => b.operations);
  // a line the account holds, or one the bundle opens right before the claim
  const trusted = new Set([
    ...args.audit.balances.flatMap((b) =>
      b.asset.kind === "credit" ? [`${b.asset.code}:${b.asset.issuer}`] : [],
    ),
    ...ops.flatMap((o) => {
      const asset = o.kind === "change_trust_add" ? (o.metadata["asset"] as AssetIdentifier) : null;
      return asset?.kind === "credit" ? [`${asset.code}:${asset.issuer}`] : [];
    }),
  ]);
  const out: ClaimAtRisk[] = [];
  for (const cb of args.audit.claimableBalances) {
    if (!claimed.has(cb.id)) continue;
    // claiming a credit asset needs a trustline, except for the account's own
    // asset, which it claims without one
    if (
      cb.asset.kind === "credit" &&
      cb.asset.issuer !== args.audit.accountId &&
      !trusted.has(`${cb.asset.code}:${cb.asset.issuer}`)
    ) {
      out.push({ id: cb.id, asset: cb.asset, amount: cb.amount, reason: "untrusted" });
      continue;
    }
    const thresholds: number[] = [];
    predicateThresholds(cb.claimantsRaw, thresholds);
    const instants = [args.nowMs, end, ...thresholds.filter((t) => t > args.nowMs && t <= end)];
    const claimableAt = (who: string, t: number): boolean =>
      filterClaimableNow([cb], who, new Date(t)).length > 0;
    const others = cb.claimants.filter((c) => c !== args.publicKey);
    if (others.some((o) => instants.some((t) => claimableAt(o, t)))) {
      out.push({ id: cb.id, asset: cb.asset, amount: cb.amount, reason: "reclaimable" });
    } else if (!instants.every((t) => claimableAt(args.publicKey, t))) {
      out.push({ id: cb.id, asset: cb.asset, amount: cb.amount, reason: "expires" });
    }
  }
  return out;
}

// the claims that would sink the signed bundle: one whose window closes before
// the request expires, or one the account can't take without a trustline. A
// claim the sender can take back first is a warning, not a refusal.
export function sinkingClaims(risks: readonly ClaimAtRisk[]): readonly ClaimAtRisk[] {
  return risks.filter((r) => r.reason !== "reclaimable");
}

// re-run DeFi discovery right before the request is published, the same check
// the single-signer executor runs before its merge. Fail closed: an open
// position (a queued backstop included), a recorded probe error, or a probe that
// throws all refuse, so co-signers are never asked to sign a merge that strands
// a position.
export async function reprobeBeforePublish(
  publicKey: string,
  network: NetworkConfig,
  getPositions: (publicKey: string, network: NetworkConfig) => Promise<ProtocolPositions>,
): Promise<BundleabilityResult> {
  let positions: ProtocolPositions;
  try {
    positions = await getPositions(publicKey, network);
  } catch (err) {
    const detail = errorMessage(err);
    return {
      ok: false,
      reason: `We couldn't re-check this account's DeFi positions before publishing (${detail}). Try again.`,
    };
  }
  if (openPositionCount(positions) > 0) {
    return {
      ok: false,
      reason:
        "This account now has an open DeFi position (lending, liquidity or a Blend backstop). " +
        "A signing request would close the account around it, so close it first.",
    };
  }
  if (positions.errors.length > 0) {
    const detail = positions.errors.map((e) => `${e.protocol}: ${e.message}`).join("; ");
    return {
      ok: false,
      reason: `We couldn't confirm every DeFi position is closed (${detail}). Try again once the network responds.`,
    };
  }
  return { ok: true };
}
