import { describe, it, expect } from "vitest";
import {
  Asset,
  BASE_FEE,
  Keypair,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  Operation,
  TransactionBuilder,
  getLiquidityPoolId,
  type Transaction,
} from "@stellar/stellar-sdk";
import { auditAccount, AccountNotFoundError } from "@/lib/stellar/account-audit";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { TESTNET } from "@/lib/config/networks";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";
import { executePlanTreeOnChain, type ConfirmationReceipt } from "@/lib/orchestrator/executor";
import { buildPlanTree, type PlanNode } from "@/lib/plan/tree";
import { pathKey } from "@/lib/types/plan";
import type { AssetIdentifier } from "@/lib/types/account";

// Live testnet reproduction of SEC-13. An account that holds a classic (CAP-38)
// liquidity pool can't be closed in a single sweep: a liquidity_pool_withdraw
// credits the pool's underlying assets, so removing their trustlines — or the
// account_merge — in the SAME transaction reverts (the pre-withdraw audit never
// saw the credited balance). The fix isolates the withdraw into a leading batch
// and re-audits between batches. This test seeds such an account and drives the
// REAL executor (executePlanTreeOnChain), proving the two-phase close converges.

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

async function submitAs(kp: Keypair, build: (b: TransactionBuilder) => void): Promise<void> {
  const account = await server.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  });
  build(builder);
  builder.setTimeout(120);
  const tx = builder.build();
  tx.sign(kp);
  await server.submitTransaction(tx);
}

// production-shaped classic submit, mirroring page-flow-machine's executeActor:
// a missing hash is treated as a failure rather than a fabricated success.
async function submitClassic(signedXdr: string): Promise<ConfirmationReceipt> {
  const signed = TransactionBuilder.fromXDR(signedXdr, TESTNET.passphrase) as Transaction;
  let res: { readonly hash?: string; readonly ledger?: number };
  try {
    res = (await server.submitTransaction(signed)) as {
      readonly hash?: string;
      readonly ledger?: number;
    };
  } catch (err) {
    const anyErr = err as { response?: { data?: { extras?: { result_codes?: unknown } } } };
    const codes = anyErr.response?.data?.extras?.result_codes;
    throw new Error(
      `submitClassic rejected: ${codes ? JSON.stringify(codes) : "<no result_codes>"}`,
    );
  }
  if (typeof res.hash !== "string" || res.hash.length === 0) {
    throw new Error("submitClassic: Horizon accepted the transaction but returned no hash");
  }
  return { txHash: res.hash, ledger: res.ledger ?? 0 };
}

describe("integration: two-phase liquidity-pool close (testnet, SEC-13)", () => {
  it("withdraws a classic LP, then returns residue and merges across phases", async () => {
    const kp = Keypair.random();
    const issuer = Keypair.random();
    const destination = Keypair.random();

    await friendbotFund(kp.publicKey());
    await friendbotFund(issuer.publicKey());
    await friendbotFund(destination.publicKey());

    const usdc = new Asset("USDC", issuer.publicKey());
    const lp = new LiquidityPoolAsset(Asset.native(), usdc, LiquidityPoolFeeV18);
    const poolId = getLiquidityPoolId("constant_product", lp.getLiquidityPoolParameters()).toString(
      "hex",
    );

    // seed the pool-holding account:
    // 1. trust USDC, 2. receive EXACTLY the deposit amount (so no USDC remains at
    //    audit time — the credited balance appears only AFTER the withdraw),
    // 3. trust the pool share and deposit XLM+USDC to mint shares.
    await submitAs(kp, (b) => b.addOperation(Operation.changeTrust({ asset: usdc })));
    await submitAs(issuer, (b) =>
      b.addOperation(Operation.payment({ destination: kp.publicKey(), asset: usdc, amount: "5" })),
    );
    await submitAs(kp, (b) => {
      b.addOperation(Operation.changeTrust({ asset: lp }));
      b.addOperation(
        Operation.liquidityPoolDeposit({
          liquidityPoolId: poolId,
          maxAmountA: "5",
          maxAmountB: "5",
          minPrice: "0.5",
          maxPrice: "2",
        }),
      );
    });

    // audit reflects pool shares held with the underlying USDC balance at zero
    const audit = await auditAccount(kp.publicKey(), TESTNET);
    expect(audit.poolShares).toHaveLength(1);
    expect(Number(audit.poolShares[0]!.shareBalance)).toBeGreaterThan(0);
    const usdcBalance = audit.balances.find(
      (b) => b.asset.kind === "credit" && b.asset.code === "USDC",
    );
    expect(usdcBalance).toBeDefined();
    expect(Number(usdcBalance!.amount)).toBe(0);

    // A random-issuer USDC has no testnet market path, so the balance credited by
    // the withdraw is disposed of by returning it to its issuer (explicit consent).
    const usdcAsset: AssetIdentifier = {
      kind: "credit",
      code: "USDC",
      issuer: issuer.publicKey(),
    };
    const node: PlanNode = {
      id: "final",
      kind: "FinalClassicTx",
      dependencies: [],
      description: "close pool-holding account",
      status: "pending",
      metadata: {
        kind: "FinalClassicTx",
        // empty: the executor re-audits and re-batches from fresh on-chain state
        batches: [],
        destination: destination.publicKey(),
        useMediator: false,
        returnToIssuerAssetKeys: [pathKey(usdcAsset)],
      },
    };
    const tree = buildPlanTree([node]);

    await executePlanTreeOnChain(
      { publicKey: kp.publicKey(), tree, previousReceipts: {} },
      {
        network: TESTNET,
        connector: new SecretKeyConnector(kp.secret()),
        horizon: server,
        submitClassic,
        submitSoroban: async () => {
          throw new Error("no soroban node in a classic pool close");
        },
      },
    );

    // the two-phase close merged the account away entirely
    await expect(auditAccount(kp.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });
});
