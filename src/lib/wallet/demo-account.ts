// one-click testnet/futurenet "showcase" account

import {
  Address,
  Asset,
  Claimant,
  Contract,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { buildApprove } from "@/lib/soroban/sep41";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

// circle testnet usdc — issuer published in https://testanchor.stellar.org/.well-known/stellar.toml
const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// native xlm SAC on testnet — confirmed via the stellar laboratory
const NATIVE_XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
// blend testnet pool TestnetV2 — from BLEND_TESTNET_POOLS in src/lib/adapters/blend/pools.ts
const BLEND_POOL_TESTNET = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
// soroswap testnet router — from TESTNET_SOROSWAP_ENTRIES in src/lib/config/contracts.ts
const SOROSWAP_ROUTER_TESTNET = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";

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
    description: "Ed25519 keypair created in this tab; the seed never leaves memory.",
  },
  {
    id: "friendbot",
    label: "Fund with friendbot",
    description: "10,000 testnet XLM seeded from friendbot.stellar.org.",
  },
  {
    id: "trustlines",
    label: "Open trustlines",
    description: "USDC, AQUA, YXLM — three credit assets the demolisher must close.",
  },
  {
    id: "data-entries",
    label: "Write data entries",
    description: "Two manageData entries: demo:protocol, demo:purpose.",
  },
  {
    id: "sell-offer",
    label: "Place a sell offer",
    description: "Sell 100 XLM for 50 USDC, far from any fill price.",
  },
  {
    id: "co-signer",
    label: "Add a co-signer",
    description: "Random ed25519 key added at weight 1; exercises set_options cleanup.",
  },
  {
    id: "credit-balances",
    label: "Issue credit balances",
    description:
      "AQUA + YXLM issuers (created in the trustlines step) mint tokens to your account.",
  },
  {
    id: "claimable-balance",
    label: "Create a claimable balance",
    description:
      "5 XLM CB with yourself as the unconditional claimant; demolisher must claim and revoke its sponsorship.",
  },
  {
    id: "blend-supply",
    label: "Supply collateral to Blend",
    description:
      "Supplies 50 XLM into the Blend testnet pool as collateral; demolisher will withdraw it before merge.",
  },
  {
    id: "soroswap-swap",
    label: "Swap XLM → USDC on Soroswap",
    description:
      "Aggregator-routed swap of 50 XLM for testnet USDC; gives the demolisher a Soroban credit balance to convert back.",
  },
  {
    id: "soroswap-lp",
    label: "Add liquidity to Soroswap LP",
    description:
      "Mints LP shares on the XLM/USDC pair; demolisher must redeem the share before merge.",
  },
  {
    id: "sep41-allowance",
    label: "Approve a SEP-41 allowance",
    description: "Grants the native-XLM SAC permission to spend 100 stroops on your behalf.",
  },
  {
    id: "ready",
    label: "Ready to demolish",
    description: "Account is on-chain and discoverable. Verify on stellar.expert before signing.",
  },
];

