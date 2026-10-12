// soroswap router swap: convert a soroban token to XLM with a direct
// swap_exact_tokens_for_tokens call on the SoroswapRouter.
//
// this is the allow-list-safe conversion path that also works on testnet. the
// soroswap aggregator is addressed dynamically by the soroswap backend
// (SoroswapSDK.getContractAddress) and is not deployed on testnet, so it cannot
// be a pinned allow-list entry the way this app's security model requires. the
// router is pinned on both networks, so conversions go through it (soroswap
// liquidity only).
//
// many tokens have no direct XLM pair (on mainnet 40 of the 88 paired tokens
// trade only against something else), so quoteRouteToXLM searches the factory's
// pair graph for the direct path and every one-hop path through a token paired
// with both sides, quotes each with router_get_amounts_out, and returns the best.
// a token with no usable route gets a NoSoroswapRouteError, never a guessed path.
import {
  Asset,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
  type TransactionSource,
} from "@stellar/stellar-sdk";

import { isAllowedRootTarget } from "@/lib/config/contracts";
import {
  getSoroswapRouterId,
  resolveAssetAddress,
  validateDeadline,
  validateIntegerAmount,
} from "@/lib/adapters/soroswap/router";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import { ledgerMaxTime } from "@/lib/stellar/ledger-clock";
import type { NetworkConfig } from "@/lib/config/networks";
import {
  address as scvAddress,
  fromScValI128,
  i128 as scvI128,
  vec as scvVec,
} from "@/lib/soroban/scval";
import {
  assembleSubmittable,
  simulateRead,
  SimulationError,
  SOROBAN_INCLUSION_FEE,
} from "@/lib/soroban/simulate";
import { loadSoroswapPairs, type SoroswapPairInfo } from "@/lib/adapters/soroswap/discovery";
import type { AssetIdentifier } from "@/lib/types/account";

const FIVE_MINUTES_SECONDS = 300;
const CALLER = "buildSwapToXLM";
// a path longer than token -> hop -> XLM is not searched
const MAX_PATH_LENGTH = 3;
// bound on one-hop candidates quoted per conversion, best-funded first
const MAX_INTERMEDIATE_CANDIDATES = 8;

export interface SwapToXLMArgs {
  readonly assetIn: AssetIdentifier;
  // smallest-units integer amount to swap in
  readonly amountIn: string;
  // minimum XLM out (stroops) the swap will accept; below this it reverts on-chain
  readonly amountOutMin: string;
  readonly userAddress: string;
  // unix seconds; the router compares against env.ledger().timestamp()
  readonly deadline: number;
  // close time (unix seconds) of the latest ledger; the tx expires five minutes
  // after it
  readonly ledgerCloseTime: number;
  readonly network: NetworkConfig;
  // the route from quoteRouteToXLM, assetIn first and XLM last. omitted means the
  // direct [assetIn, XLM] pair
  readonly path?: readonly string[];
}

export interface SwapToXLMDeps {
  readonly server: rpc.Server;
  readonly sourceAccount: TransactionSource;
  readonly assemble?: typeof assembleSubmittable;
}

