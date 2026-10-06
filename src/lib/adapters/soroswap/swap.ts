// Soroswap Router swap: convert a Soroban token to XLM via a direct
// swap_exact_tokens_for_tokens invocation against the SoroswapRouter.
//
// This is the ALLOW-LIST-SAFE, testnet-capable conversion path. The Soroswap
// Aggregator (multi-protocol) is addressed dynamically by the Soroswap backend
// (SoroswapSDK.getContractAddress) and is not deployed on testnet, so it cannot
// be a statically-pinned allow-list entry the way this app's security model
// requires. The Router IS pinned on both the mainnet and testnet allow-lists, so
// the conversion routes through it (single-protocol Soroswap liquidity).
//
// Many tokens have no direct XLM pair (on mainnet 40 of the 88 paired tokens
// trade only against something else), so quoteRouteToXLM searches the factory's
// pair graph for the direct path and every one-hop path through a token paired
// with both sides, quotes each with router_get_amounts_out, and returns the best.
// A token with no usable route gets a NoSoroswapRouteError, never a guessed path.
import {
  Asset,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  getAllowlistForNetwork,
  isAllowedRootTarget,
  type AllowedContract,
} from "@/lib/config/contracts";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
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
  readonly network: NetworkConfig;
  // the route from quoteRouteToXLM, assetIn first and XLM last. omitted means the
  // direct [assetIn, XLM] pair
  readonly path?: readonly string[];
}

export interface SwapToXLMDeps {
  readonly server: rpc.Server;
  readonly sourceAccount: Horizon.AccountResponse;
  readonly assemble?: typeof assembleSubmittable;
}

// build a router swap_exact_tokens_for_tokens converting assetIn -> XLM along
// `path`. Allow-list-gated on build AND after assembly, like the LP-removal builder.
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

  validateIntegerAmount("amountIn", args.amountIn);
  validateIntegerAmount("amountOutMin", args.amountOutMin);
  validateDeadline(args.deadline);
  if (BigInt(args.amountIn) <= 0n) {
    throw new RangeError(`buildSwapToXLM: amountIn must be > 0; got ${args.amountIn}`);
  }

  const assetInAddress = resolveAssetAddress(args.assetIn, args.network);
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
    .setTimeout(FIVE_MINUTES_SECONDS)
    .build();

  const assemble = deps.assemble ?? assembleSubmittable;
  const prepared = await assemble(deps.server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(
      "buildSwapToXLM: prepareTransaction returned a FeeBumpTransaction unexpectedly",
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
  const tokenIn = resolveAssetAddress(args.assetIn, args.network);
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

// look up the SoroswapRouter contract id from the network's allow-list
export function getSoroswapRouterId(network: NetworkConfig): string {
  const entry = getAllowlistForNetwork(network).find(
    (c: AllowedContract) => c.protocol === "soroswap" && c.name === "SoroswapRouter",
  );
  if (!entry) {
    throw new Error(`SoroswapRouter not found in the ${network.id} allow-list`);
  }
  return entry.id;
}

function resolveAssetAddress(asset: AssetIdentifier, network: NetworkConfig): string {
  switch (asset.kind) {
    case "native":
      return Asset.native().contractId(network.passphrase);
    case "credit":
      return new Asset(asset.code, asset.issuer).contractId(network.passphrase);
    case "liquidity_pool_shares":
      throw new TypeError(
        "buildSwapToXLM: liquidity_pool_shares is not a swappable token; remove liquidity first",
      );
    case "contract":
      return asset.contractId;
  }
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

function validateIntegerAmount(label: string, v: string): void {
  if (!/^\d+$/.test(v)) {
    throw new TypeError(
      `buildSwapToXLM: ${label} must be a non-negative decimal-integer string; got "${v}"`,
    );
  }
}

function validateDeadline(deadline: number): void {
  if (!Number.isFinite(deadline) || !Number.isInteger(deadline) || deadline <= 0) {
    throw new RangeError(`buildSwapToXLM: deadline must be a positive integer; got ${deadline}`);
  }
  if (deadline > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`buildSwapToXLM: deadline exceeds MAX_SAFE_INTEGER; got ${deadline}`);
  }
}
