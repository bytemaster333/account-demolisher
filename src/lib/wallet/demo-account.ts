// one-click testnet "showcase" account. testnet only: every contract and asset
// below is a testnet deployment, and the account is funded by friendbot.

import {
  Address,
  Asset,
  Claimant,
  Contract,
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl } from "@/lib/explorer";
import { getRpc } from "@/lib/soroban/rpc-client";
import { address as scvAddress, i128 as scvI128, vec as scvVec } from "@/lib/soroban/scval";
import { balance, buildApprove } from "@/lib/soroban/sep41";
import { assembleSubmittable, simulateRead } from "@/lib/soroban/simulate";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

// circle testnet usdc: issuer published in https://testanchor.stellar.org/.well-known/stellar.toml
const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// blend testnet pool TestnetV2: from BLEND_TESTNET_POOLS in src/lib/adapters/blend/pools.ts
const BLEND_POOL_TESTNET = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
// soroswap testnet router: from TESTNET_SOROSWAP_ENTRIES in src/lib/config/contracts.ts
const SOROSWAP_ROUTER_TESTNET = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";

// the demo creates real testnet state, so it runs on testnet and nowhere else
export function isDemoNetwork(network: NetworkConfig): boolean {
  return network.id === "testnet";
}

// the native XLM SAC id is derived from the network passphrase
function nativeSac(network: NetworkConfig): string {
  return Asset.native().contractId(network.passphrase);
}

function usdcSac(network: NetworkConfig): string {
  return new Asset("USDC", USDC_TESTNET_ISSUER).contractId(network.passphrase);
}

export type DemoStepId =
  | "keypair"
  | "friendbot"
  | "trustlines"
  | "data-entries"
  | "sell-offer"
  | "co-signer"
  | "credit-balances"
  | "claimable-balance"
  | "blend-supply"
  | "soroswap-swap"
  | "soroswap-lp"
  | "sep41-allowance"
  | "ready";

export interface DemoStep {
  readonly id: DemoStepId;
  readonly label: string;
  readonly description: string;
}

export const DEMO_STEPS: readonly DemoStep[] = [
  {
    id: "keypair",
    label: "Generate fresh keypair",
    description: "Creating a brand-new account key. It stays private on your device.",
  },
  {
    id: "friendbot",
    label: "Fund with friendbot",
    description: "Adding free test-network coins so the account can do things.",
  },
  {
    id: "trustlines",
    label: "Open trustlines",
    description: "Letting the account hold three sample tokens we can later remove.",
  },
  {
    id: "data-entries",
    label: "Write data entries",
    description: "Adding two sample saved-data notes to the account.",
  },
  {
    id: "sell-offer",
    label: "Place a sell offer",
    description: "Putting up a sample trade offer we can cancel later.",
  },
  {
    id: "co-signer",
    label: "Add a co-signer",
    description: "Adding a second approved signer, so we can practice removing it.",
  },
  {
    id: "credit-balances",
    label: "Issue credit balances",
    description: "Sending some sample tokens into the account to hold.",
  },
  {
    id: "claimable-balance",
    label: "Create a claimable balance",
    description: "Setting aside a small amount that has to be claimed back later.",
  },
  {
    id: "blend-supply",
    label: "Supply collateral to Blend",
    description: "Depositing a little into a sample lending app to withdraw later.",
  },
  {
    id: "soroswap-swap",
    label: "Swap XLM → USDC on Soroswap",
    description: "Trading a bit of one token for another on a sample exchange.",
  },
  {
    id: "soroswap-lp",
    label: "Add liquidity to Soroswap LP",
    description: "Adding a sample deposit to an exchange pool to pull back out later.",
  },
  {
    id: "sep41-allowance",
    label: "Approve a SEP-41 allowance",
    description:
      "Granting a tiny spending allowance to another address, the kind of thing we'll revoke.",
  },
  {
    id: "ready",
    label: "Ready to demolish",
    description: "Your practice account is ready.",
  },
];

export interface DemoStepResult {
  readonly id: DemoStepId;
  readonly status: "done" | "failed" | "skipped";
  readonly txHash?: string;
  readonly detail?: string;
  readonly error?: string;
}

