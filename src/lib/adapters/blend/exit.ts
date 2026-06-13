// blend exit sequencer. produces an ordered, unsigned list of exit steps for one pool
import {
  Asset,
  BASE_FEE,
  Contract,
  nativeToScVal,
  TransactionBuilder,
  xdr,
  type Horizon,
  type Transaction,
  type rpc,
} from "@stellar/stellar-sdk";
import { RequestType } from "@blend-capital/blend-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { assembleSubmittable } from "@/lib/soroban/simulate";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import { isAllowedContract } from "@/lib/config/contracts";
import type { AssetIdentifier } from "@/lib/types/account";
import type { BlendUserPositions } from "./client";
import {
  BACKSTOP_QUEUE_DURATION_SECONDS,
  BLEND_BACKSTOP_MAINNET_ID,
  I128_MAX,
  MAX_TIMEOUT_SECONDS,
} from "./constants";

// one unsigned soroban tx in the exit sequence, or a delegated acquire-asset marker
export type BlendExitStep =
  | {
      readonly kind: "acquire_repay_asset";
      readonly asset: string;
      readonly amount: bigint;
      readonly assetIdentifier: AssetIdentifier;
      readonly poolId: string;
      readonly note: string;
    }
  | {
      readonly kind: "repay";
      readonly asset: string;
      readonly amount: bigint;
      readonly transaction: Transaction;
    }
  | {
      readonly kind: "withdraw_collateral";
      readonly asset: string;
      readonly transaction: Transaction;
    }
  | {
      readonly kind: "withdraw_supply";
      readonly asset: string;
      readonly transaction: Transaction;
    }
  | {
      readonly kind: "claim_emissions";
      readonly transaction: Transaction;
    }
  | {
      readonly kind: "backstop_queue_withdrawal";
      readonly queueEndsAt: Date;
      readonly transaction: Transaction;
      readonly manualReturnRequired: true;
    };

// optional context from the caller's full balance sheet
export interface BuildExitSequenceDeps {
  readonly holdsAtLeast?: (asset: string, amount: bigint) => boolean;
  readonly resolveAssetIdentifier?: (asset: string) => AssetIdentifier;
  readonly backstopShares?: bigint;
  readonly claimReserveIds?: readonly number[];
  readonly assemble?: typeof assembleSubmittable;
  readonly server?: rpc.Server;
  readonly now?: () => Date;
}

// build the ordered unwind sequence for one pool position
export async function buildExitSequence(
  network: NetworkConfig,
  position: BlendUserPositions,
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  deps: BuildExitSequenceDeps = {},
): Promise<readonly BlendExitStep[]> {
  if (!isAllowedContract(position.poolId, network)) {
    throw new Error(
      `buildExitSequence: pool ${position.poolId} is not on the ${network.id} allow-list; refusing to build exit transactions`,
    );
  }

  const server = deps.server ?? getRpc(network);
  const assemble = deps.assemble ?? assembleSubmittable;
  const holdsAtLeast = deps.holdsAtLeast ?? (() => false);
  const now = deps.now ?? (() => new Date());

  const steps: BlendExitStep[] = [];

  // acquire markers for liabilities the user doesn't already hold
  for (const [asset, amount] of position.liabilities) {
    if (amount <= 0n) continue;
    if (holdsAtLeast(asset, amount)) continue;
    steps.push({
      kind: "acquire_repay_asset",
      asset,
      amount,
      assetIdentifier: deps.resolveAssetIdentifier
        ? deps.resolveAssetIdentifier(asset)
        : inferAssetIdentifier(asset, network),
      poolId: position.poolId,
      note:
        `Requires ${amount.toString()} of ${asset} to repay on Blend pool ${position.poolName}. ` +
        `Automatic swap routing is not implemented; if the user does not already hold the asset, ` +
        `the repay step will fail and the position must be closed manually before merging.`,
    });
  }

  // repays — one submit per liability
  for (const [asset, amount] of position.liabilities) {
    if (amount <= 0n) continue;
    const tx = await buildSubmitRequestTx(
      server,
      sourceAccount,
      network,
      position.poolId,
      userPublicKey,
      RequestType.Repay,
      asset,
      // pass i128::MAX so the pool drains the full liability even if interest accrued
      I128_MAX,
      assemble,
    );
    steps.push({ kind: "repay", asset, amount, transaction: tx });
  }

  // withdraw collateral
  for (const [asset, amount] of position.collateral) {
    if (amount <= 0n) continue;
    const tx = await buildSubmitRequestTx(
      server,
      sourceAccount,
      network,
      position.poolId,
      userPublicKey,
      RequestType.WithdrawCollateral,
      asset,
      I128_MAX,
      assemble,
    );
    steps.push({ kind: "withdraw_collateral", asset, transaction: tx });
  }

  // withdraw supply
  for (const [asset, amount] of position.supply) {
    if (amount <= 0n) continue;
    const tx = await buildSubmitRequestTx(
      server,
      sourceAccount,
      network,
      position.poolId,
      userPublicKey,
      RequestType.Withdraw,
      asset,
      I128_MAX,
      assemble,
    );
    steps.push({ kind: "withdraw_supply", asset, transaction: tx });
  }

  // claim emissions if any reserve has accrued them
  const claimIds = deps.claimReserveIds ?? deriveClaimReserveIds(position);
  if (claimIds.length > 0) {
    const tx = await buildClaimTx(
      server,
      sourceAccount,
      network,
      position.poolId,
      userPublicKey,
      claimIds,
      assemble,
    );
    steps.push({ kind: "claim_emissions", transaction: tx });
  }

  // backstop queue withdrawal — honest about the 17-day lock
  if (deps.backstopShares !== undefined && deps.backstopShares > 0n) {
    const tx = await buildBackstopQueueWithdrawalTx(
      server,
      sourceAccount,
      network,
      position.poolId,
      userPublicKey,
      deps.backstopShares,
      assemble,
    );
    const queueEndsAt = new Date(now().getTime() + BACKSTOP_QUEUE_DURATION_SECONDS * 1000);
    steps.push({
      kind: "backstop_queue_withdrawal",
      queueEndsAt,
      transaction: tx,
      manualReturnRequired: true,
    });
  }

  return steps;
}

