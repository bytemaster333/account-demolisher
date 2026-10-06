// sign-time check of the authorization tree on every allow-listed DeFi node.
//
// the allow-list only checks the contract an operation invokes. prepareTransaction
// copies whatever auth tree the simulation recorded into the op, and with
// source-account credentials the single transaction signature authorizes all of
// it. a token running inside a swap or a withdraw (an airdropped token, a token
// in a permissionless pool) can call another token with the user as `from`, and
// that call is recorded as an extra nested node; a hostile rpc can add entries
// outright. so before signing we require the exact tree each protocol call
// legitimately needs, read from the protocol source and from recorded mainnet
// simulations:
//
//   soroswap swap_exact_tokens_for_tokens  -> path[0].transfer(user, pair(path[0], path[1]), amount_in)
//   soroswap remove_liquidity              -> pair.transfer(user, pair, liquidity)
//   aquarius router withdraw               -> pool.withdraw(user, shares, mins)
//                                               -> share_token.burn(user, shares)
//   aquarius router claim                  -> pool.claim(user)
//   blend pool submit (repay)              -> asset.transfer(user, pool, amount)
//   blend pool submit (withdraw), claim    -> nothing nested
//   blend backstop queue_withdrawal        -> nothing nested
//   fxdao pay_debt                         -> stablecoin.burn(user, amount)
//
// recorded on mainnet (2026-10): swap, remove_liquidity, aquarius withdraw and
// claim, blend repay, withdraw and claim. read from source: backstop
// queue_withdrawal (blend-contracts-v2 backstop/src/contract.rs) and fxdao
// pay_debt (FxDAO-SC contracts/vaults/src/contract.rs, utils/payments.rs).
//
// anything else (a second auth entry, address credentials, an extra or deeper
// node, different args) is refused, and so is anything we fail to parse.

import {
  Address,
  Asset,
  hash,
  scValToNative,
  StrKey,
  xdr,
  type Operation,
  type Transaction,
} from "@stellar/stellar-sdk";

import { FXDAO_MAINNET_CONTRACTS, FXDAO_TESTNET_CONTRACTS } from "@/lib/adapters/fxdao/contracts";
import { getAllowlistForNetwork } from "@/lib/config/contracts";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { resolveContractIdForAsset } from "@/lib/plan/hydration";
import type { PlanNode } from "@/lib/plan/tree";

export class UnsafeDefiAuthError extends Error {
  constructor(
    readonly nodeKind: string,
    reason: string,
  ) {
    super(
      `Refusing to sign ${nodeKind}: its authorization asks for more than this step needs (${reason}). ` +
        "This usually means a token involved in the step runs extra code. Nothing was signed.",
    );
    this.name = "UnsafeDefiAuthError";
  }
}

export interface DefiAuthContext {
  readonly user: string;
  readonly network: NetworkConfig;
}

// one expected nested call. contract is either pinned or checked by a predicate
// when the protocol picks it on chain (an aquarius pool, an fxdao stablecoin).
interface ExpectedCall {
  readonly contract: string | ((id: string) => string | null);
  readonly fn: string;
  readonly args: (args: readonly unknown[]) => string | null;
  readonly children: readonly ExpectedCall[];
}

// throws UnsafeDefiAuthError unless tx is exactly the call node.kind is meant to
// make, authorized by exactly the tree that call needs
export function assertDefiAuthTree(node: PlanNode, tx: Transaction, ctx: DefiAuthContext): void {
  try {
    check(node, tx, ctx);
  } catch (err) {
    if (err instanceof UnsafeDefiAuthError) throw err;
    // fail closed: a tree we cannot read is never signed
    throw new UnsafeDefiAuthError(
      node.kind,
      `could not inspect the transaction: ${errorMessage(err)}`,
    );
  }
}

function refuse(kind: string, reason: string): never {
  throw new UnsafeDefiAuthError(kind, reason);
}

