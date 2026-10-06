// walks the plan tree and attaches an unsigned transaction to every soroban node

import {
  Account,
  Asset,
  scValToNative,
  type Horizon,
  type Transaction,
  type rpc,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import type { BlendUserPositions } from "@/lib/adapters/blend/client";
import { buildExitSequence } from "@/lib/adapters/blend/exit";
import {
  claim as aquariusClaim,
  withdraw as aquariusWithdraw,
} from "@/lib/adapters/aquarius/client";
import { poolIndexHexToBytes } from "@/lib/adapters/aquarius/pools";
import { removeLiquidityByContractIds } from "@/lib/adapters/soroswap/lp";
import { buildSwapToXLM } from "@/lib/adapters/soroswap/swap";
import { buildRevoke } from "@/lib/soroban/allowances";
import { balance as readTokenBalance, buildTransfer } from "@/lib/soroban/sep41";
import { simulate } from "@/lib/soroban/simulate";
import { applySlippageMin, resolveConfiguredSlippageBps } from "@/lib/safety/slippage";
import type { AssetIdentifier } from "@/lib/types/account";
import {
  MAX_PRICE_IMPACT_BPS,
  priceImpactBps,
  referenceTradeAmount,
} from "@/lib/plan/price-impact";

import type { PlanNode, PlanTree } from "./tree";
import { topologicalOrder } from "./tree";

export interface HydrationFailure {
  readonly nodeId: string;
  readonly reason: string;
  // the node runs after other steps, so this failure against today's state is
  // not final: the node stays pending and is built at execute time
  readonly deferred: boolean;
}

export interface HydrationDeps {
  readonly rpc: rpc.Server;
  readonly horizon: Horizon.Server;
  readonly network: NetworkConfig;
  readonly currentLedger: number;
  readonly fetchSourceAccount: (publicKey: string) => Promise<Horizon.AccountResponse>;
  // adapter overrides for tests; prod leaves this undefined
  readonly adapters?: HydrationAdapterOverrides;
}

export interface HydrationAdapterOverrides {
  readonly buildRevoke?: typeof buildRevoke;
  readonly buildExitSequence?: typeof buildExitSequence;
  readonly aquariusWithdraw?: typeof aquariusWithdraw;
  readonly aquariusClaim?: typeof aquariusClaim;
  readonly removeLiquidityByContractIds?: typeof removeLiquidityByContractIds;
  readonly buildSwapToXLM?: typeof buildSwapToXLM;
  readonly buildTransfer?: typeof buildTransfer;
  readonly readTokenBalance?: typeof readTokenBalance;
}

// per-node failures populate `failures[]`. A node with no dependencies is marked
// "failed". A node that runs after other steps (a collateral withdraw behind its
// repay, a sweep behind the exits that pay it) is simulated here against state
// those steps haven't changed yet, so its failure only defers it: it stays
// "pending" with node.deferred set and is built at execute time once they land.
// A swap refused for its price impact fails either way: it needs the user's
// confirmation, which no earlier step provides. only `deps` misuse throws. idempotent: nodes with a transaction are skipped
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

  const failures: HydrationFailure[] = [];

  // one account read for the whole pass; every build gets its own copy of it
  const getSourceAccount = sourceAccountCopies(() => deps.fetchSourceAccount(userPublicKey));

  for (const node of topologicalOrder(tree)) {
    if (nodeHasTransaction(node)) continue;

    // classic-only nodes are constructed by the classic builder at submit time
    if (node.kind === "FinalClassicTx" || node.kind === "MediatorForward") {
      continue;
    }

    try {
      await hydrateNode(node, userPublicKey, deps, getSourceAccount);
      delete node.deferred;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // a price-impact refusal waits on the user's confirmation, not on an
      // earlier step, so it never defers
      const deferred = node.dependencies.length > 0 && !(err instanceof PriceImpactRefusedError);
      failures.push({ nodeId: node.id, reason, deferred });
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

// Force-rebuild ONE Soroban node's transaction from fresh on-chain state: a fresh
// sequence number, a fresh simulation footprint/resource fee, and a fresh
// timebound. Called at EXECUTE time immediately before signing, so a plan that
// sat in the review step for minutes is not submitted carrying the preview-time
// sequence/footprint/5-minute timebound (which would fail as tx_bad_seq, a stale
// footprint, or an expired tx). No-op for classic/forward nodes: the executor
// rebuilds the FinalClassicTx from fresh state itself and the MediatorForward is
// re-minted per run. Throws if the rebuild's simulation fails (a genuinely broken
// step surfaces its real error rather than submitting a stale tx).
export async function rebuildSorobanNodeTransaction(
  node: PlanNode,
  userPublicKey: string,
  deps: HydrationDeps,
): Promise<void> {
  if (node.kind === "FinalClassicTx" || node.kind === "MediatorForward") return;
  clearTransaction(node);
  await hydrateNode(
    node,
    userPublicKey,
    deps,
    sourceAccountCopies(() => deps.fetchSourceAccount(userPublicKey)),
  );
  delete node.deferred;
}

// TransactionBuilder.build() increments the source account's sequence in place,
// and the probe-then-build kinds below build twice. Sharing one AccountResponse
// made the signed tx carry seq+2 (tx_bad_seq on every submit). So the account is
// loaded once and every build gets a fresh copy pinned to the loaded sequence,
// which makes each built tx carry exactly on-chain seq + 1.
function sourceAccountCopies(
  load: () => Promise<Horizon.AccountResponse>,
): () => Promise<Horizon.AccountResponse> {
  let account: Horizon.AccountResponse | null = null;
  return async () => {
    account ??= await load();
    // builders only use the TransactionSource surface (accountId, sequenceNumber,
    // incrementSequenceNumber), which Account provides
    return new Account(
      account.accountId(),
      account.sequenceNumber(),
    ) as unknown as Horizon.AccountResponse;
  };
}

async function hydrateNode(
  node: PlanNode,
  userPublicKey: string,
  deps: HydrationDeps,
  getSourceAccount: () => Promise<Horizon.AccountResponse>,
): Promise<void> {
  const a = deps.adapters ?? {};
  const slippageBps = resolveConfiguredSlippageBps();

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
      );
      setTransaction(node, tx);
      return;
    }

    case "RepayBlend": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildExitSequence ?? buildExitSequence;
      const position = synthesizeBlendPositionForRepay(node.metadata);
      const steps = await fn(deps.network, position, userPublicKey, sourceAccount);
      const step = steps.find((s) => s.kind === "repay" && s.asset === node.metadata.asset);
      if (!step || step.kind !== "repay") {
        throw new Error(
          `RepayBlend: buildExitSequence did not produce a "repay" step for asset ${node.metadata.asset}`,
        );
      }
      setTransaction(node, step.transaction);
      return;
    }

    case "WithdrawBlend": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildExitSequence ?? buildExitSequence;
      const position = synthesizeBlendPositionForWithdraw(node.metadata);
      const steps = await fn(deps.network, position, userPublicKey, sourceAccount);
      const wantKind =
        node.metadata.bucket === "collateral" ? "withdraw_collateral" : "withdraw_supply";
      const step = steps.find(
        (s) => s.kind === wantKind && (s as { asset?: string }).asset === node.metadata.asset,
      );
      if (!step || (step.kind !== "withdraw_collateral" && step.kind !== "withdraw_supply")) {
        throw new Error(
          `WithdrawBlend: buildExitSequence did not produce a "${wantKind}" step for asset ${node.metadata.asset}`,
        );
      }
      setTransaction(node, step.transaction);
      return;
    }

    case "ClaimBlendEmissions": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildExitSequence ?? buildExitSequence;
      // the generator only emits a claim for discovered emission reserves
      if (node.metadata.reserveTokenIds.length === 0) {
        throw new Error("ClaimBlendEmissions: no reserve token ids to claim");
      }
      const position = synthesizeBlendPositionForPool(node.metadata);
      const steps = await fn(deps.network, position, userPublicKey, sourceAccount, {
        claimReserveIds: node.metadata.reserveTokenIds,
      });
      const step = steps.find((s) => s.kind === "claim_emissions");
      if (!step || step.kind !== "claim_emissions") {
        throw new Error(
          `ClaimBlendEmissions: buildExitSequence did not produce a "claim_emissions" step`,
        );
      }
      setTransaction(node, step.transaction);
      return;
    }

    case "BackstopQueue": {
      const sourceAccount = await getSourceAccount();
      const fn = a.buildExitSequence ?? buildExitSequence;
      const position = synthesizeBlendPositionForPool(node.metadata);
      const steps = await fn(deps.network, position, userPublicKey, sourceAccount, {
        backstopShares: node.metadata.shares,
      });
      const step = steps.find((s) => s.kind === "backstop_queue_withdrawal");
      if (!step || step.kind !== "backstop_queue_withdrawal") {
        throw new Error(
          `BackstopQueue: buildExitSequence did not produce a "backstop_queue_withdrawal" step`,
        );
      }
      setTransaction(node, step.transaction);
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
          network: deps.network,
        },
        { server: deps.rpc },
      );
      setTransaction(node, tx);
      return;
    }

    case "ClaimAquariusRewards": {
      const sourceAccount = await getSourceAccount();
      const fn = a.aquariusClaim ?? aquariusClaim;
      // the router's claim takes the pool's tokens as well as its index; the
      // tokens ride along so the adapter can encode them
      const claimArgs: Parameters<typeof fn>[0] & { readonly tokens: readonly string[] } = {
        user: userPublicKey,
        tokens: node.metadata.tokens,
        poolIndex: poolIndexHexToBytes(node.metadata.poolIndex),
        sourceAccount,
        network: deps.network,
      };
      const tx = await fn(claimArgs, { server: deps.rpc });
      setTransaction(node, tx);
      return;
    }

    case "WithdrawSoroswapLp": {
      const fn = a.removeLiquidityByContractIds ?? removeLiquidityByContractIds;
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min
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
          network: deps.network,
        },
        { server: deps.rpc, sourceAccount: await getSourceAccount() },
      );
      setTransaction(node, tx);
      return;
    }

    case "ConvertSorobanToXLM": {
      const fn = a.buildSwapToXLM ?? buildSwapToXLM;
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min
      const held = await liveTokenBalance(node, userPublicKey, deps);
      const amountIn = held.toString();
      // swap_exact_tokens_for_tokens returns the amount vector along the path, so a
      // zero-floor probe reads the router's expected XLM out; the signed swap then
      // carries a slippage-bounded minimum.
      const quoteSwap = async (amount: string): Promise<{ in: bigint; out: bigint }> => {
        const probe = await fn(
          {
            assetIn: node.metadata.asset,
            amountIn: amount,
            amountOutMin: "0",
            userAddress: userPublicKey,
            deadline,
            network: deps.network,
          },
          { server: deps.rpc, sourceAccount: await getSourceAccount() },
        );
        const [quotedIn, quotedOut] = await readExpectedAmounts(deps.rpc, probe, 2);
        return { in: quotedIn!, out: quotedOut! };
      };
      const full = await quoteSwap(amountIn);
      // refuse a swap the router prices at zero output rather than sign the
      // token away for free; the token is then left in place
      if (full.out <= 0n) {
        throw new Error(
          `ConvertSorobanToXLM: router quoted zero XLM out for ${amountIn}; ` +
            `refusing to swap the token away for free`,
        );
      }
      // the whole balance goes through one pair, so its rate is checked against a
      // small reference trade in the same pair before anything is signed
      const reference = await quoteSwap(referenceTradeAmount(held).toString());
      const impact = priceImpactBps(full.in, full.out, reference.in, reference.out);
      if (node.metadata.priceImpactAccepted !== true) {
        if (impact === null) {
          throw new PriceImpactRefusedError(
            `ConvertSorobanToXLM: the router can't price a reference trade for this token, ` +
              `so the swap's price impact is unknown; confirm the conversion to sell it anyway`,
          );
        }
        if (impact > MAX_PRICE_IMPACT_BPS) {
          throw new PriceImpactRefusedError(
            `ConvertSorobanToXLM: selling the whole balance has a ${formatBps(impact)} price ` +
              `impact, over the ${formatBps(MAX_PRICE_IMPACT_BPS)} cap; confirm the conversion ` +
              `to sell it anyway`,
          );
        }
      }
      const amountOutMin = applySlippageMin(full.out.toString(), slippageBps);
      const tx = await fn(
        {
          assetIn: node.metadata.asset,
          amountIn,
          amountOutMin,
          userAddress: userPublicKey,
          deadline,
          network: deps.network,
        },
        { server: deps.rpc, sourceAccount: await getSourceAccount() },
      );
      const md = node.metadata as { amount: bigint; quote?: unknown };
      md.amount = held;
      md.quote = { expectedOut: full.out, minOut: BigInt(amountOutMin), priceImpactBps: impact };
      setTransaction(node, tx);
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
      );
      (node.metadata as { amount: bigint }).amount = held;
      setTransaction(node, tx);
      return;
    }

    case "FinalClassicTx":
    case "MediatorForward":
      return;
  }
}

