// walks the plan tree and attaches an unsigned transaction to every node that
// carries its own (the soroban steps and the trustlines they pay into)

import {
  Asset,
  Horizon,
  NotFoundError,
  scValToNative,
  type Transaction,
  type rpc,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { blndTokenForNetwork } from "@/lib/adapters/blend/constants";
import {
  BackstopClaimUnavailableError,
  BackstopNothingAccruedError,
  BlndTrustlineMissingError,
  buildBackstopClaimTx,
  buildBackstopQueueTx,
  buildBackstopWithdrawTx,
  buildExitSequence,
  type BlendExitPosition,
  type BlendExitStep,
  type BuildExitSequenceDeps,
} from "@/lib/adapters/blend/exit";
import { BASE_RESERVE_STROOPS, spendableFromAccount } from "@/lib/adapters/blend/spendable";
import {
  claim as aquariusClaim,
  claimConcentratedFees,
  withdraw as aquariusWithdraw,
  withdrawConcentratedPosition,
} from "@/lib/adapters/aquarius/client";
import { estimateConcentratedWithdraw } from "@/lib/adapters/aquarius/concentrated";
import { claimGaugeRewards } from "@/lib/adapters/aquarius/gauges";
import { poolIndexHexToBytes } from "@/lib/adapters/aquarius/pools";
import { removeLiquidityByContractIds } from "@/lib/adapters/soroswap/lp";
import {
  buildSwapToXLM,
  NoSoroswapRouteError,
  quoteRouteToXLM,
} from "@/lib/adapters/soroswap/swap";
import { errorMessage } from "@/lib/errors";
import { buildRevoke } from "@/lib/soroban/allowances";
import { balance as readTokenBalance, buildTransfer } from "@/lib/soroban/sep41";
import { simulate, SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { stroopsToDecimal } from "@/lib/stellar/amount";
import { withHorizonRetry } from "@/lib/stellar/horizon-retry";
import { buildTrustlineTx } from "@/lib/stellar/trustline-tx";
import { applySlippageMin, resolveConfiguredSlippageBps } from "@/lib/safety/slippage";
import type { AssetIdentifier } from "@/lib/types/account";
import {
  MAX_PRICE_IMPACT_BPS,
  priceImpactBps,
  referenceTradeAmount,
} from "@/lib/plan/price-impact";

import type { PlanNode, PlanTree, SwapQuote } from "./tree";
import { topologicalOrder } from "./tree";

// how long a soroswap swap or LP withdraw stays executable, counted from the
// latest ledger's close time; the same window as the tx's own time bound
const SOROSWAP_DEADLINE_SECONDS = 300;

export interface HydrationFailure {
  readonly nodeId: string;
  readonly reason: string;
  // the node runs after other steps, so this failure against today's state is
  // not final: the node stays pending and is built at execute time
  readonly deferred: boolean;
  // the failures that wait on the user's answer, so the review can ask instead
  // of reading the reason text. a held-token conversion refused for its price
  // (PriceImpactRefusedError) or with no route to XLM (NoSoroswapRouteError)
  // asks accept, send as-is or leave; a backstop emissions claim that traps
  // (BackstopEmissionsClaimError) asks for the forfeit acknowledgement
  readonly priceImpactRefused: boolean;
  readonly noSoroswapRoute: boolean;
  readonly backstopClaimUnavailable: boolean;
  // which answer a refused conversion waits on, set with the two flags above
  // (unset only for a price refusal thrown without its detail)
  readonly refusal?: ConversionRefusal | "no_route";
  // the BLND accrued on a claim that traps, as read on chain when it was
  // simulated (set with backstopClaimUnavailable), for the forfeit question
  readonly backstopAccruedEmissions?: bigint;
  // the thrown value itself, so a caller can read what the error carries (the
  // quote of a refusal, the token an exit can't pay out)
  readonly error: unknown;
}

export interface HydrationDeps {
  readonly rpc: rpc.Server;
  readonly horizon: Horizon.Server;
  readonly network: NetworkConfig;
  readonly currentLedger: number;
  // close time (unix seconds) of the latest ledger, read from the network. every
  // built tx expires a fixed window after it and the soroswap router deadline is
  // counted from it, so a skewed browser clock can't make them stale on arrival
  readonly ledgerCloseTime: number;
  readonly fetchSourceAccount: (publicKey: string) => Promise<Horizon.AccountResponse>;
  // adapter overrides for tests; prod leaves this undefined
  readonly adapters?: HydrationAdapterOverrides;
}

export interface HydrationAdapterOverrides {
  readonly buildRevoke?: typeof buildRevoke;
  readonly buildExitSequence?: typeof buildExitSequence;
  readonly buildBackstopClaimTx?: typeof buildBackstopClaimTx;
  readonly buildBackstopQueueTx?: typeof buildBackstopQueueTx;
  readonly buildBackstopWithdrawTx?: typeof buildBackstopWithdrawTx;
  readonly aquariusWithdraw?: typeof aquariusWithdraw;
  readonly aquariusClaim?: typeof aquariusClaim;
  readonly withdrawConcentratedPosition?: typeof withdrawConcentratedPosition;
  readonly claimConcentratedFees?: typeof claimConcentratedFees;
  readonly claimGaugeRewards?: typeof claimGaugeRewards;
  readonly estimateConcentratedWithdraw?: typeof estimateConcentratedWithdraw;
  readonly removeLiquidityByContractIds?: typeof removeLiquidityByContractIds;
  readonly buildSwapToXLM?: typeof buildSwapToXLM;
  readonly quoteRouteToXLM?: typeof quoteRouteToXLM;
  readonly buildTransfer?: typeof buildTransfer;
  readonly readTokenBalance?: typeof readTokenBalance;
}

// per-node failures populate `failures[]`. A node with no dependencies is marked
// "failed". A node that runs after other steps (a collateral withdraw behind its
// repay, a sweep behind the exits that pay it) is simulated here against state
// those steps haven't changed yet, so its failure only defers it: it stays
// "pending" with node.deferred set and is built at execute time once they land.
// A refused conversion and a backstop emissions claim that can't run fail either
// way: they need the user's answer, which no earlier step provides. only `deps`
// misuse throws. nodes that already carry a transaction are skipped.
export async function hydratePlanTransactions(
  tree: PlanTree,
  userPublicKey: string,
  deps: HydrationDeps,
): Promise<{ tree: PlanTree; failures: HydrationFailure[] }> {
  if (typeof userPublicKey !== "string" || userPublicKey.length === 0) {
    throw new TypeError("hydratePlanTransactions: userPublicKey is required");
  }
  if (typeof deps.fetchSourceAccount !== "function") {
    throw new TypeError("hydratePlanTransactions: deps.fetchSourceAccount is required");
  }
  assertLedgerCloseTime("hydratePlanTransactions", deps);

  const failures: HydrationFailure[] = [];

  // one account read for the whole pass; every build gets its own copy of it
  const getSourceAccount = sourceAccountCopies(() => deps.fetchSourceAccount(userPublicKey));
  // trustlines built earlier in this pass, whose reserves that one read can't show
  const opened: OpenedLines = { count: 0 };

  for (const node of topologicalOrder(tree)) {
    if (!carriesTransaction(node) || nodeHasTransaction(node)) continue;

    try {
      await hydrateNode(node, userPublicKey, deps, getSourceAccount, opened, false);
      delete node.deferred;
    } catch (err) {
      const reason = errorMessage(err);
      const deferred = node.dependencies.length > 0 && !needsUserAnswer(err) && !final(err);
      const refusal = conversionRefusalOf(err);
      failures.push({
        nodeId: node.id,
        reason,
        deferred,
        priceImpactRefused: err instanceof PriceImpactRefusedError,
        noSoroswapRoute: err instanceof NoSoroswapRouteError,
        backstopClaimUnavailable: err instanceof BackstopEmissionsClaimError,
        ...(refusal !== undefined ? { refusal } : {}),
        ...(err instanceof BackstopEmissionsClaimError
          ? { backstopAccruedEmissions: err.accruedEmissions }
          : {}),
        error: err,
      });
      if (deferred) {
        node.deferred = { after: node.dependencies, reason };
      } else {
        node.status = "failed";
        node.error = reason;
      }
    }
  }

  return { tree, failures };
}

// Force-rebuild ONE node's transaction from fresh on-chain state: a fresh
// sequence number, a fresh simulation footprint/resource fee, and a fresh
// timebound. Called at EXECUTE time immediately before signing, so a plan that
// sat in the review step for minutes is not submitted carrying the preview-time
// sequence/footprint/5-minute timebound (which would fail as tx_bad_seq, a stale
// footprint, or an expired tx). No-op for the classic batches and the forward:
// the executor rebuilds those from fresh state itself. Throws if the rebuild
// fails (a genuinely broken step surfaces its real error rather than submitting
// a stale tx).
export async function rebuildSorobanNodeTransaction(
  node: PlanNode,
  userPublicKey: string,
  deps: HydrationDeps,
): Promise<void> {
  if (!carriesTransaction(node)) return;
  assertLedgerCloseTime("rebuildSorobanNodeTransaction", deps);
  clearTransaction(node);
  // a fresh read: the lines earlier steps opened already hold their reserves
  await hydrateNode(
    node,
    userPublicKey,
    deps,
    sourceAccountCopies(() => deps.fetchSourceAccount(userPublicKey)),
    { count: 0 },
    true,
  );
  delete node.deferred;
}

// a pass with no usable network clock can't time anything it builds, and the
// browser's clock must not stand in for it
function assertLedgerCloseTime(caller: string, deps: HydrationDeps): void {
  if (!Number.isSafeInteger(deps.ledgerCloseTime) || deps.ledgerCloseTime <= 0) {
    throw new TypeError(
      `${caller}: deps.ledgerCloseTime must be the latest ledger's close time; got ${String(deps.ledgerCloseTime)}`,
    );
  }
}

// TransactionBuilder.build() increments the source account's sequence in place,
// and the probe-then-build kinds below build twice. Sharing one AccountResponse
// made the signed tx carry seq+2 (tx_bad_seq on every submit). So the account is
// loaded once and every build gets a fresh copy pinned to the loaded sequence,
// which makes each built tx carry exactly on-chain seq + 1. The copy is a whole
// account record: the blend builders read its balances, subentries and
// sponsorship counts to size a repay and to check the BLND trustline.
function sourceAccountCopies(
  load: () => Promise<Horizon.AccountResponse>,
): () => Promise<Horizon.AccountResponse> {
  let loaded: { account: Horizon.AccountResponse; sequence: string } | null = null;
  return async () => {
    if (loaded === null) {
      const account = await load();
      loaded = { account, sequence: account.sequenceNumber() };
    }
    return new Horizon.AccountResponse({
      ...loaded.account,
      account_id: loaded.account.accountId(),
      sequence: loaded.sequence,
    } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
  };
}

interface OpenedLines {
  count: number;
}

async function hydrateNode(
  node: PlanNode,
  userPublicKey: string,
  deps: HydrationDeps,
  getSourceAccount: () => Promise<Horizon.AccountResponse>,
  opened: OpenedLines,
  rebuild: boolean,
): Promise<void> {
  try {
    await buildNode(node, userPublicKey, deps, getSourceAccount, opened, rebuild);
  } catch (err) {
    throw ExitPayoutTooLargeError.from(node, err) ?? err;
  }
}

async function buildNode(
  node: PlanNode,
  userPublicKey: string,
  deps: HydrationDeps,
  getSourceAccount: () => Promise<Horizon.AccountResponse>,
  opened: OpenedLines,
  rebuild: boolean,
): Promise<void> {
  const a = deps.adapters ?? {};
  const slippageBps = resolveConfiguredSlippageBps();
  const exitSteps = async (
    position: BlendExitPosition,
    extra: Omit<BuildExitSequenceDeps, "server" | "ledgerCloseTime"> = {},
  ): Promise<readonly BlendExitStep[]> =>
    (a.buildExitSequence ?? buildExitSequence)(
      deps.network,
      position,
      userPublicKey,
      await getSourceAccount(),
      { ...extra, server: deps.rpc, ledgerCloseTime: deps.ledgerCloseTime },
    );

  switch (node.kind) {
    case "RevokeAllowance": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildRevoke ?? buildRevoke;
      const tx = await fn(
        deps.rpc,
        node.metadata.contractId,
        userPublicKey,
        node.metadata.spender,
        deps.currentLedger,
        deps.network,
        sourceAccount,
        deps.ledgerCloseTime,
      );
      setTransaction(node, tx);
      return;
    }

    case "RepayBlend": {
      const steps = await exitSteps(
        blendPosition(node.metadata.poolId, { liabilities: [node.metadata.asset] }),
      );
      const step = steps.find((s) => s.kind === "repay" && s.asset === node.metadata.asset);
      if (step?.kind !== "repay") {
        throw new Error(
          `RepayBlend: buildExitSequence did not produce a "repay" step for asset ${node.metadata.asset}`,
        );
      }
      // the amount the built tx repays (buffered debt capped at what is spendable),
      // which the auth-tree guard checks against the encoded argument
      (node.metadata as { amount: bigint }).amount = step.amount;
      setTransaction(node, step.transaction);
      return;
    }

    case "WithdrawBlend": {
      const bucket = node.metadata.bucket;
      const steps = await exitSteps(
        blendPosition(node.metadata.poolId, { [bucket]: [node.metadata.asset] }),
      );
      const wantKind = bucket === "collateral" ? "withdraw_collateral" : "withdraw_supply";
      const step = steps.find(
        (s) =>
          (s.kind === "withdraw_collateral" || s.kind === "withdraw_supply") &&
          s.kind === wantKind &&
          s.asset === node.metadata.asset,
      );
      if (step === undefined) {
        throw new Error(
          `WithdrawBlend: buildExitSequence did not produce a "${wantKind}" step for asset ${node.metadata.asset}`,
        );
      }
      setTransaction(node, step.transaction);
      return;
    }

    case "AddBlndTrustline": {
      const blnd = blndTokenForNetwork(deps.network);
      if (blnd.issuer !== node.metadata.issuer) {
        throw new Error(
          `AddBlndTrustline: the plan's BLND issuer ${node.metadata.issuer} is not ${blnd.issuer} on ${deps.network.id}`,
        );
      }
      if (blnd.code !== node.metadata.code) {
        throw new Error(
          `AddBlndTrustline: the plan's asset code ${node.metadata.code} is not ${blnd.code}`,
        );
      }
      const account = await getSourceAccount();
      assertTrustlineReserve(node, account, deps.network, opened, "to claim the Blend emissions");
      setTransaction(
        node,
        buildTrustlineTx(
          deps.network,
          account,
          new Asset(blnd.code, blnd.issuer),
          deps.ledgerCloseTime,
        ),
      );
      opened.count += 1;
      return;
    }

    case "AddExitTrustline": {
      const md = node.metadata;
      // the Asset constructor validates the code and the issuer key
      const asset = new Asset(md.code, md.issuer);
      if (asset.contractId(deps.network.passphrase) !== md.contractId) {
        throw new Error(
          `AddExitTrustline: ${md.code}:${md.issuer} is not the asset of token ${md.contractId} ` +
            `on ${deps.network.id}`,
        );
      }
      await assertIssuerOpensAuthorized(deps.horizon, md.code, md.issuer);
      const account = await getSourceAccount();
      assertTrustlineReserve(node, account, deps.network, opened, "to exit the pool");
      setTransaction(node, buildTrustlineTx(deps.network, account, asset, deps.ledgerCloseTime));
      opened.count += 1;
      return;
    }

    case "ClaimBlendEmissions": {
      // the generator only emits a claim for discovered emission reserves
      if (node.metadata.reserveTokenIds.length === 0) {
        throw new Error("ClaimBlendEmissions: no reserve token ids to claim");
      }
      let steps: readonly BlendExitStep[];
      try {
        steps = await exitSteps(blendPosition(node.metadata.poolId, {}), {
          claimReserveIds: node.metadata.reserveTokenIds,
        });
      } catch (err) {
        if (err instanceof BlndTrustlineMissingError && err.reason === "missing") {
          throw new Error("ClaimBlendEmissions: built after the BLND trustline is added", {
            cause: err,
          });
        }
        throw err;
      }
      const step = steps.find((s) => s.kind === "claim_emissions");
      if (step === undefined) {
        throw new Error(
          `ClaimBlendEmissions: buildExitSequence did not produce a "claim_emissions" step`,
        );
      }
      setTransaction(node, step.transaction);
      return;
    }

    case "ClaimBackstopEmissions": {
      let built: Awaited<ReturnType<typeof buildBackstopClaimTx>>;
      try {
        built = await (a.buildBackstopClaimTx ?? buildBackstopClaimTx)(
          deps.network,
          { poolId: node.metadata.poolId },
          userPublicKey,
          await getSourceAccount(),
          { server: deps.rpc, ledgerCloseTime: deps.ledgerCloseTime },
        );
      } catch (err) {
        // only a claim the network refuses in simulation is a forfeit question;
        // a failed account read or rpc call is an ordinary failure
        if (err instanceof BackstopClaimUnavailableError) {
          throw new BackstopEmissionsClaimError(err);
        }
        if (err instanceof BackstopNothingAccruedError) {
          throw new BackstopEmissionsAlreadyClaimedError(node.metadata.poolId, err);
        }
        throw err;
      }
      pinBackstop(node, built.backstop.id);
      setTransaction(node, built.transaction);
      return;
    }

    case "BackstopQueue": {
      // the builder queues every share held when it runs, including shares a
      // backstop emissions claim just minted
      const built = await (a.buildBackstopQueueTx ?? buildBackstopQueueTx)(
        deps.network,
        { poolId: node.metadata.poolId },
        userPublicKey,
        await getSourceAccount(),
        { server: deps.rpc, ledgerCloseTime: deps.ledgerCloseTime },
      );
      pinBackstop(node, built.backstop.id);
      // the shares and unlock date of the built tx, read on chain at build time
      const md = node.metadata as { shares: bigint; queueEndsAt: Date };
      md.shares = built.shares;
      md.queueEndsAt = built.queueEndsAt;
      setTransaction(node, built.transaction);
      return;
    }

    case "BackstopWithdraw": {
      // withdraws whatever part of the queue has unlocked when it is built
      const built = await (a.buildBackstopWithdrawTx ?? buildBackstopWithdrawTx)(
        deps.network,
        { poolId: node.metadata.poolId },
        userPublicKey,
        await getSourceAccount(),
        { server: deps.rpc, ledgerCloseTime: deps.ledgerCloseTime },
      );
      pinBackstop(node, built.backstop.id);
      (node.metadata as { amount: bigint }).amount = built.shares;
      setTransaction(node, built.transaction);
      return;
    }

    case "WithdrawAquarius": {
      if (node.metadata.tokens.length === 0) {
        throw new Error(
          `WithdrawAquarius: metadata.tokens is empty; cannot construct withdraw call without reserve token order`,
        );
      }
      const fn = a.aquariusWithdraw ?? aquariusWithdraw;
      const poolIndex = poolIndexHexToBytes(node.metadata.poolIndex);
      // First build+simulate with zero floors to read the router's expected
      // per-token output, then rebuild with a slippage-bounded minimum so the
      // signed tx cannot silently accept near-zero output for any reserve token.
      // (The executor only signs/submits. Nothing downstream floors this.)
      const probe = await fn(
        {
          user: userPublicKey,
          tokens: node.metadata.tokens,
          poolIndex,
          shareAmount: node.metadata.shareAmount,
          minAmounts: node.metadata.tokens.map(() => 0n),
          sourceAccount: await getSourceAccount(),
          ledgerCloseTime: deps.ledgerCloseTime,
          network: deps.network,
        },
        { server: deps.rpc },
      );
      const expected = await readExpectedAmounts(deps.rpc, probe, node.metadata.tokens.length);
      const minAmounts = expected.map((e) => BigInt(applySlippageMin(e.toString(), slippageBps)));
      const tx = await fn(
        {
          user: userPublicKey,
          tokens: node.metadata.tokens,
          poolIndex,
          shareAmount: node.metadata.shareAmount,
          minAmounts,
          sourceAccount: await getSourceAccount(),
          ledgerCloseTime: deps.ledgerCloseTime,
          network: deps.network,
        },
        { server: deps.rpc },
      );
      setTransaction(node, tx);
      return;
    }

    case "WithdrawAquariusConcentrated": {
      const md = node.metadata;
      // the pool's own estimate of what the whole range pays, then the same
      // slippage floor as every other exit
      const estimate = await (a.estimateConcentratedWithdraw ?? estimateConcentratedWithdraw)(
        deps.rpc,
        deps.network,
        {
          poolAddress: md.poolAddress,
          user: userPublicKey,
          tickLower: md.tickLower,
          tickUpper: md.tickUpper,
          liquidity: md.liquidity,
        },
      );
      const minAmounts = estimate.map((e) => BigInt(applySlippageMin(e.toString(), slippageBps)));
      const tx = await (a.withdrawConcentratedPosition ?? withdrawConcentratedPosition)(
        {
          user: userPublicKey,
          poolAddress: md.poolAddress,
          tickLower: md.tickLower,
          tickUpper: md.tickUpper,
          liquidity: md.liquidity,
          minAmounts,
          sourceAccount: await getSourceAccount(),
          ledgerCloseTime: deps.ledgerCloseTime,
          network: deps.network,
        },
        { server: deps.rpc },
      );
      setTransaction(node, tx);
      return;
    }

    case "ClaimAquariusConcentratedFees": {
      const tx = await (a.claimConcentratedFees ?? claimConcentratedFees)(
        {
          user: userPublicKey,
          poolAddress: node.metadata.poolAddress,
          sourceAccount: await getSourceAccount(),
          ledgerCloseTime: deps.ledgerCloseTime,
          network: deps.network,
        },
        { server: deps.rpc },
      );
      setTransaction(node, tx);
      return;
    }

    case "ClaimAquariusGaugeRewards": {
      const md = node.metadata as { routerPool?: string };
      // the router's answer from an earlier build must not outlive this one
      delete md.routerPool;
      // the builder asks the pinned router which pool it lists for the tokens
      // and index, and refuses any other address
      const built = await (a.claimGaugeRewards ?? claimGaugeRewards)(
        {
          user: userPublicKey,
          poolAddress: node.metadata.poolAddress,
          tokens: node.metadata.tokens,
          poolIndex: node.metadata.poolIndex,
          sourceAccount: await getSourceAccount(),
          ledgerCloseTime: deps.ledgerCloseTime,
          network: deps.network,
        },
        { server: deps.rpc },
      );
      md.routerPool = built.routerPool;
      setTransaction(node, built.transaction);
      return;
    }

    case "ClaimAquariusRewards": {
      // the router resolves the pool by its token set and index
      const tx = await (a.aquariusClaim ?? aquariusClaim)(
        {
          user: userPublicKey,
          tokens: node.metadata.tokens,
          poolIndex: poolIndexHexToBytes(node.metadata.poolIndex),
          sourceAccount: await getSourceAccount(),
          ledgerCloseTime: deps.ledgerCloseTime,
          network: deps.network,
        },
        { server: deps.rpc },
      );
      setTransaction(node, tx);
      return;
    }

    case "WithdrawSoroswapLp": {
      const fn = a.removeLiquidityByContractIds ?? removeLiquidityByContractIds;
      // the router checks this against the ledger timestamp, so it is counted
      // from the ledger's clock like the tx's own time bound
      const deadline = deps.ledgerCloseTime + SOROSWAP_DEADLINE_SECONDS;
      // First build+simulate with zero floors to read remove_liquidity's expected
      // (amountA, amountB), then rebuild with slippage-bounded minimums so the
      // signed tx cannot silently accept near-zero output for either token.
      // (The executor only signs/submits. Nothing downstream floors this.)
      const probe = await fn(
        {
          tokenAAddress: node.metadata.tokenA,
          tokenBAddress: node.metadata.tokenB,
          liquidity: node.metadata.shareBalance.toString(),
          amountAMin: "0",
          amountBMin: "0",
          userAddress: userPublicKey,
          deadline,
          ledgerCloseTime: deps.ledgerCloseTime,
          network: deps.network,
        },
        { server: deps.rpc, sourceAccount: await getSourceAccount() },
      );
      const expected = await readExpectedAmounts(deps.rpc, probe, 2);
      const tx = await fn(
        {
          tokenAAddress: node.metadata.tokenA,
          tokenBAddress: node.metadata.tokenB,
          liquidity: node.metadata.shareBalance.toString(),
          amountAMin: applySlippageMin(expected[0]!.toString(), slippageBps),
          amountBMin: applySlippageMin(expected[1]!.toString(), slippageBps),
          userAddress: userPublicKey,
          deadline,
          ledgerCloseTime: deps.ledgerCloseTime,
          network: deps.network,
        },
        { server: deps.rpc, sourceAccount: await getSourceAccount() },
      );
      setTransaction(node, tx);
      return;
    }

    case "ConvertSorobanToXLM": {
      await hydrateConvert(node, userPublicKey, deps, getSourceAccount, rebuild);
      return;
    }

    case "TransferAsIs": {
      const fn = a.buildTransfer ?? buildTransfer;
      const contractId = resolveContractIdForAsset(node.metadata.asset, deps.network);
      const held = await liveTokenBalance(node, userPublicKey, deps);
      const tx = await fn(
        deps.rpc,
        contractId,
        userPublicKey,
        node.metadata.destination,
        held,
        deps.network,
        await getSourceAccount(),
        deps.ledgerCloseTime,
      );
      (node.metadata as { amount: bigint }).amount = held;
      setTransaction(node, tx);
      return;
    }

    case "ClassicUnwind":
    case "FinalClassicTx":
    case "MediatorForward":
      return;
  }
}

// the held-token swap. the route is searched first (a token may only trade
// through another one), then the whole balance and a 1/1000 reference trade are
// quoted along it. a swap over the price-impact cap needs the user's
// confirmation, and that confirmation only covers the quote the review showed:
// a rebuild whose rate fell further than the slippage tolerance is refused.
async function hydrateConvert(
  node: Extract<PlanNode, { kind: "ConvertSorobanToXLM" }>,
  userPublicKey: string,
  deps: HydrationDeps,
  getSourceAccount: () => Promise<Horizon.AccountResponse>,
  rebuild: boolean,
): Promise<void> {
  const a = deps.adapters ?? {};
  const fn = a.buildSwapToXLM ?? buildSwapToXLM;
  const slippageBps = resolveConfiguredSlippageBps();
  const md = node.metadata;
  const contractId = resolveContractIdForAsset(md.asset, deps.network);
  // the router checks this against the ledger timestamp, so it is counted from
  // the ledger's clock like the tx's own time bound
  const deadline = deps.ledgerCloseTime + SOROSWAP_DEADLINE_SECONDS;
  const held = await liveTokenBalance(node, userPublicKey, deps);
  const route = await (a.quoteRouteToXLM ?? quoteRouteToXLM)(deps.rpc, {
    assetIn: md.asset,
    amountIn: held,
    network: deps.network,
    sourcePublicKey: userPublicKey,
  });
  const path = route.path;
  // swap_exact_tokens_for_tokens returns the amount vector along the path, so a
  // zero-floor probe reads the router's expected XLM out (the last element)
  const quoteSwap = async (amount: bigint): Promise<{ in: bigint; out: bigint }> => {
    const probe = await fn(
      {
        assetIn: md.asset,
        amountIn: amount.toString(),
        amountOutMin: "0",
        userAddress: userPublicKey,
        deadline,
        ledgerCloseTime: deps.ledgerCloseTime,
        network: deps.network,
        path,
      },
      { server: deps.rpc, sourceAccount: await getSourceAccount() },
    );
    const amounts = await readExpectedAmounts(deps.rpc, probe, path.length);
    return { in: amounts[0]!, out: amounts[amounts.length - 1]! };
  };
  const full = await quoteSwap(held);
  // refuse a swap the router prices at zero output rather than sign the token
  // away for free; the token is then left in place
  if (full.out <= 0n) {
    throw new Error(
      `ConvertSorobanToXLM: router quoted zero XLM out for ${held.toString()}; ` +
        `refusing to swap the token away for free`,
    );
  }
  const reference = await quoteSwap(referenceTradeAmount(held));
  const impact = priceImpactBps(full.in, full.out, reference.in, reference.out);
  const reviewed = md.reviewedQuote;
  const refuse = (reason: ConversionRefusal, message: string): never => {
    throw new PriceImpactRefusedError(message, {
      contractId,
      reason,
      amountIn: full.in,
      expectedOut: full.out,
      priceImpactBps: impact,
    });
  };
  // a confirmation given at review holds only for the quote the review showed;
  // an execute-time build that never had one is held to the cap again
  const accepted = md.priceImpactAccepted === true && (!rebuild || reviewed !== undefined);
  if (!accepted) {
    if (impact === null) {
      refuse(
        "unpriced",
        `ConvertSorobanToXLM: the router can't price a reference trade for this token, ` +
          `so the swap's price impact is unknown; confirm the conversion to sell it anyway`,
      );
    } else if (impact > MAX_PRICE_IMPACT_BPS) {
      refuse(
        "price_impact",
        `ConvertSorobanToXLM: selling the whole balance has a ${formatBps(impact)} price ` +
          `impact, over the ${formatBps(MAX_PRICE_IMPACT_BPS)} cap; confirm the conversion ` +
          `to sell it anyway`,
      );
    }
  }
  if (reviewed !== undefined && rateBelow(reviewed, full, slippageBps)) {
    refuse(
      "requote_worse",
      `ConvertSorobanToXLM: the swap now returns ${full.out.toString()} XLM stroops for ` +
        `${full.in.toString()}, worse than the reviewed ${reviewed.expectedOut.toString()} for ` +
        `${reviewed.amountIn.toString()} by more than the ${formatBps(slippageBps)} tolerance`,
    );
  }
  const amountOutMin = applySlippageMin(full.out.toString(), slippageBps);
  const tx = await fn(
    {
      assetIn: md.asset,
      amountIn: held.toString(),
      amountOutMin,
      userAddress: userPublicKey,
      deadline,
      ledgerCloseTime: deps.ledgerCloseTime,
      network: deps.network,
      path,
    },
    { server: deps.rpc, sourceAccount: await getSourceAccount() },
  );
  const quote: SwapQuote = {
    amountIn: held,
    expectedOut: full.out,
    minOut: BigInt(amountOutMin),
    priceImpactBps: impact,
    path,
  };
  const writable = md as { amount: bigint; quote?: SwapQuote; reviewedQuote?: SwapQuote };
  writable.amount = held;
  writable.quote = quote;
  writable.reviewedQuote ??= quote;
  setTransaction(node, tx);
}

// fresh out/in below reviewed out/in by more than the tolerance
function rateBelow(
  reviewed: SwapQuote,
  fresh: { readonly in: bigint; readonly out: bigint },
  toleranceBps: number,
): boolean {
  if (reviewed.amountIn <= 0n || fresh.in <= 0n) return true;
  return (
    fresh.out * reviewed.amountIn * 10_000n <
    reviewed.expectedOut * fresh.in * BigInt(10_000 - toleranceBps)
  );
}

// the kinds hydration builds a transaction for
function carriesTransaction(node: PlanNode): boolean {
  return (
    node.kind !== "ClassicUnwind" &&
    node.kind !== "FinalClassicTx" &&
    node.kind !== "MediatorForward"
  );
}

function nodeHasTransaction(node: PlanNode): boolean {
  return (node.metadata as { transaction?: Transaction }).transaction !== undefined;
}

// clears a node's attached transaction so a rebuild re-derives it from fresh
// state. delete (not = undefined): exactOptionalPropertyTypes forbids assigning
// undefined to an optional property, and nodeHasTransaction tests for the key
// being absent.
function clearTransaction(node: PlanNode): void {
  delete (node.metadata as { transaction?: Transaction }).transaction;
}

// readonly metadata is the documented hydration point; cast through unknown
function setTransaction(node: PlanNode, tx: Transaction): void {
  (node.metadata as { transaction?: Transaction }).transaction = tx;
}

// a backstop step names the backstop its pool uses. the first build records it
// (unless discovery already did) and every later build must target the same one,
// since the auth-tree guard pins the call to it
function pinBackstop(
  node: Extract<
    PlanNode,
    { kind: "ClaimBackstopEmissions" | "BackstopQueue" | "BackstopWithdraw" }
  >,
  built: string,
): void {
  const planned = node.metadata.backstopId;
  if (planned !== undefined && planned !== built) {
    throw new Error(
      `${node.kind}: the pool's backstop is now ${built}, not the backstop ${planned} the plan named`,
    );
  }
  (node.metadata as { backstopId?: string }).backstopId = built;
}

// a new trustline locks one base reserve, and the change_trust pays its fee bid
// out of the same free XLM. checked when the step is built (at review and again
// right before signing), so a short account learns how much to add instead of
// failing the step on chain with op_low_reserve. the lines built earlier in the
// same pass were read off the same account, so their reserves are counted too.
function assertTrustlineReserve(
  node: Extract<PlanNode, { kind: "AddBlndTrustline" | "AddExitTrustline" }>,
  account: Horizon.AccountResponse,
  network: NetworkConfig,
  opened: OpenedLines,
  purpose: string,
): void {
  const native = Asset.native().contractId(network.passphrase);
  const free = spendableFromAccount(account, native, network)?.spendable ?? 0n;
  const lines = BigInt(opened.count + 1);
  const needed = lines * (BASE_RESERVE_STROOPS + BigInt(SOROBAN_INCLUSION_FEE));
  if (free < needed) {
    const each =
      lines === 1n ? "" : ` for each of the ${lines.toString()} trustlines this close opens`;
    throw new Error(
      `${node.kind}: opening the ${node.metadata.code} trustline needs ` +
        `${stroopsToDecimal(needed)} XLM free (0.5 XLM reserve plus the fee${each}), and the ` +
        `account has ${stroopsToDecimal(free)}; add XLM ${purpose}`,
    );
  }
}

// core opens a trustline authorized only when its issuer exists and has no
// auth_required flag (ChangeTrustOpFrame: NO_ISSUER, else AUTHORIZED_FLAG
// unless isAuthRequired). a line opened unauthorized can't take the SAC payout,
// so the exit would still trap after the reserve was locked; that is refused
// before anything is signed.
async function assertIssuerOpensAuthorized(
  horizon: Horizon.Server,
  code: string,
  issuer: string,
): Promise<void> {
  let account: Horizon.AccountResponse;
  try {
    account = await withHorizonRetry(() => horizon.loadAccount(issuer));
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new Error(
        `AddExitTrustline: the issuer of ${code} (${issuer}) does not exist, so no trustline ` +
          `can be opened for the payout; this position can't be exited into this account`,
        { cause: err },
      );
    }
    throw err;
  }
  if (account.flags.auth_required) {
    throw new Error(
      `AddExitTrustline: the issuer of ${code} requires authorization, so a new ${code} ` +
        `trustline can't take the payout until the issuer authorizes it; ask the issuer to ` +
        `authorize a line for this account, or exit that position outside this app, before closing`,
    );
  }
}

export function resolveContractIdForAsset(asset: AssetIdentifier, network: NetworkConfig): string {
  switch (asset.kind) {
    case "native":
      return Asset.native().contractId(network.passphrase);
    case "credit":
      return new Asset(asset.code, asset.issuer).contractId(network.passphrase);
    case "liquidity_pool_shares":
      throw new TypeError(
        "TransferAsIs: liquidity_pool_shares cannot be transferred as a SEP-41 asset; use removeLiquidity",
      );
    case "contract":
      // a standalone SEP-41 token: the contract id IS the address to invoke
      return asset.contractId;
  }
}

// the account's balance of a swept token right now. Exits that ran earlier in the
// close may have paid more of it in, so the sweep moves what is there, not the
// amount seen at discovery.
async function liveTokenBalance(
  node: Extract<PlanNode, { kind: "TransferAsIs" | "ConvertSorobanToXLM" }>,
  userPublicKey: string,
  deps: HydrationDeps,
): Promise<bigint> {
  const read = deps.adapters?.readTokenBalance ?? readTokenBalance;
  const contractId = resolveContractIdForAsset(node.metadata.asset, deps.network);
  const held = await read(deps.rpc, contractId, userPublicKey, userPublicKey, deps.network);
  if (held <= 0n) throw new NothingToSweepError(node.kind, contractId);
  return held;
}

// the account holds none of a token its sweep was planned for: an exit that paid
// nothing, or a token moved out since review. there is nothing to send, so
// nothing is left behind either.
export class NothingToSweepError extends Error {
  readonly contractId: string;
  constructor(kind: string, contractId: string) {
    super(`${kind}: the account holds none of token ${contractId} to move`);
    this.name = "NothingToSweepError";
    this.contractId = contractId;
  }
}

export type ConversionRefusal = "price_impact" | "unpriced" | "requote_worse";

// a conversion refused for its price: over the impact cap, unpriceable against a
// reference, or worse than the quote the user reviewed. it is built only once
// the user answers for that token (accept the new rate, send it as-is, or leave
// it), and the quote it carries is what to show them.
export class PriceImpactRefusedError extends Error {
  readonly contractId?: string;
  readonly reason?: ConversionRefusal;
  readonly amountIn?: bigint;
  readonly expectedOut?: bigint;
  readonly priceImpactBps?: number | null;
  constructor(
    message: string,
    detail?: {
      readonly contractId: string;
      readonly reason: ConversionRefusal;
      readonly amountIn: bigint;
      readonly expectedOut: bigint;
      readonly priceImpactBps: number | null;
    },
  ) {
    super(message);
    this.name = "PriceImpactRefusedError";
    if (detail !== undefined) {
      this.contractId = detail.contractId;
      this.reason = detail.reason;
      this.amountIn = detail.amountIn;
      this.expectedOut = detail.expectedOut;
      this.priceImpactBps = detail.priceImpactBps;
    }
  }
}

// the backstop emissions claim fails in simulation (on mainnet the BLND-USDC
// comet deposit it makes currently traps). the review shows the accrued BLND and
// asks the user to forfeit it, then the queue runs without the claim. the message
// is one line for the review; the simulation's diagnostic log stays in
// simulationError.
export class BackstopEmissionsClaimError extends Error {
  readonly poolId: string;
  readonly backstopId: string;
  // BLND, 7 decimals, read on chain when the claim was simulated
  readonly accruedEmissions: bigint;
  readonly simulationError: string;
  constructor(cause: BackstopClaimUnavailableError) {
    super(
      `ClaimBackstopEmissions: the ${stroopsToDecimal(cause.accruedEmissions)} BLND of backstop ` +
        `emissions accrued for pool ${cause.poolId} can't be claimed right now (the claim fails ` +
        `in simulation); forfeit them to queue the withdrawal without the claim`,
      { cause },
    );
    this.name = "BackstopEmissionsClaimError";
    this.poolId = cause.poolId;
    this.backstopId = cause.backstopId;
    this.accruedEmissions = cause.accruedEmissions;
    this.simulationError = cause.simulationError;
  }
}

// the plan has a backstop claim because discovery saw accrued BLND, and the
// build finds none: it was claimed elsewhere in between. nothing is forfeited,
// but the plan no longer matches the chain, so the review has to run again.
export class BackstopEmissionsAlreadyClaimedError extends Error {
  readonly poolId: string;
  constructor(poolId: string, cause: Error) {
    super(
      `ClaimBackstopEmissions: the backstop emissions for pool ${poolId} were claimed since ` +
        `the account was read, so there is nothing left to claim; review the close again`,
      { cause },
    );
    this.name = "BackstopEmissionsAlreadyClaimedError";
    this.poolId = poolId;
  }
}

// a step whose payout to the account is larger than any trustline balance
// (int64 stroops): the asset's SAC refuses it with Error(Contract, #12),
// "received amount is too large for an i64" (soroban-env-host
// stellar_asset_contract/balance.rs). a trustline can never hold it, so no
// earlier step or retry fixes it. read off the simulation's event log, since
// the builders throw the rpc's error text.
export class ExitPayoutTooLargeError extends Error {
  readonly token: string;
  // the amount the SAC was asked to credit, when the log shows the transfer
  readonly amount: bigint | undefined;
  constructor(node: PlanNode, token: string, amount: bigint | undefined, cause: unknown) {
    const paid = amount !== undefined ? `${stroopsToDecimal(amount)} of ` : "more of ";
    super(
      `${node.kind}: this exit would pay ${paid}token ${token} into the account, more than a ` +
        `Stellar trustline can hold (at most ${stroopsToDecimal(INT64_MAX)}), so the position ` +
        `can't be withdrawn into this account and the close can't include it`,
      { cause },
    );
    this.name = "ExitPayoutTooLargeError";
    this.token = token;
    this.amount = amount;
  }

  static from(node: PlanNode, err: unknown): ExitPayoutTooLargeError | undefined {
    if (!(err instanceof Error)) return undefined;
    const overflow = PAYOUT_OVERFLOW.exec(err.message);
    if (overflow === null) return undefined;
    const token = overflow[1]!;
    const transfer = new RegExp(
      `topics:\\[fn_call, ${token}, transfer\\], data:\\[C[A-Z2-7]{55}, [GC][A-Z2-7]{55}, (\\d+)\\]`,
    ).exec(err.message);
    return new ExitPayoutTooLargeError(
      node,
      token,
      transfer !== null ? BigInt(transfer[1]!) : undefined,
      err,
    );
  }
}

const PAYOUT_OVERFLOW =
  /contract:(C[A-Z2-7]{55}), topics:\[error, Error\(Contract, #12\)\], data:"received amount is too large for an i64"/;
const INT64_MAX = 9_223_372_036_854_775_807n;

// failures no earlier step or answer can resolve
function final(err: unknown): boolean {
  return err instanceof ExitPayoutTooLargeError;
}

function conversionRefusalOf(err: unknown): ConversionRefusal | "no_route" | undefined {
  if (err instanceof NoSoroswapRouteError) return "no_route";
  if (err instanceof PriceImpactRefusedError) return err.reason;
  return undefined;
}

// failures no earlier step can resolve: they wait on the user
function needsUserAnswer(err: unknown): boolean {
  return (
    err instanceof PriceImpactRefusedError ||
    err instanceof NoSoroswapRouteError ||
    err instanceof BackstopEmissionsClaimError ||
    err instanceof BackstopEmissionsAlreadyClaimedError ||
    // a BLND line the issuer has not authorized: no step in the plan fixes it
    (err instanceof BlndTrustlineMissingError && err.reason === "unauthorized")
  );
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

// re-simulate an already-assembled withdraw/remove_liquidity/swap tx to read the
// expected per-token amount vector. returns exactly `count` non-negative bigints.
// throws (rather than falling back to a zero floor) if the retval is missing or
// the wrong shape: an exit that cannot be quoted must not be signed with an
// all-accepting minimum.
async function readExpectedAmounts(
  server: rpc.Server,
  tx: Transaction,
  count: number,
): Promise<bigint[]> {
  const sim = await simulate(server, tx);
  if (!sim.ok) {
    throw new Error(`could not simulate withdraw to derive slippage floor: ${sim.error}`);
  }
  if (sim.retval === null) {
    throw new Error("withdraw simulation returned no value; cannot derive slippage floor");
  }
  const native = scValToNative(sim.retval) as unknown;
  if (!Array.isArray(native) || native.length !== count) {
    throw new Error(
      `withdraw simulation returned an unexpected shape; expected a ${count}-element amount vector`,
    );
  }
  return native.map((v, i) => {
    const n = typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : null;
    if (n === null || n < 0n) {
      throw new Error(`withdraw simulation returned a non-integer amount at index ${i}`);
    }
    return n;
  });
}

// the assets to unwind in one pool. the builders read every amount, the pool
// version and the backstop on chain, so only the keys matter; 1n marks a key
function blendPosition(
  poolId: string,
  keys: {
    readonly liabilities?: readonly string[];
    readonly collateral?: readonly string[];
    readonly supply?: readonly string[];
  },
): BlendExitPosition {
  const mark = (assets: readonly string[] | undefined): Map<string, bigint> =>
    new Map((assets ?? []).map((asset) => [asset, 1n] as const));
  return {
    poolId,
    liabilities: mark(keys.liabilities),
    collateral: mark(keys.collateral),
    supply: mark(keys.supply),
  };
}