function check(node: PlanNode, tx: Transaction, ctx: DefiAuthContext): void {
  const fail = (reason: string): never => refuse(node.kind, reason);
  if (tx.source !== ctx.user) fail(`transaction source is ${tx.source}, expected ${ctx.user}`);
  if (tx.operations.length !== 1) fail(`expected 1 operation, got ${tx.operations.length}`);
  const op = tx.operations[0]!;
  if (op.type !== "invokeHostFunction") fail(`operation is ${op.type}`);
  const ihf = op as Operation.InvokeHostFunction;
  if (ihf.source !== undefined && ihf.source !== ctx.user) {
    fail(`operation source is ${ihf.source}`);
  }
  const func = ihf.func;
  if (func.type !== "hostFunctionTypeInvokeContract") fail(`host function is ${func.type}`);
  const call = (func as xdr.HostFunction & { invokeContract: xdr.InvokeContractArgs })
    .invokeContract;
  const rootContract = Address.fromScAddress(call.contractAddress).toString();
  const rootFn = call.functionName.toString();
  const rootArgs = call.args.map((a) => scValToNative(a) as unknown);

  const expected = expectedFor(node, { contract: rootContract, fn: rootFn, args: rootArgs }, ctx);
  if (typeof expected === "string") fail(expected);
  const nested = expected as readonly ExpectedCall[];

  const auth = ihf.auth ?? [];
  if (auth.length !== 1) fail(`expected 1 authorization entry, got ${auth.length}`);
  const entry = auth[0]!;
  if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
    fail(`authorization uses ${entry.credentials.type} credentials`);
  }
  const root = entry.rootInvocation;
  if (root.function.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    fail(`authorized root is ${root.function.type}`);
  }
  const authorizedRoot = (
    root.function as xdr.SorobanAuthorizedFunction & { contractFn: xdr.InvokeContractArgs }
  ).contractFn;
  if (!authorizedRoot.equals(call)) fail("authorized root differs from the invoked call");

  const mismatch = matchChildren(root.subInvocations, nested, "root");
  if (mismatch !== null) fail(mismatch);
}

// the recorded children must be exactly the expected ones, each once, in any order
function matchChildren(
  actual: readonly xdr.SorobanAuthorizedInvocation[],
  expected: readonly ExpectedCall[],
  where: string,
): string | null {
  if (actual.length !== expected.length) {
    return `${where} authorizes ${actual.length} nested call(s), expected ${expected.length}`;
  }
  const used = new Set<number>();
  for (const inv of actual) {
    if (inv.function.type !== "sorobanAuthorizedFunctionTypeContractFn") {
      return `${where} authorizes ${inv.function.type}`;
    }
    const fn = (
      inv.function as xdr.SorobanAuthorizedFunction & { contractFn: xdr.InvokeContractArgs }
    ).contractFn;
    const contract = Address.fromScAddress(fn.contractAddress).toString();
    const name = fn.functionName.toString();
    const args = fn.args.map((a) => scValToNative(a) as unknown);
    let reasons: string[] = [];
    let matched = -1;
    for (let i = 0; i < expected.length; i++) {
      if (used.has(i)) continue;
      const exp = expected[i]!;
      const reason = matchCall(exp, contract, name, args);
      if (reason !== null) {
        reasons.push(reason);
        continue;
      }
      const deeper = matchChildren(inv.subInvocations, exp.children, `${contract}.${name}`);
      if (deeper !== null) {
        reasons.push(deeper);
        continue;
      }
      matched = i;
      break;
    }
    if (matched < 0) {
      return `${where} authorizes ${contract}.${name}, which is not expected (${reasons.join("; ")})`;
    }
    used.add(matched);
    reasons = [];
  }
  return null;
}

function matchCall(
  exp: ExpectedCall,
  contract: string,
  fn: string,
  args: readonly unknown[],
): string | null {
  if (typeof exp.contract === "string") {
    if (contract !== exp.contract) return `contract ${contract} is not ${exp.contract}`;
  } else {
    const reason = exp.contract(contract);
    if (reason !== null) return reason;
  }
  if (fn !== exp.fn) return `function ${fn} is not ${exp.fn}`;
  return exp.args(args);
}

interface RootCall {
  readonly contract: string;
  readonly fn: string;
  readonly args: readonly unknown[];
}

