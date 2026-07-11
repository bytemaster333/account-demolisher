// build a single bundled closure transaction for a multi-signature account and
// upload it to Refractor as a signing plan.
//
// A shared (multisig) account can't be closed step-by-step the way a single
// owner's account is: every required signer must sign the SAME fixed transaction
// once. So the whole close, cleanup + merge, has to be ONE transaction. That is
// only possible for a CLASSIC-only close (Soroban positions/allowances each need
// their own separate transaction, so they can't be bundled) that fits in one
// batch, using only deterministic disposal, send-to-destination or
// return-to-issuer, never a market sell that could fail and sink the signed
// bundle after everyone has already signed.

import type { Horizon, Transaction } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { createPlan } from "@/lib/multisig/refractor";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import type { AccountAudit } from "@/lib/types/account";
import type { BatchOptions, ClassicMemo } from "@/lib/types/plan";
import type { Connector } from "@/lib/wallet/connector";

// co-signers have this long to sign before the transaction's timebounds expire.
// long enough for real-world coordination, short enough that a forgotten plan
// expires cleanly rather than lingering and later failing on stale state.
export const PLAN_SIGNING_WINDOW_SECONDS = 72 * 60 * 60;

export interface ClosurePlanDisposal {
  // pathKey()s of credit assets to send to the merge destination (the
  // destination must already trust them, verified at preview time)
  readonly sendToDestinationAssetKeys?: readonly string[];
  // pathKey()s of credit assets to return to their issuer
  readonly returnToIssuerAssetKeys?: readonly string[];
  readonly memo?: ClassicMemo;
}

export interface BundleabilityResult {
  readonly ok: boolean;
  readonly reason?: string;
}

// can this close be expressed as ONE signable classic transaction? Soroban
// positions and allowance revocations each need their own transaction, and the
// exchange-mediator flow is multi-step, so none of those can be bundled into a
// single multisig signing plan.
export function assessBundleability(input: {
  readonly hasSorobanPositions: boolean;
  readonly hasSelectedAllowances: boolean;
  readonly useMediator: boolean;
}): BundleabilityResult {
  if (input.useMediator) {
    return {
      ok: false,
      reason:
        "Closing to an exchange uses a multi-step mediator flow that can't be bundled into a single signing plan. Choose a self-custody destination instead.",
    };
  }
  if (input.hasSorobanPositions) {
    return {
      ok: false,
      reason:
        "This account has smart-contract (Soroban) positions, which each need their own transaction and can't be combined into one signing plan. Unwind them first, or close with all signers present.",
    };
  }
  if (input.hasSelectedAllowances) {
    return {
      ok: false,
      reason:
        "Revoking token allowances needs a separate transaction per allowance, which can't be part of a single signing plan. Revoke them first, or close with all signers present.",
    };
  }
  return { ok: true };
}

// refractor's network token
export function refractorNetworkToken(network: NetworkConfig): "public" | "testnet" | "futurenet" {
  return network.id === "mainnet" ? "public" : network.id;
}

// the account's required signer set (weight > 0), for Refractor's desiredSigners
// so the /plan viewer can list who still needs to sign
export function planSignerSet(audit: AccountAudit): readonly string[] {
  return audit.signers.filter((s) => s.weight > 0).map((s) => s.key);
}

// build the single bundled closure transaction for a multisig account. Throws if
// the close doesn't fit in exactly one classic transaction.
export function buildClosurePlanTransaction(params: {
  readonly audit: AccountAudit;
  readonly destination: string;
  readonly network: NetworkConfig;
  readonly sourceAccount: Horizon.AccountResponse;
  readonly disposal?: ClosurePlanDisposal;
  readonly timeoutSeconds?: number;
}): Transaction {
  const { audit, destination, network, sourceAccount, disposal } = params;

  // deterministic-only: never pass conversion paths (no market sells), never use
  // the mediator. Only send-to-destination / return-to-issuer clear balances.
  const batchOptions: BatchOptions = {
    destination,
    useMediator: false,
    ...(disposal?.returnToIssuerAssetKeys
      ? { returnToIssuerAssetKeys: disposal.returnToIssuerAssetKeys }
      : {}),
    ...(disposal?.sendToDestinationAssetKeys
      ? { sendToDestinationAssetKeys: disposal.sendToDestinationAssetKeys }
      : {}),
    ...(disposal?.memo ? { memo: disposal.memo } : {}),
  };

  const batches = batchClassicDemolition(audit, batchOptions, undefined);
  if (batches.length !== 1) {
    throw new Error(
      `buildClosurePlanTransaction: closure needs ${batches.length} transactions, but a shared ` +
        `signing plan requires exactly one bundled transaction ` +
        `(${batches.length > 1 ? "too many operations for one transaction" : "no operations produced"}).`,
    );
  }

  const result = buildClassicTransaction(
    batches[0]!,
    sourceAccount,
    network,
    undefined,
    params.timeoutSeconds ?? PLAN_SIGNING_WINDOW_SECONDS,
  );
  // classic batches always build a classic Transaction (never a fee-bump)
  return result.transaction as Transaction;
}

export interface CreateClosurePlanResult {
  readonly hash: string;
  readonly planPath: string;
}

// build the bundle, sign it with the initiator's connector, and upload it to
// Refractor. Returns the /plan path for the shareable link.
export async function createClosurePlan(params: {
  readonly audit: AccountAudit;
  readonly destination: string;
  readonly network: NetworkConfig;
  readonly sourceAccount: Horizon.AccountResponse;
  readonly connector: Connector;
  readonly disposal?: ClosurePlanDisposal;
}): Promise<CreateClosurePlanResult> {
  const tx = buildClosurePlanTransaction(params);
  const signed = await params.connector.signTransaction(tx, params.network.passphrase);
  const { hash } = await createPlan({
    xdr: signed.signedXdr,
    network: refractorNetworkToken(params.network),
    desiredSigners: planSignerSet(params.audit),
    submit: true,
  });
  return { hash, planPath: `/plan/${hash}` };
}
