import { describe, it, expect } from "vitest";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

import { getRpc } from "@/lib/soroban/rpc-client";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { TESTNET } from "@/lib/config/networks";
import { auditAccount } from "@/lib/stellar/account-audit";
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import { enumerateAllowances } from "@/lib/soroban/allowances";
import { buildApprove } from "@/lib/soroban/sep41";
import { generatePlan } from "@/lib/plan/generator";
import { hydratePlanTransactions } from "@/lib/plan/hydration";
import { simulateNode } from "@/lib/plan/simulator";
import { topologicalOrder } from "@/lib/plan/tree";

// Live testnet proof that the FULL close pipeline runs end-to-end against real
// contracts for a MIXED plan (a Soroban step + the classic merge):
//   real DeFi discovery (all 4 protocols) -> generatePlan -> hydration
//   (builds the Soroban tx on-chain) -> per-step simulation (each step simulates)
//
// The account is seeded with a real on-chain SEP-41 allowance (on a deployed
// token) so the plan carries a RevokeAllowance node alongside the classic merge.
// Seeding a live Blend/Aquarius/Soroswap/FxDAO POSITION additionally needs
// entry-side liquidity/pool state (the tool unwinds, it doesn't open positions),
// so those unwinds are proven at the unit level + by the on-chain SEP-41 / classic
// / pool / multisig closes; this test proves the pipeline itself runs live.
const rpc = getRpc(TESTNET);
const horizon = getHorizon(TESTNET);
const horizonDirect = new Horizon.Server(TESTNET.horizon, { allowHttp: false });

async function friendbot(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: ${res.status}`);
}

async function submitClassic(kp: Keypair, build: (b: TransactionBuilder) => void): Promise<void> {
  const account = await horizonDirect.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase });
  build(b);
  const tx = b.setTimeout(120).build();
  tx.sign(kp);
  await horizonDirect.submitTransaction(tx);
}

async function signSubmitSoroban(kp: Keypair, prepared: Transaction): Promise<void> {
  const p = await rpc.prepareTransaction(prepared);
  const tx = p as Transaction;
  tx.sign(kp);
  const send = await rpc.sendTransaction(tx);
  if (send.status !== "PENDING" && send.status !== "DUPLICATE") {
    throw new Error(`sendTransaction returned ${send.status}`);
  }
  const res = await rpc.pollTransaction(send.hash, { attempts: 60 });
  if (res.status !== "SUCCESS") throw new Error(`soroban tx failed: ${res.status}`);
}

describe("integration: full DeFi close pipeline against live testnet", () => {
  it("discovers, plans, hydrates, and simulates a mixed plan end-to-end", async () => {
    const issuer = Keypair.random();
    const owner = Keypair.random();
    const spender = Keypair.random();
    const destination = Keypair.random().publicKey();
    const asset = new Asset("PIPE", issuer.publicKey());
    const tokenId = asset.contractId(TESTNET.passphrase);

    await Promise.all([friendbot(issuer.publicKey()), friendbot(owner.publicKey())]);

    // trustline (no balance needed) + deploy the SAC + set a real allowance, so
    // the account carries an on-chain SEP-41 allowance (a RevokeAllowance node).
    await submitClassic(owner, (b) => b.addOperation(Operation.changeTrust({ asset })));
    const ownerAcct = await horizonDirect.loadAccount(owner.publicKey());
    const deployTx = new TransactionBuilder(ownerAcct, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.createStellarAssetContract({ asset }))
      .setTimeout(120)
      .build();
    await signSubmitSoroban(owner, deployTx);

    const latest = await rpc.getLatestLedger();
    const approve = await buildApprove(
      rpc,
      tokenId,
      owner.publicKey(),
      spender.publicKey(),
      1000n,
      latest.sequence + 500_000,
      TESTNET,
      await horizonDirect.loadAccount(owner.publicKey()),
    );
    await signSubmitSoroban(owner, approve);

    // ── the production pipeline, all against live testnet ──
    const audit = await auditAccount(owner.publicKey(), TESTNET);

    // real DeFi discovery across all four protocols — clean for this account
    const positions = await new DirectContractProvider().getPositions(owner.publicKey(), TESTNET);
    expect(positions.errors).toEqual([]);

    // the allowance is found by the live event scan
    const after = await rpc.getLatestLedger();
    const allowances = await enumerateAllowances(rpc, owner.publicKey(), after.sequence, 20_000);
    const seeded = allowances.find(
      (a) => a.contractId === tokenId && a.spender === spender.publicKey(),
    );
    expect(seeded, "the seeded allowance must be discovered").toBeDefined();

    // generate the plan: a RevokeAllowance (Soroban) + the FinalClassicTx merge
    const tree = generatePlan(audit, positions, allowances, destination, {
      selectedAllowances: [`${tokenId}|${spender.publicKey()}`],
    });
    const kinds = new Set([...tree.allNodes.values()].map((n) => n.kind));
    expect(kinds.has("RevokeAllowance")).toBe(true);
    expect(kinds.has("FinalClassicTx")).toBe(true);

    // hydrate: builds the Soroban RevokeAllowance transaction on-chain
    const ledger = await rpc.getLatestLedger();
    const { failures } = await hydratePlanTransactions(tree, owner.publicKey(), {
      rpc,
      horizon,
      network: TESTNET,
      currentLedger: ledger.sequence,
      fetchSourceAccount: (pk) => horizonDirect.loadAccount(pk),
    });
    expect(failures).toEqual([]);

    // simulate EVERY step: the Soroban revoke against live RPC, the classic merge
    // built + validated in-memory. A doomed step would throw here.
    for (const node of topologicalOrder(tree)) {
      const outcome = await simulateNode(node, {
        server: rpc,
        network: TESTNET,
        userPublicKey: owner.publicKey(),
        fetchSourceAccount: (pk) => horizonDirect.loadAccount(pk),
      });
      expect(outcome.kind === "soroban" || outcome.kind === "classic").toBe(true);
    }
  });
});