// returns the expected nested calls, or a string saying why the root call itself
// is not the one this node is meant to make
function expectedFor(
  node: PlanNode,
  root: RootCall,
  ctx: DefiAuthContext,
): readonly ExpectedCall[] | string {
  const { user, network } = ctx;
  const nativeSac = Asset.native().contractId(network.passphrase);
  const a = root.args;
  switch (node.kind) {
    case "ConvertSorobanToXLM": {
      const notRouter = pinnedRoot(root, network, "soroswap", "SoroswapRouter");
      if (notRouter !== null) return notRouter;
      if (root.fn !== "swap_exact_tokens_for_tokens") return `calls ${root.fn}`;
      if (a.length !== 5) return `swap has ${a.length} args`;
      const tokenIn = resolveContractIdForAsset(node.metadata.asset, network);
      // the router pulls amount_in from the user into the first pair only; later
      // hops move between pairs and need no user authorization
      const path = a[2];
      if (
        !Array.isArray(path) ||
        path.length < 2 ||
        path.length > MAX_SWAP_PATH ||
        path[0] !== tokenIn ||
        path[path.length - 1] !== nativeSac ||
        !path.every((t) => typeof t === "string" && StrKey.isValidContract(t)) ||
        new Set(path).size !== path.length
      ) {
        return `swap path does not run from ${tokenIn} to ${nativeSac}`;
      }
      if (a[0] !== node.metadata.amount) return `swap amount_in is ${String(a[0])}`;
      if (a[3] !== user) return `swap pays out to ${String(a[3])}`;
      const pair = soroswapPairFor(network, tokenIn, path[1] as string);
      return [
        {
          contract: tokenIn,
          fn: "transfer",
          args: exactArgs([user, pair, node.metadata.amount]),
          children: [],
        },
      ];
    }
    case "WithdrawSoroswapLp": {
      const notRouter = pinnedRoot(root, network, "soroswap", "SoroswapRouter");
      if (notRouter !== null) return notRouter;
      if (root.fn !== "remove_liquidity") return `calls ${root.fn}`;
      if (a.length !== 7) return `remove_liquidity has ${a.length} args`;
      if (a[0] !== node.metadata.tokenA || a[1] !== node.metadata.tokenB) {
        return "remove_liquidity names a different token pair";
      }
      if (a[2] !== node.metadata.shareBalance) return `liquidity is ${String(a[2])}`;
      if (a[5] !== user) return `remove_liquidity pays out to ${String(a[5])}`;
      const pair = soroswapPairFor(network, node.metadata.tokenA, node.metadata.tokenB);
      return [
        {
          contract: pair,
          fn: "transfer",
          args: exactArgs([user, pair, node.metadata.shareBalance]),
          children: [],
        },
      ];
    }
    case "WithdrawAquarius": {
      const notRouter = pinnedRoot(root, network, "aquarius", "AquariusAmmRouter");
      if (notRouter !== null) return notRouter;
      if (root.fn !== "withdraw") return `calls ${root.fn}`;
      if (a.length !== 5) return `withdraw has ${a.length} args`;
      if (a[0] !== user) return `withdraw is for ${String(a[0])}`;
      if (!sameList(a[1], node.metadata.tokens)) return "withdraw names different tokens";
      if (bytesHex(a[2]) !== node.metadata.poolIndex.toLowerCase()) {
        return "withdraw names a different pool index";
      }
      if (a[3] !== node.metadata.shareAmount) return `withdraw share amount is ${String(a[3])}`;
      const mins = a[4];
      if (!Array.isArray(mins) || mins.length !== node.metadata.tokens.length) {
        return "withdraw minimums do not match the token count";
      }
      const someContract = poolShaped(nativeSac, root.contract);
      return [
        {
          contract: someContract("pool"),
          fn: "withdraw",
          args: exactArgs([user, node.metadata.shareAmount, mins]),
          children: [
            {
              contract: someContract("share token"),
              fn: "burn",
              args: exactArgs([user, node.metadata.shareAmount]),
              children: [],
            },
          ],
        },
      ];
    }
    case "ClaimAquariusRewards": {
      const notRouter = pinnedRoot(root, network, "aquarius", "AquariusAmmRouter");
      if (notRouter !== null) return notRouter;
      if (root.fn !== "claim") return `calls ${root.fn}`;
      // router claim(user, tokens, pool_index)
      if (a.length !== 3) return `claim has ${a.length} args`;
      if (a[0] !== user) return `claim is for ${String(a[0])}`;
      const tokens = a[1];
      if (
        !Array.isArray(tokens) ||
        tokens.length < 2 ||
        !tokens.every((t) => typeof t === "string" && StrKey.isValidContract(t))
      ) {
        return "claim does not name a pool's token set";
      }
      if (bytesHex(a[2]) !== node.metadata.poolIndex.toLowerCase()) {
        return "claim names a different pool index";
      }
      // the router forwards to the pool it resolves on chain, which authorizes
      // the same user; the reward is paid out by the pool
      return [
        {
          contract: poolShaped(nativeSac, root.contract)("pool"),
          fn: "claim",
          args: exactArgs([user]),
          children: [],
        },
      ];
    }
    case "RepayBlend":
    case "WithdrawBlend": {
      if (root.contract !== node.metadata.poolId) return `targets ${root.contract}`;
      if (root.fn !== "submit") return `calls ${root.fn}`;
      if (a.length !== 4 || a[0] !== user || a[1] !== user || a[2] !== user) {
        return "submit is not from, spent by and paid to the user";
      }
      const requests = a[3];
      if (!Array.isArray(requests) || requests.length !== 1) {
        return "submit must carry exactly one request";
      }
      const req = requests[0] as { address?: unknown; amount?: unknown; request_type?: unknown };
      if (req.address !== node.metadata.asset) return `request asset is ${String(req.address)}`;
      if (node.kind === "WithdrawBlend") {
        // blend request types: 1 withdraw supply, 3 withdraw collateral
        const want = node.metadata.bucket === "collateral" ? 3 : 1;
        if (req.request_type !== want) return `request type is ${String(req.request_type)}`;
        return [];
      }
      // 5 repay: the pool pulls exactly the requested amount from the spender
      if (req.request_type !== 5) return `request type is ${String(req.request_type)}`;
      if (req.amount !== node.metadata.amount) return `repay amount is ${String(req.amount)}`;
      return [
        {
          contract: node.metadata.asset,
          fn: "transfer",
          args: exactArgs([user, node.metadata.poolId, node.metadata.amount]),
          children: [],
        },
      ];
    }
    case "ClaimBlendEmissions": {
      if (root.contract !== node.metadata.poolId) return `targets ${root.contract}`;
      if (root.fn !== "claim") return `calls ${root.fn}`;
      if (a.length !== 3 || a[0] !== user || a[2] !== user) {
        return "claim is not from and paid to the user";
      }
      return [];
    }
    case "BackstopQueue": {
      if (root.fn !== "queue_withdrawal") return `calls ${root.fn}`;
      if (a.length !== 3 || a[0] !== user) return "queue_withdrawal is not from the user";
      if (a[1] !== node.metadata.poolId) return `queue_withdrawal names pool ${String(a[1])}`;
      if (a[2] !== node.metadata.shares) return `queue_withdrawal amount is ${String(a[2])}`;
      return [];
    }
    case "PayFxDAODebt": {
      const registry = fxdaoRegistry(network);
      const vaults = registry.find((c) => c.kind === "vaults")?.id;
      if (vaults === undefined) return `fxdao has no vaults contract pinned for ${network.id}`;
      if (root.contract !== vaults)
        return `targets ${root.contract}, not the fxdao vaults contract`;
      if (root.fn !== "pay_debt") return `calls ${root.fn}`;
      if (a.length !== 4) return `pay_debt has ${a.length} args`;
      const key = a[1] as { account?: unknown; denomination?: unknown };
      if (key?.account !== user) return `pay_debt is for vault owner ${String(key?.account)}`;
      if (key.denomination !== node.metadata.vaultDenomination) {
        return `pay_debt names denomination ${String(key.denomination)}`;
      }
      if (a[3] !== node.metadata.debt) return `pay_debt amount is ${String(a[3])}`;
      return [
        {
          // the vault burns the denomination's stablecoin, one of fxdao's pinned
          // synthetic SACs
          contract: (id) =>
            id === nativeSac
              ? "pay_debt would burn XLM"
              : registry.some((c) => c.kind === "synthetic_sac" && c.id === id)
                ? null
                : `stablecoin ${id} is not one of fxdao's pinned stablecoins`,
          fn: "burn",
          args: exactArgs([user, node.metadata.debt]),
          children: [],
        },
      ];
    }
    case "TransferAsIs":
    case "RevokeAllowance":
      return `${node.kind} is checked by its own guard`;
    case "FinalClassicTx":
    case "MediatorForward":
      return `${node.kind} is not a Soroban step`;
    default:
      // a kind added without an expected tree here is never signed
      return `${(node as { kind: string }).kind} has no expected authorization tree`;
  }
}