// build a router swap_exact_tokens_for_tokens converting assetIn -> XLM along
// `path`. allow-list-gated on build and after assembly, like the LP-removal builder.
export async function buildSwapToXLM(
  args: SwapToXLMArgs,
  deps: SwapToXLMDeps,
): Promise<Transaction> {
  const routerId = getSoroswapRouterId(args.network);
  if (!isAllowedRootTarget(routerId, args.network)) {
    throw new Error(
      `SoroswapRouter ${routerId} is not on the ${args.network.id} allow-list; refusing to build swap`,
    );
  }

  validateIntegerAmount(CALLER, "amountIn", args.amountIn);
  validateIntegerAmount(CALLER, "amountOutMin", args.amountOutMin);
  validateDeadline(CALLER, args.deadline);
  const maxTime = ledgerMaxTime(args.ledgerCloseTime, FIVE_MINUTES_SECONDS);
  if (BigInt(args.amountIn) <= 0n) {
    throw new RangeError(`buildSwapToXLM: amountIn must be > 0; got ${args.amountIn}`);
  }

  const assetInAddress = resolveAssetAddress(args.assetIn, args.network, CALLER);
  const xlmAddress = Asset.native().contractId(args.network.passphrase);
  if (assetInAddress === xlmAddress) {
    throw new Error("buildSwapToXLM: assetIn is already XLM; nothing to convert");
  }
  const path = args.path ?? [assetInAddress, xlmAddress];
  validatePath(path, assetInAddress, xlmAddress);

  const callArgs: xdr.ScVal[] = [
    scvI128(BigInt(args.amountIn)),
    scvI128(BigInt(args.amountOutMin)),
    scvVec(path.map((t) => scvAddress(t))),
    scvAddress(args.userAddress),
    nativeToScVal(BigInt(args.deadline), { type: "u64" }),
  ];

  const contract = new Contract(routerId);
  const tx = new TransactionBuilder(deps.sourceAccount, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: args.network.passphrase,
  })
    .addOperation(contract.call("swap_exact_tokens_for_tokens", ...callArgs))
    .setTimebounds(0, maxTime)
    .build();

  const assemble = deps.assemble ?? assembleSubmittable;
  const prepared = await assemble(deps.server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(
      "buildSwapToXLM: assembling the simulation returned a FeeBumpTransaction unexpectedly",
    );
  }
  assertTransactionAllowed(prepared, args.network);
  return prepared;
}

export interface SwapRouteQuote {
  // assetIn first, XLM last
  readonly path: readonly string[];
  // router_get_amounts_out along the path: amounts[0] is the input, the last is
  // the XLM out
  readonly amounts: readonly bigint[];
}

// no Soroswap path from the token to XLM: no pair graph path, or every candidate
// path failed to quote (empty reserves, a reverting token). `reasons` lists what
// each candidate answered.
export class NoSoroswapRouteError extends Error {
  readonly assetIn: string;
  readonly reasons: readonly string[];
  constructor(assetIn: string, reasons: readonly string[]) {
    super(
      `No Soroswap route from ${assetIn} to XLM` +
        (reasons.length > 0 ? ` (${reasons.join("; ")})` : " (no pair path exists)"),
    );
    this.name = "NoSoroswapRouteError";
    this.assetIn = assetIn;
    this.reasons = reasons;
  }
}

export interface QuoteRouteDeps {
  readonly simulateRead?: typeof simulateRead;
  readonly loadPairs?: typeof loadSoroswapPairs;
}