function nodeHasTransaction(node: PlanNode): boolean {
  switch (node.kind) {
    case "RevokeAllowance":
    case "RepayBlend":
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
    case "ConvertSorobanToXLM":
    case "TransferAsIs":
    case "BackstopQueue":
      return node.metadata.transaction !== undefined;
    case "FinalClassicTx":
    case "MediatorForward":
      return true; // never hydrated; treat as already done
  }
}

// clears a soroban node's attached transaction so a rebuild re-derives it from
// fresh state. mirror of setTransaction; no-op for classic/forward kinds.
function clearTransaction(node: PlanNode): void {
  switch (node.kind) {
    case "RevokeAllowance":
    case "RepayBlend":
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
    case "ConvertSorobanToXLM":
    case "TransferAsIs":
    case "BackstopQueue": {
      const md = node.metadata as { transaction?: Transaction };
      // delete (not = undefined): exactOptionalPropertyTypes forbids assigning
      // undefined to an optional property, and nodeHasTransaction tests for the
      // key being absent.
      delete md.transaction;
      return;
    }
    case "FinalClassicTx":
    case "MediatorForward":
      return;
  }
}

// readonly metadata is the documented hydration point; cast through unknown
function setTransaction(node: PlanNode, tx: Transaction): void {
  switch (node.kind) {
    case "RevokeAllowance":
    case "RepayBlend":
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
    case "ConvertSorobanToXLM":
    case "TransferAsIs":
    case "BackstopQueue": {
      const md = node.metadata as { transaction?: Transaction };
      md.transaction = tx;
      return;
    }
    case "FinalClassicTx":
    case "MediatorForward":
      return;
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
  if (held <= 0n) {
    throw new Error(`${node.kind}: the account holds none of token ${contractId} to move`);
  }
  return held;
}

// a conversion refused for its price impact (or an unpriceable reference). It
// is built only once the user confirms selling at that price.
export class PriceImpactRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceImpactRefusedError";
  }
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