// longest router path the app builds: token -> one hop -> XLM
const MAX_SWAP_PATH = 3;

// the root must be the protocol's own pinned entry point, not merely some
// allow-listed contract of the same protocol
function pinnedRoot(
  root: RootCall,
  network: NetworkConfig,
  protocol: string,
  name: string,
): string | null {
  const entry = getAllowlistForNetwork(network).find(
    (c) => c.protocol === protocol && c.name === name,
  );
  if (entry === undefined) return `${name} is not pinned for ${network.id}`;
  return root.contract === entry.id ? null : `targets ${root.contract}, not the ${name}`;
}

// an aquarius pool or share token is picked by the router on chain, so it is
// checked by shape; a wrong address only fails the call, it can't move funds
function poolShaped(nativeSac: string, router: string) {
  return (label: string) =>
    (id: string): string | null => {
      if (!StrKey.isValidContract(id)) return `${label} ${id} is not a contract`;
      if (id === nativeSac || id === router) return `${label} ${id} is not a pool`;
      return null;
    };
}

function fxdaoRegistry(network: NetworkConfig) {
  if (network.id === "mainnet") return FXDAO_MAINNET_CONTRACTS;
  if (network.id === "testnet") return FXDAO_TESTNET_CONTRACTS;
  return [];
}