export type DemoStepStatus = "pending" | "active" | "done" | "failed" | "skipped";

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
  if (network.friendbot === null) {
    throw new Error(
      `Demo account is only available on networks with a friendbot. Current network: ${network.id}.`,
    );
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
    await friendbotFund(network.friendbot, publicKey);
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

  // step 10: soroswap aggregator swap XLM → USDC (best-effort, soroban + REST)
  onStart("soroswap-swap");
  let soroswapSwapSucceeded = false;
  try {
    const hash = await soroswapSwap(network, secret, publicKey, "50.0000000");
    soroswapSwapSucceeded = true;
    onFinish({
      id: "soroswap-swap",
      status: "done",
      txHash: hash,
      detail: "Routed 50 XLM through the Soroswap aggregator into USDC",
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

export function explorerAccountUrl(network: NetworkConfig, publicKey: string): string {
  const slug = network.id === "mainnet" ? "public" : network.id;
  return `https://stellar.expert/explorer/${slug}/account/${publicKey}`;
}

export function explorerTxUrl(network: NetworkConfig, txHash: string): string {
  const slug = network.id === "mainnet" ? "public" : network.id;
  return `https://stellar.expert/explorer/${slug}/tx/${txHash}`;
}

async function friendbotFund(friendbotUrl: string, address: string): Promise<void> {
  const url = `${friendbotUrl}?addr=${encodeURIComponent(address)}`;
  const res = await fetch(url, { method: "GET" });
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
  return parts.length > 0 ? parts.join(" — ") : "Horizon rejected the transaction";
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
    NATIVE_XLM_SAC_TESTNET,
    publicKey,
    spender,
    100n,
    liveUntil,
    network,
    account,
  );
  tx.sign(Keypair.fromSecret(secret));
  const submitted = await server.sendTransaction(tx);
  if (submitted.status === "ERROR") {
    throw new Error(`sendTransaction rejected: ${submitted.errorResult?.toXDR("base64") ?? ""}`);
  }
  // sendTransaction only confirms queue acceptance
  const hash = submitted.hash;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await delay(800);
    const status = await server.getTransaction(hash);
    if (status.status === "SUCCESS") return hash;
    if (status.status === "FAILED") {
      const resultXdr = status.resultXdr?.toXDR("base64") ?? "<no result>";
      throw new Error(`approve tx failed on-chain: ${resultXdr}`);
    }
    // NOT_FOUND → still propagating; keep polling
  }
  throw new Error(`approve tx ${hash.slice(0, 8)}… stayed PENDING after 30s`);
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
      val: new Address(NATIVE_XLM_SAC_TESTNET).toScVal(),
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

  const { assembleSubmittable } = await import("@/lib/soroban/simulate");
  const prepared = await assembleSubmittable(server, tx);
  if ("innerTransaction" in prepared) throw new Error("blend-supply: got FeeBumpTransaction");

  prepared.sign(Keypair.fromSecret(secret));
  return submitAndPollSoroban(server, prepared, "blend-supply");
}

// XLM → USDC swap via the soroswap aggregator proxy
async function soroswapSwap(
  network: NetworkConfig,
  secret: string,
  publicKey: string,
  amountInXlm: string,
): Promise<string> {
  const { soroswapClient } = await import("@/lib/adapters/soroswap/client");
  if (network.id !== "testnet" && network.id !== "mainnet") {
    throw new Error(`soroswap-swap unsupported on network "${network.id}"`);
  }
  const usdcSacAddress = new Asset("USDC", USDC_TESTNET_ISSUER).contractId(network.passphrase);
  const assetInAddress = Asset.native().contractId(network.passphrase);
  const amountInStroops = BigInt(Math.round(Number(amountInXlm) * 1e7));

  let quote;
  try {
    quote = await soroswapClient.quote({
      assetIn: assetInAddress,
      assetOut: usdcSacAddress,
      amount: amountInStroops,
      tradeType: "EXACT_IN",
      protocols: ["soroswap", "phoenix", "aqua"],
      maxHops: 2,
      slippageBps: 200,
      network: network.id,
    });
  } catch (e) {
    // most common testnet failure: "No path found" — soroswap testnet has zero
    // pools at the moment, so the aggregator can't route any trade
    if (e instanceof Error && /no path|UPSTREAM_ERROR/i.test(e.message)) {
      throw new Error(
        `Soroswap ${network.id} has no liquidity for this pair right now (no on-chain pools).`,
      );
    }
    throw e;
  }

  const built = await soroswapClient.build({
    quote,
    from: publicKey,
    to: publicKey,
    network: network.id,
  });

  const tx = TransactionBuilder.fromXDR(built.xdr, network.passphrase);
  if ("innerTransaction" in tx) {
    throw new Error("soroswap-swap: aggregator returned a fee-bump transaction");
  }
  tx.sign(Keypair.fromSecret(secret));

  const server = getRpc(network);
  return submitAndPollSoroban(server, tx, "soroswap-swap");
}

// adds liquidity to the soroswap XLM/USDC pair directly against the testnet
async function soroswapAddLiquidity(
  network: NetworkConfig,
  secret: string,
  publicKey: string,
): Promise<string> {
  const horizon = new Horizon.Server(network.horizon);
  const server = getRpc(network);
  const account = await horizon.loadAccount(publicKey);

  const xlmSac = Asset.native().contractId(network.passphrase);
  const usdcSac = new Asset("USDC", USDC_TESTNET_ISSUER).contractId(network.passphrase);

  // 20 XLM + 10 USDC desired, 1% minimums
  const amountXlmDesired = 200_000_000n; // 20 XLM, 7 decimals
  const amountUsdcDesired = 100_000_000n; // 10 USDC, 7 decimals
  const amountXlmMin = 198_000_000n;
  const amountUsdcMin = 99_000_000n;
  const deadlineSec = BigInt(Math.floor(Date.now() / 1000) + 300);

  const contract = new Contract(SOROSWAP_ROUTER_TESTNET);
  const tx = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      contract.call(
        "add_liquidity",
        new Address(xlmSac).toScVal(),
        new Address(usdcSac).toScVal(),
        xdr.ScVal.scvI128(bigintToInt128(amountXlmDesired)),
        xdr.ScVal.scvI128(bigintToInt128(amountUsdcDesired)),
        xdr.ScVal.scvI128(bigintToInt128(amountXlmMin)),
        xdr.ScVal.scvI128(bigintToInt128(amountUsdcMin)),
        new Address(publicKey).toScVal(),
        xdr.ScVal.scvU64(xdr.Uint64.fromString(deadlineSec.toString())),
      ),
    )
    .setTimeout(120)
    .build();

  const { assembleSubmittable } = await import("@/lib/soroban/simulate");
  const prepared = await assembleSubmittable(server, tx);
  if ("innerTransaction" in prepared) throw new Error("soroswap-lp: got FeeBumpTransaction");

  prepared.sign(Keypair.fromSecret(secret));
  return submitAndPollSoroban(server, prepared, "soroswap-lp");
}

// build an xdr.Int128Parts from a positive bigint. soroswap router amounts are
// always non-negative; this helper trades correctness-for-negatives for brevity
function bigintToInt128(n: bigint): xdr.Int128Parts {
  const mask = (1n << 64n) - 1n;
  const lo = n & mask;
  const hi = n >> 64n;
  return new xdr.Int128Parts({
    hi: xdr.Int64.fromString(hi.toString()),
    lo: xdr.Uint64.fromString(lo.toString()),
  });
}

// shared sendTransaction + polling loop for soroban submissions
async function submitAndPollSoroban(
  server: Awaited<ReturnType<typeof getRpc>>,
  tx: Parameters<typeof server.sendTransaction>[0],
  stepLabel: string,
): Promise<string> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(
      `${stepLabel}: sendTransaction rejected: ${sent.errorResult?.toXDR("base64") ?? ""}`,
    );
  }
  const hash = sent.hash;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await delay(800);
    const st = await server.getTransaction(hash);
    if (st.status === "SUCCESS") return hash;
    if (st.status === "FAILED") {
      throw new Error(
        `${stepLabel} failed on-chain: ${st.resultXdr?.toXDR("base64") ?? "<no result>"}`,
      );
    }
  }
  throw new Error(`${stepLabel} tx ${hash.slice(0, 8)}… stayed PENDING after 30s`);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