export interface DemoAccountResult {
  readonly publicKey: string;
  readonly connector: SecretKeyConnector;
  readonly explorerUrl: string;
}

export interface RunDemoOptions {
  readonly network: NetworkConfig;
  readonly onStart: (id: DemoStepId) => void;
  readonly onFinish: (result: DemoStepResult) => void;
}

export async function runDemoSetup(opts: RunDemoOptions): Promise<DemoAccountResult> {
  const { network, onStart, onFinish } = opts;
  const friendbot = network.friendbot;
  if (!isDemoNetwork(network) || friendbot === null) {
    throw new Error(`The practice account is available on testnet only, not on ${network.id}.`);
  }

  // step 1: keypair (cannot fail)
  onStart("keypair");
  const kp = Keypair.random();
  const publicKey = kp.publicKey();
  const secret = kp.secret();
  onFinish({
    id: "keypair",
    status: "done",
    detail: `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}`,
  });

  // step 2: friendbot (fatal on failure)
  onStart("friendbot");
  try {
    await friendbotFund(friendbot, publicKey);
    onFinish({ id: "friendbot", status: "done", detail: "10,000 XLM credited" });
  } catch (e) {
    onFinish({ id: "friendbot", status: "failed", error: errorMessage(e) });
    throw e;
  }

  const horizon = new Horizon.Server(network.horizon);

  // step 3: trustlines (best-effort)
  let aquaIssuerKp: Keypair | null = null;
  let yxlmIssuerKp: Keypair | null = null;

  onStart("trustlines");
  try {
    const aquaIssuer = Keypair.random();
    const yxlmIssuer = Keypair.random();
    aquaIssuerKp = aquaIssuer;
    yxlmIssuerKp = yxlmIssuer;
    const hash = await submitClassic(horizon, network, secret, publicKey, (b) =>
      b
        // 5 XLM each so the issuers have plenty for tx fees when they later mint
        .addOperation(
          Operation.createAccount({ destination: aquaIssuer.publicKey(), startingBalance: "5" }),
        )
        .addOperation(
          Operation.createAccount({ destination: yxlmIssuer.publicKey(), startingBalance: "5" }),
        )
        .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_TESTNET_ISSUER) }))
        .addOperation(Operation.changeTrust({ asset: new Asset("AQUA", aquaIssuer.publicKey()) }))
        .addOperation(Operation.changeTrust({ asset: new Asset("YXLM", yxlmIssuer.publicKey()) })),
    );
    onFinish({ id: "trustlines", status: "done", txHash: hash, detail: "3 trustlines opened" });
  } catch (e) {
    onFinish({ id: "trustlines", status: "failed", error: errorMessage(e) });
  }

  // step 4: data entries (best-effort, batched)
  onStart("data-entries");
  try {
    const hash = await submitClassic(horizon, network, secret, publicKey, (b) =>
      b
        .addOperation(Operation.manageData({ name: "demo:protocol", value: "account-demolisher" }))
        .addOperation(Operation.manageData({ name: "demo:purpose", value: "showcase" })),
    );
    onFinish({
      id: "data-entries",
      status: "done",
      txHash: hash,
      detail: "2 data entries written",
    });
  } catch (e) {
    onFinish({ id: "data-entries", status: "failed", error: errorMessage(e) });
  }

  // step 5: sell offer (best-effort)
  onStart("sell-offer");
  try {
    const hash = await submitClassic(horizon, network, secret, publicKey, (b) =>
      b.addOperation(
        Operation.manageSellOffer({
          selling: Asset.native(),
          buying: new Asset("USDC", USDC_TESTNET_ISSUER),
          amount: "100",
          price: "0.5",
          offerId: "0",
        }),
      ),
    );
    onFinish({
      id: "sell-offer",
      status: "done",
      txHash: hash,
      detail: "Sell 100 XLM @ 0.5 USDC",
    });
  } catch (e) {
    onFinish({ id: "sell-offer", status: "failed", error: errorMessage(e) });
  }

  // step 6: co-signer (best-effort)
  onStart("co-signer");
  try {
    const cosigner = Keypair.random().publicKey();
    const hash = await submitClassic(horizon, network, secret, publicKey, (b) =>
      b.addOperation(
        Operation.setOptions({
          signer: { ed25519PublicKey: cosigner, weight: 1 },
        }),
      ),
    );
    onFinish({
      id: "co-signer",
      status: "done",
      txHash: hash,
      detail: `${cosigner.slice(0, 6)}…${cosigner.slice(-4)} @ weight 1`,
    });
  } catch (e) {
    onFinish({ id: "co-signer", status: "failed", error: errorMessage(e) });
  }

  // step 7: credit balances (best-effort)
  onStart("credit-balances");
  try {
    if (aquaIssuerKp === null || yxlmIssuerKp === null) {
      throw new Error("credit-balances: trustlines step didn't produce issuer keypairs");
    }
    const aquaKp = aquaIssuerKp;
    const yxlmKp = yxlmIssuerKp;
    const aquaHash = await submitFromAccount(horizon, network, aquaKp, (b) =>
      b.addOperation(
        Operation.payment({
          destination: publicKey,
          asset: new Asset("AQUA", aquaKp.publicKey()),
          amount: "1000",
        }),
      ),
    );
    const yxlmHash = await submitFromAccount(horizon, network, yxlmKp, (b) =>
      b.addOperation(
        Operation.payment({
          destination: publicKey,
          asset: new Asset("YXLM", yxlmKp.publicKey()),
          amount: "500",
        }),
      ),
    );
    onFinish({
      id: "credit-balances",
      status: "done",
      txHash: aquaHash,
      detail: `1000 AQUA + 500 YXLM minted (last tx ${yxlmHash.slice(0, 8)}…)`,
    });
  } catch (e) {
    onFinish({ id: "credit-balances", status: "skipped", error: errorMessage(e) });
  }

  // step 8: claimable balance (best-effort)
  onStart("claimable-balance");
  try {
    const hash = await submitClassic(horizon, network, secret, publicKey, (b) =>
      b.addOperation(
        Operation.createClaimableBalance({
          asset: Asset.native(),
          amount: "5",
          claimants: [new Claimant(publicKey, Claimant.predicateUnconditional())],
        }),
      ),
    );
    onFinish({
      id: "claimable-balance",
      status: "done",
      txHash: hash,
      detail: "5 XLM CB created with self as unconditional claimant",
    });
  } catch (e) {
    onFinish({ id: "claimable-balance", status: "skipped", error: errorMessage(e) });
  }

  // step 9: supply collateral to the blend testnet pool (best-effort, soroban)
  onStart("blend-supply");
  try {
    const hash = await blendSupplyXlm(network, secret, publicKey);
    onFinish({
      id: "blend-supply",
      status: "done",
      txHash: hash,
      detail: "50 XLM supplied as collateral to Blend testnet pool",
    });
  } catch (e) {
    onFinish({ id: "blend-supply", status: "skipped", error: errorMessage(e) });
  }

  // step 10: soroswap router swap XLM → USDC (best-effort, soroban)
  onStart("soroswap-swap");
  let soroswapSwapSucceeded = false;
  try {
    const hash = await soroswapSwap(network, secret, publicKey, 500_000_000n);
    soroswapSwapSucceeded = true;
    onFinish({
      id: "soroswap-swap",
      status: "done",
      txHash: hash,
      detail: "Swapped 50 XLM into USDC through the Soroswap router",
    });
  } catch (e) {
    onFinish({ id: "soroswap-swap", status: "skipped", error: errorMessage(e) });
  }

  // step 11: soroswap LP add (best-effort, depends on the swap leaving USDC behind)
  onStart("soroswap-lp");
  if (!soroswapSwapSucceeded) {
    onFinish({
      id: "soroswap-lp",
      status: "skipped",
      error: "soroswap-swap skipped; no USDC balance to pair with XLM",
    });
  } else {
    try {
      const hash = await soroswapAddLiquidity(network, secret, publicKey);
      onFinish({
        id: "soroswap-lp",
        status: "done",
        txHash: hash,
        detail: "Added XLM + USDC liquidity to the Soroswap pair",
      });
    } catch (e) {
      onFinish({ id: "soroswap-lp", status: "skipped", error: errorMessage(e) });
    }
  }

  // step 12: sep-41 allowance (best-effort, soroban)
  onStart("sep41-allowance");
  try {
    const spender = Keypair.random().publicKey();
    const hash = await approveSep41(network, secret, publicKey, spender);
    onFinish({
      id: "sep41-allowance",
      status: "done",
      txHash: hash,
      detail: "100 stroops approved on the native-XLM SAC",
    });
  } catch (e) {
    // soroban testnet rpc is the most likely flakiness source; mark skipped rather than failed
    // so the demo summary doesn't read as a hard failure
    onFinish({
      id: "sep41-allowance",
      status: "skipped",
      error: errorMessage(e),
    });
  }

  // step 8: ready
  onStart("ready");
  const connector = new SecretKeyConnector(secret);
  const explorerUrl = explorerAccountUrl(network, publicKey);
  onFinish({ id: "ready", status: "done", detail: "Connector loaded" });

  return { publicKey, connector, explorerUrl };
}

