// a blend pool pays claimed emissions as BLND straight to the user with a SAC
// transfer, which fails without a BLND trustline (Error(Contract, #13)), so a
// close that claims pool emissions has to open that trustline first. backstop
// emissions are not paid out (the backstop deposits them as LP shares), so only
// pool claims count here.
import {
  Account,
  Asset,
  Operation,
  TransactionBuilder,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

import type { BlendPositionSummary } from "@/lib/adapters/positions/interface";
import type { NetworkConfig } from "@/lib/config/networks";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import type { AccountAudit } from "@/lib/types/account";

import { blndTokenForNetwork, MAX_TIMEOUT_SECONDS } from "./constants";

export interface BlndTrustlineRequirement {
  // missing: change_trust BLND before the claims. unauthorized: the line exists
  // but the issuer has not authorized it, so no claim can be paid and the
  // emissions stay behind unless the user resolves it with the issuer.
  readonly reason: "missing" | "unauthorized";
  readonly code: "BLND";
  readonly issuer: string;
  readonly contractId: string;
  // pools whose claim needs the trustline
  readonly poolIds: readonly string[];
}

// null when no pool claim is planned or the account can already receive BLND
export function blndTrustlineRequirement(
  audit: AccountAudit,
  blend: readonly BlendPositionSummary[],
  network: NetworkConfig,
): BlndTrustlineRequirement | null {
  const poolIds = [
    ...new Set(blend.filter((p) => p.emissionReserveTokenIds.length > 0).map((p) => p.poolId)),
  ];
  if (poolIds.length === 0) return null;

  const blnd = blndTokenForNetwork(network);
  const line = audit.balances.find(
    (b) =>
      b.asset.kind === "credit" && b.asset.code === blnd.code && b.asset.issuer === blnd.issuer,
  );
  if (line !== undefined && line.isAuthorized !== false) return null;
  return {
    reason: line === undefined ? "missing" : "unauthorized",
    code: blnd.code,
    issuer: blnd.issuer,
    contractId: blnd.contractId,
    poolIds,
  };
}

// change_trust BLND with the default (maximum) limit, so any claimed amount
// fits. it bids the same per-op fee as the soroban exit steps; the network only
// charges the ledger's clearing fee, so the bid just keeps it from being priced
// out. built off a copy of the account so the caller's sequence never moves.
export function buildBlndTrustlineTx(
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
): Transaction {
  const blnd = blndTokenForNetwork(network);
  const source = new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber());
  return new TransactionBuilder(source, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset(blnd.code, blnd.issuer) }))
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
}