// re-simulate an already-assembled withdraw/remove_liquidity tx to read the
// router's expected per-token output vector. returns exactly `count`
// non-negative bigints. throws (rather than falling back to a zero floor) if
// the retval is missing or the wrong shape: a withdraw that cannot be quoted
// must not be signed with an all-accepting minimum.
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

// blend position synthesizers. buildExitSequence wants a full BlendUserPositions

function synthesizeBlendPositionForRepay(metadata: {
  readonly poolId: string;
  readonly asset: string;
  readonly amount: bigint;
}): BlendUserPositions {
  return {
    poolId: metadata.poolId,
    poolName: metadata.poolId,
    poolVersion: "V2",
    liabilities: new Map([[metadata.asset, metadata.amount]]),
    collateral: new Map(),
    supply: new Map(),
    emissions: new Map(),
  };
}

function synthesizeBlendPositionForWithdraw(metadata: {
  readonly poolId: string;
  readonly asset: string;
  readonly bucket: "collateral" | "supply";
}): BlendUserPositions {
  // exit sequencer skips amount <= 0n; seed with 1n and filter on the way out
  const map = new Map([[metadata.asset, 1n]]);
  return {
    poolId: metadata.poolId,
    poolName: metadata.poolId,
    poolVersion: "V2",
    liabilities: new Map(),
    collateral: metadata.bucket === "collateral" ? map : new Map(),
    supply: metadata.bucket === "supply" ? map : new Map(),
    emissions: new Map(),
  };
}

// the claim targets the reserve ids passed as claimReserveIds, and the backstop
// queue its share amount, so both only need the pool
function synthesizeBlendPositionForPool(metadata: { readonly poolId: string }): BlendUserPositions {
  return {
    poolId: metadata.poolId,
    poolName: metadata.poolId,
    poolVersion: "V2",
    liabilities: new Map(),
    collateral: new Map(),
    supply: new Map(),
    emissions: new Map(),
  };
}