export const FRIENDBOT_TIMEOUT_MS = 20_000;

export async function friendbotFund(
  friendbotUrl: string,
  address: string,
  timeoutMs: number = FRIENDBOT_TIMEOUT_MS,
): Promise<void> {
  const url = `${friendbotUrl}?addr=${encodeURIComponent(address)}`;
  let res: Response;
  try {
    // a hung friendbot would otherwise keep the setup spinner going forever
    res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`Friendbot did not respond within ${timeoutMs / 1000} seconds.`);
    }
    throw e;
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.text();
      detail = body.length > 200 ? `${body.slice(0, 200)}…` : body;
    } catch {
      // status code alone is enough context
    }
    throw new Error(`Friendbot returned ${res.status}${detail.length > 0 ? `: ${detail}` : ""}`);
  }
}

async function submitClassic(
  horizon: Horizon.Server,
  network: NetworkConfig,
  secret: string,
  publicKey: string,
  build: (b: TransactionBuilder) => TransactionBuilder,
): Promise<string> {
  const account = await horizon.loadAccount(publicKey);
  const builder = new TransactionBuilder(account, {
    // BASE_FEE = "100" stroops per op; pad to 1000 so a momentarily congested
    // testnet still accepts the tx (well under 1 cent total)
    fee: "1000",
    networkPassphrase: network.passphrase,
  });
  const tx = build(builder).setTimeout(120).build();
  tx.sign(Keypair.fromSecret(secret));
  try {
    const res = await horizon.submitTransaction(tx);
    return res.hash;
  } catch (e) {
    throw new Error(formatHorizonError(e));
  }
}

