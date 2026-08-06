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
import { TESTNET } from "@/lib/config/networks";
import { balance, buildApprove, buildTransfer, allowance } from "@/lib/soroban/sep41";
import { enumerateAllowances, buildRevoke } from "@/lib/soroban/allowances";
import { assertSafeTransferInvocation } from "@/lib/soroban/transfer-guard";

// End-to-end proof of Deliverable-1 completion criterion A on LIVE testnet: a
// real SEP-41 token contract is deployed, an account is given a token balance and
// an active allowance, then the ACTUAL production code drives:
//   • discovery-by-simulation (sep41.balance) + per-token drain (buildTransfer,
//     guarded by assertSafeTransferInvocation) — verified on-chain (balances move)
//   • allowance enumeration by event scan (enumerateAllowances) + per-allowance
//     revoke (buildRevoke) — verified on-chain (allowance() reads back 0)
//
// The on-chain token is a Stellar Asset Contract (SAC) over a freshly-issued
// custom asset — the only REAL token contract deployable from a test without a
// compiled Rust WASM. It exercises the exact SEP-41 code paths (balance/transfer/
// approve/allowance) against a live contract. To upgrade this to a genuinely
// non-SAC custom token, drop a compiled SEP-41 wasm at tests/fixtures and deploy
// it via uploadContractWasm + createCustomContract in place of the SAC below; the
// assertions are contract-agnostic.

const rpc = getRpc(TESTNET);
const horizon = new Horizon.Server(TESTNET.horizon, { allowHttp: false });

async function friendbot(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: ${res.status}`);
}

// build, sign, and submit a CLASSIC transaction, waiting for it to apply.
async function submitClassic(kp: Keypair, build: (b: TransactionBuilder) => void): Promise<void> {
  const account = await horizon.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  });
  build(builder);
  const tx = builder.setTimeout(120).build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
}

// prepare (attach footprint), sign, submit a raw SOROBAN op tx and poll to SUCCESS.
async function prepareSignSubmit(kp: Keypair, raw: Transaction): Promise<string> {
  const prepared = await rpc.prepareTransaction(raw);
  return signSubmit(kp, prepared as Transaction);
}

// sign + submit an ALREADY-PREPARED soroban tx (the sep41/allowance builders
// prepare internally) and poll to SUCCESS.
async function signSubmit(kp: Keypair, prepared: Transaction): Promise<string> {
  prepared.sign(kp);
  const send = await rpc.sendTransaction(prepared);
  if (send.status !== "PENDING" && send.status !== "DUPLICATE") {
    throw new Error(`sendTransaction returned ${send.status}`);
  }
  const res = await rpc.pollTransaction(send.hash, { attempts: 60 });
  if (res.status !== "SUCCESS") {
    throw new Error(`soroban tx ${send.hash} did not succeed: ${res.status}`);
  }
  return send.hash;
}

describe("integration: custom SEP-41 drain + allowance revoke on live testnet", () => {
  it("deploys a token, drains the balance, and zeroes an allowance — verified on-chain", async () => {
    const issuer = Keypair.random();
    const owner = Keypair.random();
    const dest = Keypair.random();
    const spender = Keypair.random(); // just an address to approve; needs no funding
    const asset = new Asset("DEMOTOK", issuer.publicKey());
    const tokenId = asset.contractId(TESTNET.passphrase); // the SAC contract id

    await Promise.all([
      friendbot(issuer.publicKey()),
      friendbot(owner.publicKey()),
      friendbot(dest.publicKey()),
    ]);

    // owner + dest trust the asset; issuer funds the owner with 1000 DEMOTOK
    await submitClassic(owner, (b) => b.addOperation(Operation.changeTrust({ asset })));
    await submitClassic(dest, (b) => b.addOperation(Operation.changeTrust({ asset })));
    await submitClassic(issuer, (b) =>
      b.addOperation(Operation.payment({ destination: owner.publicKey(), asset, amount: "1000" })),
    );

    // deploy the SAC so the asset is reachable as a SEP-41 token contract
    const ownerAcct = await horizon.loadAccount(owner.publicKey());
    const deployTx = new TransactionBuilder(ownerAcct, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.createStellarAssetContract({ asset }))
      .setTimeout(120)
      .build();
    await prepareSignSubmit(owner, deployTx);

    // discovery-by-simulation: the production balance() reads 1000 (7 decimals)
    const ownerBalance = await balance(rpc, tokenId, owner.publicKey(), owner.publicKey(), TESTNET);
    expect(ownerBalance).toBe(1000_0000000n);

    // ── allowance leg: approve -> enumerate by event scan -> revoke -> read 0 ──
    const latest = await rpc.getLatestLedger();
    const approveTx = await buildApprove(
      rpc,
      tokenId,
      owner.publicKey(),
      spender.publicKey(),
      500_0000000n,
      latest.sequence + 500_000,
      TESTNET,
      await horizon.loadAccount(owner.publicKey()),
    );
    await signSubmit(owner, approveTx);

    // enumerate by event scan finds the approval the owner just made
    const afterApprove = await rpc.getLatestLedger();
    const records = await enumerateAllowances(rpc, owner.publicKey(), afterApprove.sequence, 20_000);
    const mine = records.find(
      (r) => r.contractId === tokenId && r.spender === spender.publicKey(),
    );
    expect(mine, "the approve event should be discovered by the event scan").toBeDefined();
    expect(mine!.amount).toBe(500_0000000n);

    // revoke it (approve(0)) and confirm on-chain the allowance is zeroed
    const revokeTx = await buildRevoke(
      rpc,
      tokenId,
      owner.publicKey(),
      spender.publicKey(),
      afterApprove.sequence + 500_000,
      TESTNET,
      await horizon.loadAccount(owner.publicKey()),
    );
    await signSubmit(owner, revokeTx);
    const confirmed = await allowance(
      rpc,
      tokenId,
      owner.publicKey(),
      spender.publicKey(),
      owner.publicKey(),
      TESTNET,
    );
    expect(confirmed.amount).toBe(0n); // verified on-chain: the allowance is zeroed

    // ── drain leg: guard the transfer, submit it, confirm balances moved ──
    const transferTx = await buildTransfer(
      rpc,
      tokenId,
      owner.publicKey(),
      dest.publicKey(),
      1000_0000000n,
      TESTNET,
      await horizon.loadAccount(owner.publicKey()),
    );
    // the production auth guard must accept this legitimate source-account transfer
    assertSafeTransferInvocation(transferTx, {
      contractId: tokenId,
      from: owner.publicKey(),
      to: dest.publicKey(),
      amount: 1000_0000000n,
    });
    await signSubmit(owner, transferTx);

    const [ownerAfter, destAfter] = await Promise.all([
      balance(rpc, tokenId, owner.publicKey(), owner.publicKey(), TESTNET),
      balance(rpc, tokenId, dest.publicKey(), dest.publicKey(), TESTNET),
    ]);
    expect(ownerAfter).toBe(0n); // drained
    expect(destAfter).toBe(1000_0000000n); // received on-chain
  });
});