function exactArgs(want: readonly unknown[]) {
  return (got: readonly unknown[]): string | null => {
    if (got.length !== want.length) return `${got.length} args, expected ${want.length}`;
    for (let i = 0; i < want.length; i++) {
      if (!sameValue(got[i], want[i])) {
        return `arg ${i} is ${show(got[i])}, expected ${show(want[i])}`;
      }
    }
    return null;
  };
}

function sameValue(x: unknown, y: unknown): boolean {
  if (Array.isArray(x) && Array.isArray(y)) {
    return x.length === y.length && x.every((v, i) => sameValue(v, y[i]));
  }
  return x === y;
}

function sameList(x: unknown, y: readonly string[]): boolean {
  return Array.isArray(x) && x.length === y.length && x.every((v, i) => v === y[i]);
}

function bytesHex(v: unknown): string | null {
  if (!(v instanceof Uint8Array)) return null;
  return Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
}

function show(v: unknown): string {
  return typeof v === "bigint"
    ? v.toString()
    : Array.isArray(v)
      ? `[${v.map(show).join(",")}]`
      : String(v);
}

// soroswap_library::pair_for: the factory deploys each pair at a deterministic
// address salted with sha256(xdr(token0) || xdr(token1)), tokens sorted by
// address. checked against the factory's own get_pair on mainnet.
export function soroswapPairFor(network: NetworkConfig, tokenA: string, tokenB: string): string {
  const factory = getAllowlistForNetwork(network).find(
    (c) => c.protocol === "soroswap" && c.name === "SoroswapFactory",
  );
  if (!factory) throw new Error(`SoroswapFactory is not pinned for ${network.id}`);
  const rawA = Address.fromString(tokenA).toScAddress().toXdr();
  const rawB = Address.fromString(tokenB).toScAddress().toXdr();
  const [t0, t1] = compareBytes(rawA, rawB) < 0 ? [tokenA, tokenB] : [tokenB, tokenA];
  const a0 = Address.fromString(t0).toScVal().toXdr();
  const a1 = Address.fromString(t1).toScVal().toXdr();
  const salted = new Uint8Array(a0.length + a1.length);
  salted.set(a0, 0);
  salted.set(a1, a0.length);
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(new TextEncoder().encode(network.passphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(factory.id).toScAddress(),
          salt: hash(salted),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXdr()));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