interface HorizonErrorShape {
  readonly response?: {
    readonly data?: {
      readonly extras?: {
        readonly result_codes?: unknown;
        readonly result_xdr?: unknown;
      };
      readonly title?: unknown;
    };
    readonly status?: number;
  };
  readonly message?: string;
}

function formatHorizonError(e: unknown): string {
  const err = e as HorizonErrorShape;
  const status = err?.response?.status;
  const codes = err?.response?.data?.extras?.result_codes;
  const title = err?.response?.data?.title;
  const parts: string[] = [];
  if (status !== undefined) parts.push(`status ${status}`);
  if (codes !== undefined) parts.push(`codes ${JSON.stringify(codes)}`);
  else if (title !== undefined) parts.push(String(title));
  else if (err?.message !== undefined) parts.push(err.message);
  return parts.length > 0 ? parts.join("; ") : "Horizon rejected the transaction";
}

async function approveSep41(
  network: NetworkConfig,
  secret: string,
  publicKey: string,
  spender: string,
): Promise<string> {
  const horizon = new Horizon.Server(network.horizon);
  const server = getRpc(network);
  const account = await horizon.loadAccount(publicKey);
  const latest = await server.getLatestLedger();
  // ~5 days of ledgers (one ledger ≈ 5s on testnet); plenty of headroom for the demolish flow
  const liveUntil = latest.sequence + 86_400;
  const tx = await buildApprove(
    server,
    nativeSac(network),
    publicKey,
    spender,
    100n,
    liveUntil,
    network,
    account,
  );
  assertDemoSorobanTx(tx, publicKey, network, { contractId: nativeSac(network), fn: "approve" });
  tx.sign(Keypair.fromSecret(secret));
  return submitAndPollSoroban(server, tx, "sep41-allowance");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// submitClassic equivalent that signs with a caller-supplied keypair instead
async function submitFromAccount(
  horizon: Horizon.Server,
  network: NetworkConfig,
  signer: Keypair,
  build: (b: TransactionBuilder) => TransactionBuilder,
): Promise<string> {
  const account = await horizon.loadAccount(signer.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: network.passphrase,
  });
  const tx = build(builder).setTimeout(120).build();
  tx.sign(signer);
  try {
    const res = await horizon.submitTransaction(tx);
    return res.hash;
  } catch (e) {
    throw new Error(formatHorizonError(e));
  }
}