// find the best Soroswap path from assetIn to XLM for amountIn. candidates are
// the direct pair and one-hop paths through tokens paired with both sides (pairs
// with an empty reserve are skipped). every candidate is quoted by the router
// itself; a transport failure propagates instead of being read as "no route".
export async function quoteRouteToXLM(
  server: rpc.Server,
  args: {
    readonly assetIn: AssetIdentifier;
    readonly amountIn: bigint;
    readonly network: NetworkConfig;
    readonly sourcePublicKey: string;
  },
  deps: QuoteRouteDeps = {},
): Promise<SwapRouteQuote> {
  if (args.amountIn <= 0n) {
    throw new RangeError(`quoteRouteToXLM: amountIn must be > 0; got ${args.amountIn}`);
  }
  const read = deps.simulateRead ?? simulateRead;
  const load = deps.loadPairs ?? loadSoroswapPairs;
  const tokenIn = resolveAssetAddress(args.assetIn, args.network, CALLER);
  const xlm = Asset.native().contractId(args.network.passphrase);
  if (tokenIn === xlm) throw new Error("quoteRouteToXLM: assetIn is already XLM");

  const pairs = await load(server, args.network, args.sourcePublicKey, { simulateRead: read });
  const candidates = candidatePaths(pairs, tokenIn, xlm);
  if (candidates.length === 0) throw new NoSoroswapRouteError(tokenIn, []);

  const routerId = getSoroswapRouterId(args.network);
  let best: SwapRouteQuote | null = null;
  const reasons: string[] = [];
  for (const path of candidates) {
    try {
      const { retval } = await read(
        server,
        routerId,
        "router_get_amounts_out",
        [scvI128(args.amountIn), scvVec(path.map((t) => scvAddress(t)))],
        args.sourcePublicKey,
        args.network,
      );
      const amounts = decodeI128Vec(retval);
      if (amounts.length !== path.length) {
        throw new Error(
          `router_get_amounts_out returned ${amounts.length} amounts for ${path.length} hops`,
        );
      }
      const out = amounts[amounts.length - 1]!;
      if (out <= 0n) {
        reasons.push(`${path.join(" > ")}: quotes zero XLM`);
        continue;
      }
      if (best === null || out > best.amounts[best.amounts.length - 1]!) best = { path, amounts };
    } catch (e) {
      // a contract-level refusal (missing pair, empty reserves, a trapping
      // token) rules this path out; anything else is not an answer about the path
      if (!(e instanceof SimulationError)) throw e;
      reasons.push(`${path.join(" > ")}: ${e.errorCode.split("\n")[0]}`);
    }
  }
  if (best === null) throw new NoSoroswapRouteError(tokenIn, reasons);
  return best;
}

// direct path first, then one-hop paths ordered by the XLM-side reserve of the
// hop's XLM pair, capped at MAX_INTERMEDIATE_CANDIDATES
function candidatePaths(
  pairs: readonly SoroswapPairInfo[],
  tokenIn: string,
  xlm: string,
): string[][] {
  const live = pairs.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n);
  const other = (p: SoroswapPairInfo, t: string) =>
    p.token0 === t ? p.token1 : p.token1 === t ? p.token0 : null;
  const neighboursOfIn = new Set<string>();
  const xlmReserveVia = new Map<string, bigint>();
  for (const p of live) {
    const fromIn = other(p, tokenIn);
    if (fromIn !== null) neighboursOfIn.add(fromIn);
    const fromXlm = other(p, xlm);
    if (fromXlm !== null) xlmReserveVia.set(fromXlm, p.token0 === xlm ? p.reserve0 : p.reserve1);
  }
  const paths: string[][] = [];
  if (neighboursOfIn.has(xlm)) paths.push([tokenIn, xlm]);
  const hops = [...neighboursOfIn]
    .filter((t) => t !== xlm && xlmReserveVia.has(t))
    .sort((a, b) => {
      const d = xlmReserveVia.get(b)! - xlmReserveVia.get(a)!;
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    })
    .slice(0, MAX_INTERMEDIATE_CANDIDATES);
  for (const hop of hops) paths.push([tokenIn, hop, xlm]);
  return paths;
}

function decodeI128Vec(v: xdr.ScVal): bigint[] {
  if (v.type !== "scvVec" || v.vec === null) {
    throw new TypeError(`router_get_amounts_out: expected a vec, got ${v.type}`);
  }
  return v.vec.map((x) => fromScValI128(x));
}

function validatePath(path: readonly string[], tokenIn: string, xlm: string): void {
  if (path.length < 2 || path.length > MAX_PATH_LENGTH) {
    throw new RangeError(`buildSwapToXLM: path must have 2 to ${MAX_PATH_LENGTH} tokens`);
  }
  if (path[0] !== tokenIn || path[path.length - 1] !== xlm) {
    throw new RangeError("buildSwapToXLM: path must start at the input token and end at XLM");
  }
  if (new Set(path).size !== path.length) {
    throw new RangeError("buildSwapToXLM: path must not repeat a token");
  }
}