// build pool.submit(from, spender, to, requests=[{request_type, address, amount}])
async function buildSubmitRequestTx(
  server: rpc.Server,
  sourceAccount: Horizon.AccountResponse,
  network: NetworkConfig,
  poolId: string,
  userPublicKey: string,
  requestType: RequestType,
  asset: string,
  amount: bigint,
  assemble: typeof assembleSubmittable,
): Promise<Transaction> {
  const contract = new Contract(poolId);

  const request: xdr.ScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("address", { type: "symbol" }),
      val: nativeToScVal(asset, { type: "address" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("amount", { type: "symbol" }),
      val: nativeToScVal(amount, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("request_type", { type: "symbol" }),
      val: nativeToScVal(requestType, { type: "u32" }),
    }),
  ]);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      contract.call(
        "submit",
        nativeToScVal(userPublicKey, { type: "address" }), // from
        nativeToScVal(userPublicKey, { type: "address" }), // spender
        nativeToScVal(userPublicKey, { type: "address" }), // to
        xdr.ScVal.scvVec([request]),
      ),
    )
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();

  const prepared = await assemble(server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(
      "buildExitSequence: prepareTransaction returned a FeeBumpTransaction unexpectedly",
    );
  }
  assertTransactionAllowed(prepared, network);
  return prepared;
}

// build claim(from, reserve_token_ids, to)
async function buildClaimTx(
  server: rpc.Server,
  sourceAccount: Horizon.AccountResponse,
  network: NetworkConfig,
  poolId: string,
  userPublicKey: string,
  reserveTokenIds: readonly number[],
  assemble: typeof assembleSubmittable,
): Promise<Transaction> {
  const contract = new Contract(poolId);

  const idScVals = reserveTokenIds.map((n) => nativeToScVal(n, { type: "u32" }));

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      contract.call(
        "claim",
        nativeToScVal(userPublicKey, { type: "address" }), // from
        xdr.ScVal.scvVec(idScVals), // reserve_token_ids
        nativeToScVal(userPublicKey, { type: "address" }), // to
      ),
    )
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();

  const prepared = await assemble(server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(
      "buildExitSequence (claim): prepareTransaction returned a FeeBumpTransaction unexpectedly",
    );
  }
  assertTransactionAllowed(prepared, network);
  return prepared;
}

// build queue_withdrawal(from, pool_address, amount) against the v2 backstop
async function buildBackstopQueueWithdrawalTx(
  server: rpc.Server,
  sourceAccount: Horizon.AccountResponse,
  network: NetworkConfig,
  poolId: string,
  userPublicKey: string,
  shares: bigint,
  assemble: typeof assembleSubmittable,
): Promise<Transaction> {
  if (shares <= 0n) {
    throw new RangeError(
      `buildExitSequence: backstop queue requires shares > 0; got ${shares.toString()}`,
    );
  }

  const contract = new Contract(BLEND_BACKSTOP_MAINNET_ID);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      contract.call(
        "queue_withdrawal",
        nativeToScVal(userPublicKey, { type: "address" }), // from
        nativeToScVal(poolId, { type: "address" }), // pool_address
        nativeToScVal(shares, { type: "i128" }), // amount (shares)
      ),
    )
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();

  const prepared = await assemble(server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(
      "buildExitSequence (backstop): prepareTransaction returned a FeeBumpTransaction unexpectedly",
    );
  }
  assertTransactionAllowed(prepared, network);
  return prepared;
}

// default reserve-id list for claim: union of indices the user has any position in
function deriveClaimReserveIds(position: BlendUserPositions): readonly number[] {
  return Array.from(position.emissions.keys()).sort((a, b) => a - b);
}

// best-effort guess at the asset identifier; orchestrator-supplied resolver overrides this
function inferAssetIdentifier(contractId: string, network: NetworkConfig): AssetIdentifier {
  const nativeContract = Asset.native().contractId(network.passphrase);
  if (contractId === nativeContract) {
    return { kind: "native" };
  }
  // fallback to unknown so the orchestrator hard-errors at lookup rather than fabricating an issuer
  return { kind: "credit", code: "UNKNOWN", issuer: contractId };
}