// supplies XLM into the blend testnet pool as collateral
async function blendSupplyXlm(
  network: NetworkConfig,
  secret: string,
  publicKey: string,
): Promise<string> {
  const horizon = new Horizon.Server(network.horizon);
  const server = getRpc(network);
  const account = await horizon.loadAccount(publicKey);

  const request = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("address"),
      val: new Address(nativeSac(network)).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("amount"),
      val: xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString("0"),
          lo: xdr.Uint64.fromString("500000000"), // 50 XLM, 7 decimals
        }),
      ),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("request_type"),
      val: xdr.ScVal.scvU32(2), // RequestType.SupplyCollateral
    }),
  ]);

  const contract = new Contract(BLEND_POOL_TESTNET);
  const fromScVal = new Address(publicKey).toScVal();
  const tx = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      contract.call(
        "submit",
        fromScVal, // from
        fromScVal, // spender
        fromScVal, // to
        xdr.ScVal.scvVec([request]),
      ),
    )
    .setTimeout(120)
    .build();

  const prepared = await assembleSubmittable(server, tx);
  assertDemoSorobanTx(prepared, publicKey, network, {
    contractId: BLEND_POOL_TESTNET,
    fn: "submit",
  });
  prepared.sign(Keypair.fromSecret(secret));
  return submitAndPollSoroban(server, prepared, "blend-supply");
}

// read-only call against the soroswap router (simulation only, nothing signed)
async function routerRead(
  network: NetworkConfig,
  publicKey: string,
  fn: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const { retval } = await simulateRead(
    getRpc(network),
    SOROSWAP_ROUTER_TESTNET,
    fn,
    args,
    publicKey,
    network,
  );
  return scValToNative(retval);
}

// unix seconds the router compares against the ledger timestamp
function routerDeadline(): xdr.ScVal {
  const deadline = Math.floor(Date.now() / 1000) + 300;
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(deadline)));
}

// XLM → USDC swap_exact_tokens_for_tokens against the soroswap router, the same
// allow-listed on-chain contract the close's own conversions go through
async function soroswapSwap(
  network: NetworkConfig,
  secret: string,
  publicKey: string,
  amountIn: bigint,
): Promise<string> {
  const path = scvVec([scvAddress(nativeSac(network)), scvAddress(usdcSac(network))]);
  const amounts = (await routerRead(network, publicKey, "router_get_amounts_out", [
    scvI128(amountIn),
    path,
  ])) as bigint[];
  const expectedOut = amounts[amounts.length - 1];
  if (expectedOut === undefined || expectedOut <= 0n) {
    throw new Error("Soroswap testnet has no XLM/USDC liquidity right now.");
  }
  // 2% under the quote, so another trade in the same ledger can't revert it
  const amountOutMin = (expectedOut * 98n) / 100n;

  const horizon = new Horizon.Server(network.horizon);
  const server = getRpc(network);
  const account = await horizon.loadAccount(publicKey);
  const tx = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      new Contract(SOROSWAP_ROUTER_TESTNET).call(
        "swap_exact_tokens_for_tokens",
        scvI128(amountIn),
        scvI128(amountOutMin),
        path,
        scvAddress(publicKey),
        routerDeadline(),
      ),
    )
    .setTimeout(120)
    .build();

  const prepared = await assembleSubmittable(server, tx);
  assertDemoSorobanTx(prepared, publicKey, network, {
    contractId: SOROSWAP_ROUTER_TESTNET,
    fn: "swap_exact_tokens_for_tokens",
  });
  prepared.sign(Keypair.fromSecret(secret));
  return submitAndPollSoroban(server, prepared, "soroswap-swap");
}

