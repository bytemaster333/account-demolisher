// blend exit builders. each one re-reads the pool (and backstop) on chain at
// build time, so amounts, the pool version and the backstop always come from
// current state: at preview and again at the execute-time rebuild.
import {
  Account,
  Contract,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  xdr,
  type Horizon,
  type Transaction,
  type rpc,
} from "@stellar/stellar-sdk";
import { RequestType, type Pool, type Reserve } from "@blend-capital/blend-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { isAllowedRootTarget } from "@/lib/config/contracts";
import { applySlippageMin, resolveConfiguredSlippageBps } from "@/lib/safety/slippage";
import { getRpc } from "@/lib/soroban/rpc-client";
import { balance as sep41Balance } from "@/lib/soroban/sep41";
import { assembleSubmittable, simulate, SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import { stroopsToDecimal } from "@/lib/stellar/amount";

import {
  defaultBackstopDepositLoader,
  defaultBlendPoolLoader,
  loadPoolAndUser,
  withBlendFailover,
  type BackstopDepositLoader,
  type BackstopUserState,
  type BlendPoolLoader,
  type BlendUserPositions,
} from "./client";
import {
  blndTokenForNetwork,
  I128_MAX,
  MAX_TIMEOUT_SECONDS,
  resolveKnownBackstop,
  type BlendBackstopRef,
} from "./constants";
import { spendableFromAccount } from "./spendable";

// interest keeps accruing between the build and inclusion, so repays and v1
// withdraws ask for 10 bps more than the current amount. both pools cap at the
// position: a repay refunds the excess in the same call, a withdraw burns at
// most the user's bTokens.
const AMOUNT_BUFFER_BPS = 10n;

export interface BlendExitDeps {
  readonly server?: rpc.Server;
  readonly assemble?: typeof assembleSubmittable;
  readonly simulate?: typeof simulate;
  readonly poolLoader?: BlendPoolLoader;
  readonly backstopLoader?: BackstopDepositLoader;
  // sep-41 balance read for a borrowed token with no classic balance line
  readonly readTokenBalance?: (
    server: rpc.Server,
    tokenId: string,
    user: string,
    network: NetworkConfig,
  ) => Promise<bigint>;
  readonly now?: () => Date;
}

export interface BlendRepayBuild {
  readonly transaction: Transaction;
  readonly amount: bigint;
  // underlying debt at build time
  readonly debt: bigint;
}

export interface BlendWithdrawBuild {
  readonly transaction: Transaction;
  readonly amount: bigint;
}

export interface BlendClaimBuild {
  readonly transaction: Transaction;
  readonly reserveTokenIds: readonly number[];
}

export interface BackstopQueueBuild {
  readonly transaction: Transaction;
  readonly shares: bigint;
  readonly backstop: BlendBackstopRef;
  readonly queueEndsAt: Date;
}

export interface BackstopWithdrawBuild {
  readonly transaction: Transaction;
  readonly shares: bigint;
  readonly backstop: BlendBackstopRef;
}

export interface BackstopClaimBuild {
  readonly transaction: Transaction;
  readonly backstop: BlendBackstopRef;
}

// repay the user's whole liability in one asset. the v2 pool transfers the full
// request amount from the user before refunding the excess, and the SAC rejects
// amounts beyond an i64 and anything the account cannot spend, so the request is
// the buffered debt capped at what the account can really hand over.
export async function buildBlendRepayTx(
  network: NetworkConfig,
  target: { readonly poolId: string; readonly asset: string },
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  deps: BlendExitDeps = {},
): Promise<BlendRepayBuild> {
  requireAllowedPool(network, target.poolId);
  const server = deps.server ?? getRpc(network);
  const { pool, user } = await loadPoolAndUser(
    network,
    target.poolId,
    userPublicKey,
    deps.poolLoader ?? defaultBlendPoolLoader,
  );
  const reserve = reserveFor(pool, target.asset);
  const dTokens = user.getLiabilityDTokens(reserve);
  if (dTokens <= 0n) {
    throw new Error(`no outstanding ${target.asset} liability in Blend pool ${target.poolId}`);
  }
  const debt = reserve.toAssetFromDToken(dTokens);
  const wanted = withBuffer(debt);

  const line = spendableFromAccount(sourceAccount, target.asset, network);
  const spendable =
    line !== null
      ? line.spendable
      : await (deps.readTokenBalance ?? defaultReadTokenBalance)(
          server,
          target.asset,
          userPublicKey,
          network,
        );
  let amount = min(wanted, spendable);
  if (amount <= 0n) {
    throw new Error(
      `no spendable ${target.asset} to repay the Blend loan in pool ${target.poolId}; ` +
        `the account must hold the borrowed asset before the close can repay it`,
    );
  }

  const build = (requestAmount: bigint) =>
    buildSubmitTx(network, server, sourceAccount, target.poolId, userPublicKey, deps, {
      requestType: RequestType.Repay,
      asset: target.asset,
      amount: requestAmount,
    });

  let transaction = await build(amount);
  // the fee comes out of the same XLM before the transfer runs, so a native
  // repay at the edge of the reserve has to leave room for it
  if (line?.native === true && amount + BigInt(transaction.fee) > spendable) {
    amount = spendable - BigInt(transaction.fee);
    if (amount <= 0n) {
      throw new Error(
        `not enough XLM above the minimum reserve to repay the Blend loan and pay the fee`,
      );
    }
    transaction = await build(amount);
    if (amount + BigInt(transaction.fee) > spendable) {
      throw new Error(
        `the repay fee changed between builds; ${amount.toString()} + fee ${transaction.fee} ` +
          `exceeds the ${spendable.toString()} stroops of XLM this account can spend`,
      );
    }
  }
  return { transaction, amount, debt };
}

// withdraw the user's whole collateral or supply position in one asset. the v2
// pool caps a withdraw at the position, so a request far above it drains it
// exactly (see v2WithdrawRequest); the v1 pool overflows on huge amounts before
// that cap, so it gets the buffered underlying amount, which it caps the same way.
export async function buildBlendWithdrawTx(
  network: NetworkConfig,
  target: {
    readonly poolId: string;
    readonly asset: string;
    readonly bucket: "collateral" | "supply";
  },
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  deps: BlendExitDeps = {},
): Promise<BlendWithdrawBuild> {
  requireAllowedPool(network, target.poolId);
  const server = deps.server ?? getRpc(network);
  const { pool, user } = await loadPoolAndUser(
    network,
    target.poolId,
    userPublicKey,
    deps.poolLoader ?? defaultBlendPoolLoader,
  );
  const reserve = reserveFor(pool, target.asset);
  const bTokens =
    target.bucket === "collateral"
      ? user.getCollateralBTokens(reserve)
      : user.getSupplyBTokens(reserve);
  if (bTokens <= 0n) {
    throw new Error(
      `no ${target.bucket} position in ${target.asset} in Blend pool ${target.poolId}`,
    );
  }
  const amount =
    pool.version === "V2"
      ? v2WithdrawRequest(reserve)
      : withBuffer(reserve.toAssetFromBToken(bTokens));
  const transaction = await buildSubmitTx(
    network,
    server,
    sourceAccount,
    target.poolId,
    userPublicKey,
    deps,
    {
      requestType:
        target.bucket === "collateral" ? RequestType.WithdrawCollateral : RequestType.Withdraw,
      asset: target.asset,
      amount,
    },
  );
  return { transaction, amount };
}

// the account cannot receive BLND yet. a typed error so hydration can tell a
// claim that waits on the plan's change_trust step apart from a broken claim.
export class BlndTrustlineMissingError extends Error {
  readonly poolId: string;
  readonly reason: "missing" | "unauthorized";
  constructor(poolId: string, reason: "missing" | "unauthorized", asset: string) {
    super(
      reason === "missing"
        ? `claiming the BLND emissions accrued in Blend pool ${poolId} needs a BLND ` +
            `trustline (${asset}) on this account; add the trustline, then claim`
        : `the BLND trustline (${asset}) on this account is not authorized by its issuer, ` +
            `so the BLND emissions accrued in Blend pool ${poolId} cannot be paid to it`,
    );
    this.name = "BlndTrustlineMissingError";
    this.poolId = poolId;
    this.reason = reason;
  }
}

// claim(from, reserve_token_ids, to). the pool pays BLND to the user with a SAC
// transfer when anything accrued, which fails without an authorized BLND
// trustline, so that case is refused up front with the reason instead of a
// simulation error.
export async function buildBlendClaimTx(
  network: NetworkConfig,
  target: { readonly poolId: string; readonly reserveTokenIds?: readonly number[] },
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  deps: BlendExitDeps = {},
): Promise<BlendClaimBuild> {
  requireAllowedPool(network, target.poolId);
  const server = deps.server ?? getRpc(network);
  const { pool, user } = await loadPoolAndUser(
    network,
    target.poolId,
    userPublicKey,
    deps.poolLoader ?? defaultBlendPoolLoader,
  );
  const estimate = user.estimateEmissions(Array.from(pool.reserves.values()));
  const reserveTokenIds =
    target.reserveTokenIds !== undefined && target.reserveTokenIds.length > 0
      ? [...target.reserveTokenIds]
      : [...estimate.claimedTokens].sort((a, b) => a - b);
  if (reserveTokenIds.length === 0) {
    throw new Error(`nothing to claim from Blend pool ${target.poolId}`);
  }
  const blnd = blndTokenForNetwork(network);
  if (estimate.emissions > 0) {
    const line = sourceAccount.balances.find(
      (b) =>
        (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
        b.asset_code === blnd.code &&
        b.asset_issuer === blnd.issuer,
    );
    if (line === undefined) {
      throw new BlndTrustlineMissingError(target.poolId, "missing", `BLND:${blnd.issuer}`);
    }
    if ("is_authorized" in line && line.is_authorized === false) {
      throw new BlndTrustlineMissingError(target.poolId, "unauthorized", `BLND:${blnd.issuer}`);
    }
  }
  const transaction = await buildCallTx(
    network,
    server,
    sourceAccount,
    deps,
    target.poolId,
    "claim",
    [
      nativeToScVal(userPublicKey, { type: "address" }), // from
      xdr.ScVal.scvVec(reserveTokenIds.map((n) => nativeToScVal(n, { type: "u32" }))),
      nativeToScVal(userPublicKey, { type: "address" }), // to
    ],
  );
  return { transaction, reserveTokenIds };
}

// queue_withdrawal(from, pool_address, amount) on the backstop the pool names,
// for every active share the user holds right now (including shares a backstop
// emissions claim just minted)
export async function buildBackstopQueueTx(
  network: NetworkConfig,
  target: { readonly poolId: string },
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  deps: BlendExitDeps = {},
): Promise<BackstopQueueBuild> {
  const { backstop, state } = await readBackstop(network, target.poolId, userPublicKey, deps);
  if (state.shares <= 0n) {
    throw new Error(`no active Blend backstop shares to queue for pool ${target.poolId}`);
  }
  const transaction = await buildCallTx(
    network,
    deps.server ?? getRpc(network),
    sourceAccount,
    deps,
    backstop.id,
    "queue_withdrawal",
    [
      nativeToScVal(userPublicKey, { type: "address" }), // from
      nativeToScVal(target.poolId, { type: "address" }), // pool_address
      nativeToScVal(state.shares, { type: "i128" }), // amount (shares)
    ],
  );
  const now = (deps.now ?? (() => new Date()))();
  return {
    transaction,
    shares: state.shares,
    backstop,
    queueEndsAt: new Date(now.getTime() + backstop.queueDurationSeconds * 1000),
  };
}

// withdraw(from, pool_address, amount) for the part of the queue already
// unlocked. the backstop pays out BLND-USDC comet LP tokens to the user.
export async function buildBackstopWithdrawTx(
  network: NetworkConfig,
  target: { readonly poolId: string },
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  deps: BlendExitDeps = {},
): Promise<BackstopWithdrawBuild> {
  const { backstop, state } = await readBackstop(network, target.poolId, userPublicKey, deps);
  if (state.unlockedQ4W <= 0n) {
    throw new Error(`no unlocked Blend backstop withdrawal for pool ${target.poolId} yet`);
  }
  const transaction = await buildCallTx(
    network,
    deps.server ?? getRpc(network),
    sourceAccount,
    deps,
    backstop.id,
    "withdraw",
    [
      nativeToScVal(userPublicKey, { type: "address" }), // from
      nativeToScVal(target.poolId, { type: "address" }), // pool_address
      nativeToScVal(state.unlockedQ4W, { type: "i128" }), // amount (shares)
    ],
  );
  return { transaction, shares: state.unlockedQ4W, backstop };
}

// the backstop claim fails in simulation against current chain state. on
// 2026-10-06 every mainnet claim did, on both backstops: the BLND-USDC comet
// traps (UnreachableCodeReached in dep_tokn_amt_in_get_lp_tokns_out) for any
// amount. typed so the plan can show the accrued BLND and ask the user to
// forfeit it before queueing without the claim. an rpc transport failure is
// never this error, so a flaky endpoint is never read as a forfeit.
export class BackstopClaimUnavailableError extends Error {
  readonly poolId: string;
  readonly backstopId: string;
  // BLND, 7 decimals, as read on chain when the claim was probed
  readonly accruedEmissions: bigint;
  readonly simulationError: string;
  constructor(
    poolId: string,
    backstopId: string,
    accruedEmissions: bigint,
    simulationError: string,
  ) {
    super(
      `the Blend backstop ${backstopId} cannot claim the ${stroopsToDecimal(accruedEmissions)} ` +
        `BLND accrued for pool ${poolId} right now (the claim fails in simulation: ` +
        `${simulationError}); queueing the withdrawal without the claim forfeits that BLND`,
    );
    this.name = "BackstopClaimUnavailableError";
    this.poolId = poolId;
    this.backstopId = backstopId;
    this.accruedEmissions = accruedEmissions;
    this.simulationError = simulationError;
  }
}

// claim backstop emissions. both backstop versions pay the claimed BLND into the
// BLND-USDC comet pool and credit the LP back as new backstop shares for the
// user (v1: claim(from, pool_addresses, to); v2: claim(from, pool_addresses,
// min_lp_tokens_out)), so a claim is followed by queueing those shares. the
// claim is simulated first on both versions so a trap comes back as
// BackstopClaimUnavailableError; the v2 floor comes from that simulation, then
// the configured slippage.
export async function buildBackstopClaimTx(
  network: NetworkConfig,
  target: { readonly poolId: string },
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  deps: BlendExitDeps = {},
): Promise<BackstopClaimBuild> {
  const { backstop, state } = await readBackstop(network, target.poolId, userPublicKey, deps);
  if (state.accruedEmissions <= 0n) {
    throw new Error(`no accrued backstop emissions to claim for Blend pool ${target.poolId}`);
  }
  const server = deps.server ?? getRpc(network);
  const from = nativeToScVal(userPublicKey, { type: "address" });
  const pools = xdr.ScVal.scvVec([nativeToScVal(target.poolId, { type: "address" })]);
  const v1Args = [from, pools, nativeToScVal(userPublicKey, { type: "address" })]; // to

  const probe = buildUnpreparedCall(
    network,
    sourceAccount,
    backstop.id,
    "claim",
    backstop.version === "V1" ? v1Args : [from, pools, nativeToScVal(0n, { type: "i128" })],
  );
  const sim = await (deps.simulate ?? simulate)(server, probe);
  if (!sim.ok) {
    throw new BackstopClaimUnavailableError(
      target.poolId,
      backstop.id,
      state.accruedEmissions,
      sim.error,
    );
  }
  if (backstop.version === "V1") {
    const transaction = await buildCallTx(
      network,
      server,
      sourceAccount,
      deps,
      backstop.id,
      "claim",
      v1Args,
    );
    return { transaction, backstop };
  }

  if (sim.retval === null) {
    throw new Error("the Blend backstop claim simulation returned no LP amount");
  }
  const minted = scValToNative(sim.retval) as unknown;
  if (typeof minted !== "bigint" || minted <= 0n) {
    throw new Error("the Blend backstop claim simulation returned no LP tokens to deposit");
  }
  const minOut = BigInt(applySlippageMin(minted.toString(), resolveConfiguredSlippageBps()));
  const transaction = await buildCallTx(
    network,
    server,
    sourceAccount,
    deps,
    backstop.id,
    "claim",
    [from, pools, nativeToScVal(minOut, { type: "i128" })],
  );
  return { transaction, backstop };
}

// one unsigned soroban tx in an exit sequence
export type BlendExitStep =
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
      // pays the accrued backstop BLND into new backstop shares, so it runs
      // before the queue and the queue's rebuild picks those shares up
      readonly kind: "backstop_claim_emissions";
      readonly transaction: Transaction;
    }
  | {
      readonly kind: "backstop_queue_withdrawal";
      // the shares this transaction queues, read on chain when it was built
      readonly shares: bigint;
      readonly queueEndsAt: Date;
      readonly transaction: Transaction;
      readonly manualReturnRequired: true;
    }
  | {
      readonly kind: "backstop_withdraw";
      // the unlocked queued shares this transaction withdraws, read on chain
      // when it was built
      readonly amount: bigint;
      readonly transaction: Transaction;
    };

export interface BuildExitSequenceDeps extends BlendExitDeps {
  // when > 0, queue the backstop withdrawal (the amount queued is re-read on chain)
  readonly backstopShares?: bigint;
  // when set, claim emissions for these reserve token ids
  readonly claimReserveIds?: readonly number[];
  // when true, claim the backstop emissions ahead of the queue. a claim that
  // traps throws BackstopClaimUnavailableError and no step is built, so build
  // the claim on its own when the queue must not wait on it.
  readonly claimBackstopEmissions?: boolean;
  // when > 0, withdraw the unlocked part of the queue. the amount withdrawn is
  // whatever is unlocked on chain at build time, which is returned in the step.
  readonly backstopWithdrawAmount?: bigint;
}

// the assets to unwind in one pool. only the keys of entries with a positive
// value matter: every amount, the pool version and the backstop are read on
// chain by the builders above.
export type BlendExitPosition = Pick<
  BlendUserPositions,
  "poolId" | "liabilities" | "collateral" | "supply"
>;

// ordered unwind for one pool: repays, collateral and supply withdraws, the
// pool emissions claim, the backstop emissions claim, the backstop queue, then
// the withdraw of an already unlocked queue
export async function buildExitSequence(
  network: NetworkConfig,
  position: BlendExitPosition,
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  deps: BuildExitSequenceDeps = {},
): Promise<readonly BlendExitStep[]> {
  requireAllowedPool(network, position.poolId);
  const steps: BlendExitStep[] = [];
  const target = (asset: string) => ({ poolId: position.poolId, asset });

  for (const [asset, owed] of position.liabilities) {
    if (owed <= 0n) continue;
    const built = await buildBlendRepayTx(
      network,
      target(asset),
      userPublicKey,
      sourceAccount,
      deps,
    );
    steps.push({ kind: "repay", asset, amount: built.amount, transaction: built.transaction });
  }
  for (const [asset, held] of position.collateral) {
    if (held <= 0n) continue;
    const built = await buildBlendWithdrawTx(
      network,
      { ...target(asset), bucket: "collateral" },
      userPublicKey,
      sourceAccount,
      deps,
    );
    steps.push({ kind: "withdraw_collateral", asset, transaction: built.transaction });
  }
  for (const [asset, held] of position.supply) {
    if (held <= 0n) continue;
    const built = await buildBlendWithdrawTx(
      network,
      { ...target(asset), bucket: "supply" },
      userPublicKey,
      sourceAccount,
      deps,
    );
    steps.push({ kind: "withdraw_supply", asset, transaction: built.transaction });
  }
  if (deps.claimReserveIds !== undefined) {
    const built = await buildBlendClaimTx(
      network,
      { poolId: position.poolId, reserveTokenIds: deps.claimReserveIds },
      userPublicKey,
      sourceAccount,
      deps,
    );
    steps.push({ kind: "claim_emissions", transaction: built.transaction });
  }
  if (deps.claimBackstopEmissions === true) {
    const built = await buildBackstopClaimTx(
      network,
      { poolId: position.poolId },
      userPublicKey,
      sourceAccount,
      deps,
    );
    steps.push({ kind: "backstop_claim_emissions", transaction: built.transaction });
  }
  if (deps.backstopShares !== undefined && deps.backstopShares > 0n) {
    const built = await buildBackstopQueueTx(
      network,
      { poolId: position.poolId },
      userPublicKey,
      sourceAccount,
      deps,
    );
    steps.push({
      kind: "backstop_queue_withdrawal",
      shares: built.shares,
      queueEndsAt: built.queueEndsAt,
      transaction: built.transaction,
      manualReturnRequired: true,
    });
  }
  if (deps.backstopWithdrawAmount !== undefined && deps.backstopWithdrawAmount > 0n) {
    const built = await buildBackstopWithdrawTx(
      network,
      { poolId: position.poolId },
      userPublicKey,
      sourceAccount,
      deps,
    );
    steps.push({ kind: "backstop_withdraw", amount: built.shares, transaction: built.transaction });
  }
  return steps;
}

function requireAllowedPool(network: NetworkConfig, poolId: string): void {
  if (!isAllowedRootTarget(poolId, network)) {
    throw new Error(
      `Blend pool ${poolId} is not on the ${network.id} allow-list; refusing to build exit transactions`,
    );
  }
}

function reserveFor(pool: Pool, asset: string): Reserve {
  const reserve = pool.reserves.get(asset);
  if (reserve === undefined) {
    throw new Error(`Blend pool ${pool.id} has no reserve for ${asset}`);
  }
  return reserve;
}

async function readBackstop(
  network: NetworkConfig,
  poolId: string,
  userPublicKey: string,
  deps: BlendExitDeps,
): Promise<{ readonly backstop: BlendBackstopRef; readonly state: BackstopUserState }> {
  requireAllowedPool(network, poolId);
  const loader = deps.poolLoader ?? defaultBlendPoolLoader;
  const pool = await withBlendFailover(network, (sdkNetwork) => loader.load(sdkNetwork, poolId));
  const backstop = resolveKnownBackstop(network, pool.metadata.backstop);
  const backstopLoader = deps.backstopLoader ?? defaultBackstopDepositLoader;
  const state = await withBlendFailover(network, (sdkNetwork) =>
    backstopLoader.loadUser(sdkNetwork, backstop, poolId, userPublicKey),
  );
  return { backstop, state };
}

// the v2 pool turns a withdraw request into bTokens, ceil(amount * 1e12 /
// b_rate) in i128, before it caps the burn at the position (blend-contracts-v2
// pool/src/pool/actions.rs apply_withdraw). once bad debt pushes b_rate below
// 1e12, i128::MAX overflows there and the call traps: on 2026-10-07 every
// YieldBloxV2 withdraw did. so ask for an amount that converts to at most a
// quarter of i128::MAX, which leaves room for b_rate to halve before inclusion
// and is still far above any real position.
export function v2WithdrawRequest(reserve: Reserve): bigint {
  const bRate = reserve.data.bRate;
  if (bRate <= 0n) {
    throw new Error(
      `Blend reserve ${reserve.assetId} has a zero bToken rate; nothing can be withdrawn`,
    );
  }
  const scalar = 10n ** BigInt(reserve.rateDecimals);
  const amount = (I128_MAX / 4n / scalar) * bRate;
  return amount < I128_MAX ? amount : I128_MAX;
}

function withBuffer(amount: bigint): bigint {
  return amount + (amount * AMOUNT_BUFFER_BPS + 9_999n) / 10_000n;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

async function defaultReadTokenBalance(
  server: rpc.Server,
  tokenId: string,
  user: string,
  network: NetworkConfig,
): Promise<bigint> {
  return sep41Balance(server, tokenId, user, user, network);
}

// pool.submit(from, spender, to, requests=[{request_type, address, amount}])
async function buildSubmitTx(
  network: NetworkConfig,
  server: rpc.Server,
  sourceAccount: Horizon.AccountResponse,
  poolId: string,
  userPublicKey: string,
  deps: BlendExitDeps,
  request: { readonly requestType: RequestType; readonly asset: string; readonly amount: bigint },
): Promise<Transaction> {
  // map keys in the order the host requires (sorted): address, amount, request_type
  const requestScVal = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("address", { type: "symbol" }),
      val: nativeToScVal(request.asset, { type: "address" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("amount", { type: "symbol" }),
      val: nativeToScVal(request.amount, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("request_type", { type: "symbol" }),
      val: nativeToScVal(request.requestType, { type: "u32" }),
    }),
  ]);
  const user = nativeToScVal(userPublicKey, { type: "address" });
  return buildCallTx(network, server, sourceAccount, deps, poolId, "submit", [
    user, // from
    user, // spender
    user, // to
    xdr.ScVal.scvVec([requestScVal]),
  ]);
}

// built from a copy of the source account, so building more than once (the
// native repay fee pass, preview then rebuild) never advances the caller's
// sequence number: every tx carries the account's current sequence + 1
function buildUnpreparedCall(
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
): Transaction {
  const source = new Account(sourceAccount.accountId(), sourceAccount.sequenceNumber());
  return new TransactionBuilder(source, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
}

async function buildCallTx(
  network: NetworkConfig,
  server: rpc.Server,
  sourceAccount: Horizon.AccountResponse,
  deps: BlendExitDeps,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<Transaction> {
  const tx = buildUnpreparedCall(network, sourceAccount, contractId, fn, args);
  const prepared = await (deps.assemble ?? assembleSubmittable)(server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(`Blend ${fn}: prepareTransaction returned a FeeBumpTransaction unexpectedly`);
  }
  assertTransactionAllowed(prepared, network);
  return prepared;
}