// amount of b worth amountA at the pool's current ratio: the uniswap-v2 quote the
// router itself uses (router_quote), amountA * reserveB / reserveA
export function quoteAgainstReserves(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  if (amountA <= 0n || reserveA <= 0n || reserveB <= 0n) {
    throw new RangeError("quoteAgainstReserves: amounts and reserves must be positive");
  }
  return (amountA * reserveB) / reserveA;
}

// sizes an add_liquidity deposit to the pool's current ratio. the router only
// accepts a deposit within its minimums of that ratio, so fixed amounts fail
// whenever the testnet price moves. starts from xlmWanted and scales down when
// the USDC on hand can't match it; each minimum is 1% under its side.
export function sizeLiquidityDeposit(
  xlmWanted: bigint,
  usdcAvailable: bigint,
  reserveXlm: bigint,
  reserveUsdc: bigint,
): { xlm: bigint; usdc: bigint; xlmMin: bigint; usdcMin: bigint } {
  if (usdcAvailable <= 0n) {
    throw new Error("No USDC to pair with XLM for the liquidity deposit.");
  }
  let xlm = xlmWanted;
  let usdc = quoteAgainstReserves(xlm, reserveXlm, reserveUsdc);
  if (usdc > usdcAvailable) {
    usdc = usdcAvailable;
    xlm = quoteAgainstReserves(usdc, reserveUsdc, reserveXlm);
  }
  if (xlm <= 0n || usdc <= 0n) {
    throw new Error("The deposit rounds to zero at the pool's current price.");
  }
  return { xlm, usdc, xlmMin: (xlm * 99n) / 100n, usdcMin: (usdc * 99n) / 100n };
}

// adds liquidity to the soroswap XLM/USDC pair, sized from the live reserves
async function soroswapAddLiquidity(
  network: NetworkConfig,
  secret: string,
  publicKey: string,
): Promise<string> {
  const horizon = new Horizon.Server(network.horizon);
  const server = getRpc(network);
  const xlmSac = nativeSac(network);
  const usdcId = usdcSac(network);

  // the router's library get_reserves returns the pair in the order asked for
  const factory = (await routerRead(network, publicKey, "get_factory", [])) as string;
  const [reserveXlm, reserveUsdc] = (await routerRead(network, publicKey, "get_reserves", [
    scvAddress(factory),
    scvAddress(xlmSac),
    scvAddress(usdcId),
  ])) as [bigint, bigint];
  const usdcHeld = await balance(server, usdcId, publicKey, publicKey, network);
  // 20 XLM, or less when the swapped USDC can't match it
  const deposit = sizeLiquidityDeposit(200_000_000n, usdcHeld, reserveXlm, reserveUsdc);

  const account = await horizon.loadAccount(publicKey);
  const tx = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      new Contract(SOROSWAP_ROUTER_TESTNET).call(
        "add_liquidity",
        scvAddress(xlmSac),
        scvAddress(usdcId),
        scvI128(deposit.xlm),
        scvI128(deposit.usdc),
        scvI128(deposit.xlmMin),
        scvI128(deposit.usdcMin),
        scvAddress(publicKey),
        routerDeadline(),
      ),
    )
    .setTimeout(120)
    .build();

  const prepared = await assembleSubmittable(server, tx);
  assertDemoSorobanTx(prepared, publicKey, network, {
    contractId: SOROSWAP_ROUTER_TESTNET,
    fn: "add_liquidity",
  });
  prepared.sign(Keypair.fromSecret(secret));
  return submitAndPollSoroban(server, prepared, "soroswap-lp");
}

export interface ExpectedDemoCall {
  readonly contractId: string;
  readonly fn: string;
}

// checked before the demo key signs any soroban transaction: exactly one
// invocation of the expected contract function, sourced from the demo account,
// with every authorization coming from that account and rooted in that same
// call. a protocol contract must also pass the allow-list; the one
// non-protocol call (approve on the native XLM SAC) may authorize nothing nested
// and must grant from the demo account.
export function assertDemoSorobanTx(
  tx: Transaction | FeeBumpTransaction,
  publicKey: string,
  network: NetworkConfig,
  expected: ExpectedDemoCall,
): asserts tx is Transaction {
  const fail = (why: string): never => {
    throw new Error(`Refusing to sign the demo ${expected.fn} transaction: ${why}.`);
  };
  if (tx instanceof FeeBumpTransaction) return fail("it is a fee-bump envelope");
  if (tx.source !== publicKey) fail(`its source is ${tx.source}, not the demo account`);
  if (tx.operations.length !== 1) fail(`it has ${tx.operations.length} operations`);
  const op = tx.operations[0]!;
  if (op.type !== "invokeHostFunction") return fail(`its operation is ${op.type}`);
  if (op.source !== undefined && op.source !== publicKey) {
    fail(`its operation runs as ${op.source}`);
  }
  const ihf = op as Operation.InvokeHostFunction;
  if (ihf.func.type !== "hostFunctionTypeInvokeContract") {
    return fail(`it runs ${ihf.func.type}`);
  }
  const call = ihf.func.invokeContract;
  const isExpected = (c: xdr.InvokeContractArgs) =>
    Address.fromScAddress(c.contractAddress).toString() === expected.contractId &&
    c.functionName.toString() === expected.fn;
  if (!isExpected(call)) fail("it calls a different contract or function");

  const isNativeApprove = expected.contractId === nativeSac(network) && expected.fn === "approve";
  (ihf.auth ?? []).forEach((entry, i) => {
    if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
      fail(`authorization ${i} is signed by another address`);
    }
    const root = entry.rootInvocation;
    if (
      root.function.type !== "sorobanAuthorizedFunctionTypeContractFn" ||
      !isExpected(root.function.contractFn)
    ) {
      fail(`authorization ${i} is for a different call`);
    }
    if (isNativeApprove && root.subInvocations.length > 0) {
      fail(`authorization ${i} authorizes nested calls`);
    }
  });

  if (isNativeApprove) {
    const from = call.args[0] === undefined ? undefined : scValToNative(call.args[0]);
    if (from !== publicKey) fail("the allowance is not granted from the demo account");
  } else {
    assertTransactionAllowed(tx, network);
  }
}

// how long and how often a demo submission is polled before it is reported as
// not landed
export interface PollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

const DEFAULT_POLL: PollOptions = { timeoutMs: 30_000, intervalMs: 800 };

// send and wait for the result. only PENDING (queued) and DUPLICATE (already
// queued) mean the network took the transaction; TRY_AGAIN_LATER and ERROR were
// never queued, so polling for them would only wait out the timeout.
export async function submitAndPollSoroban(
  server: Pick<ReturnType<typeof getRpc>, "sendTransaction" | "getTransaction">,
  tx: Transaction,
  stepLabel: string,
  poll: PollOptions = DEFAULT_POLL,
): Promise<string> {
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    const detail = sent.errorResult ? `: ${sent.errorResult.toXdr("base64")}` : "";
    throw new Error(
      `${stepLabel}: the network did not accept the transaction (${sent.status})${detail}`,
    );
  }
  const hash = sent.hash;
  const deadline = Date.now() + poll.timeoutMs;
  while (Date.now() < deadline) {
    await delay(poll.intervalMs);
    const st = await server.getTransaction(hash);
    if (st.status === "SUCCESS") return hash;
    if (st.status === "FAILED") {
      throw new Error(
        `${stepLabel} failed on-chain: ${st.resultXdr?.toXdr("base64") ?? "<no result>"}`,
      );
    }
  }
  throw new Error(
    `${stepLabel} tx ${hash.slice(0, 8)}… was accepted but not in a ledger after ${
      poll.timeoutMs / 1000
    }s`,
  );
}
