import { createHash } from "node:crypto";

import { describe, it, expect } from "vitest";
import {
  Address,
  Asset,
  Contract,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc as sorobanRpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { loadBackstopDeposits } from "@/lib/adapters/blend/client";
import {
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_TESTNET_ID,
} from "@/lib/adapters/blend/constants";
import { buildBackstopQueueTx } from "@/lib/adapters/blend/exit";
import { BLEND_TESTNET_INFRASTRUCTURE, BLEND_TESTNET_POOL_IDS } from "@/lib/adapters/blend/pools";
import { MAINNET, TESTNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { fetchLedgerClock } from "@/lib/stellar/ledger-clock";

// discovery dates an existing backstop queue from the chain's own q4w entries
// (M-25). mainnet has too little backstop activity to always hold a locked
// queue (on 2026-10-08 two depositors had one, both unlocking within a week),
// so the test makes its own: a fresh testnet account borrows USDC, joins the
// BLND-USDC comet single-sided, deposits into the backstop and queues twice, the
// second time with the app's own queue builder. the expected dates are decoded
// straight from the UserBalance ledger entry, without the blend sdk, so the two
// readings are independent. the testnet backstop runs the mainnet backstop's
// wasm, which the second test checks, so the result carries over.

const rpc = getRpc(TESTNET);
const horizon = new Horizon.Server(TESTNET.horizon);
const POOL = BLEND_TESTNET_POOL_IDS[0]!;
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);

function infra(name: string): string {
  const entry = BLEND_TESTNET_INFRASTRUCTURE.find((e) => e.name === name);
  if (entry === undefined) throw new Error(`no ${name} in the blend testnet snapshot`);
  return entry.id;
}
const USDC = infra("USDC");
const COMET = infra("comet (BLND/USDC LP)");

const address = (a: string): xdr.ScVal => nativeToScVal(a, { type: "address" });
const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });

async function friendbot(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: ${res.status}`);
}

async function signAndSend(kp: Keypair, tx: Transaction): Promise<xdr.ScVal | undefined> {
  tx.sign(kp);
  const sent = await rpc.sendTransaction(tx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`sendTransaction returned ${sent.status}`);
  }
  const res = await rpc.pollTransaction(sent.hash, { attempts: 60 });
  if (res.status !== "SUCCESS") {
    throw new Error(`soroban tx ${sent.hash} failed: ${res.status}`);
  }
  return res.returnValue;
}

async function call(
  kp: Keypair,
  contractId: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const tx = new TransactionBuilder(await horizon.loadAccount(kp.publicKey()), {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: TESTNET.passphrase,
  })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(120)
    .build();
  const ret = await signAndSend(kp, (await rpc.prepareTransaction(tx)) as Transaction);
  return ret === undefined ? undefined : scValToNative(ret);
}

// the token's SAC name is "CODE:ISSUER"; read it instead of pinning the issuer
async function sacAsset(contractId: string, source: string): Promise<Asset> {
  const tx = new TransactionBuilder(await horizon.loadAccount(source), {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: TESTNET.passphrase,
  })
    .addOperation(new Contract(contractId).call("name"))
    .setTimeout(60)
    .build();
  const sim = await rpc.simulateTransaction(tx);
  if (!sorobanRpc.Api.isSimulationSuccess(sim) || sim.result === undefined) {
    throw new Error(`name() on ${contractId} did not simulate`);
  }
  const [code, issuer] = String(scValToNative(sim.result.retval)).split(":");
  if (code === undefined || issuer === undefined) {
    throw new Error(`${contractId} is not a stellar asset contract`);
  }
  return new Asset(code, issuer);
}

function request(asset: string, type: number, amount: bigint): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("address", { type: "symbol" }),
      val: address(asset),
    }),
    new xdr.ScMapEntry({ key: nativeToScVal("amount", { type: "symbol" }), val: i128(amount) }),
    new xdr.ScMapEntry({
      key: nativeToScVal("request_type", { type: "symbol" }),
      val: nativeToScVal(type, { type: "u32" }),
    }),
  ]);
}

// UserBalance { shares, q4w: vec<{ amount, exp }> } under
// ("UserBalance", { pool, user }) in the backstop's persistent storage
async function decodedQueueExps(user: string): Promise<bigint[]> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(BLEND_BACKSTOP_TESTNET_ID).toScAddress(),
      key: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("UserBalance"),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("pool"),
            val: new Address(POOL).toScVal(),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("user"),
            val: new Address(user).toScVal(),
          }),
        ]),
      ]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const res = await rpc.getLedgerEntries(key);
  const entry = res.entries[0];
  if (entry === undefined) throw new Error(`no UserBalance entry for ${user}`);
  const data = xdr.expectUnionVariant(entry.val, "contractData").contractData;
  const balance = scValToNative(data.val) as { q4w: { amount: bigint; exp: bigint }[] };
  return balance.q4w.map((q) => q.exp);
}

describe("integration: backstop queue unlock date from testnet q4w (M-25)", () => {
  it("reports the latest still-locked exp of an existing queue", async () => {
    const kp = Keypair.random();
    const user = kp.publicKey();
    await friendbot(user);

    const usdc = await sacAsset(USDC, user);
    const trust = new TransactionBuilder(await horizon.loadAccount(user), {
      fee: "1000",
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(60)
      .build();
    trust.sign(kp);
    await horizon.submitTransaction(trust);

    // 5000 XLM collateral, 50 USDC borrowed, 40 of it into the comet for LP
    await call(
      kp,
      POOL,
      "submit",
      address(user),
      address(user),
      address(user),
      xdr.ScVal.scvVec([request(XLM_SAC, 2, 5000_0000000n), request(USDC, 4, 50_0000000n)]),
    );
    const lp = (await call(
      kp,
      COMET,
      "dep_tokn_amt_in_get_lp_tokns_out",
      address(USDC),
      i128(40_0000000n),
      i128(0n),
      address(user),
    )) as bigint;
    expect(lp).toBeGreaterThan(1n);
    const shares = (await call(
      kp,
      BLEND_BACKSTOP_TESTNET_ID,
      "deposit",
      address(user),
      address(POOL),
      i128(lp),
    )) as bigint;
    expect(shares).toBeGreaterThan(1n);

    // two queue entries in different ledgers, so the latest is not the only one
    const first = (await call(
      kp,
      BLEND_BACKSTOP_TESTNET_ID,
      "queue_withdrawal",
      address(user),
      address(POOL),
      i128(shares / 2n),
    )) as { amount: bigint; exp: bigint };

    const queue = await buildBackstopQueueTx(
      TESTNET,
      { poolId: POOL },
      user,
      await horizon.loadAccount(user),
      { server: rpc, ledgerCloseTime: (await fetchLedgerClock(TESTNET)).closedAt },
    );
    expect(queue.shares).toBe(shares - shares / 2n);
    const ret = await signAndSend(kp, queue.transaction);
    if (ret === undefined) throw new Error("queue_withdrawal returned no Q4W");
    const second = scValToNative(ret) as { amount: bigint; exp: bigint };
    expect(second.exp).toBeGreaterThan(first.exp);
    // the builder's own estimate of when the new queue unlocks is the chain's
    // exp to within the time the transaction took to land
    expect(Math.abs(queue.queueEndsAt.getTime() - Number(second.exp) * 1000)).toBeLessThan(120_000);

    expect(await decodedQueueExps(user)).toEqual([first.exp, second.exp]);

    const res = await loadBackstopDeposits(TESTNET, user, [
      { poolId: POOL, backstopId: BLEND_BACKSTOP_TESTNET_ID },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.deposits).toHaveLength(1);
    const deposit = res.deposits[0]!;
    expect(deposit.shares).toBe(0n);
    expect(deposit.queuedForWithdrawal).toBe(shares);
    expect(deposit.unlockedQueuedForWithdrawal).toBe(0n);
    expect(deposit.latestQueueUnlocksAt).toEqual(new Date(Number(second.exp) * 1000));
  });

  it("runs on the same backstop wasm as mainnet, so the date reading carries over", async () => {
    const sha = (wasm: Uint8Array): string => createHash("sha256").update(wasm).digest("hex");
    const [testnetWasm, mainnetWasm] = await Promise.all([
      rpc.getContractWasmByContractId(BLEND_BACKSTOP_TESTNET_ID),
      getRpc(MAINNET).getContractWasmByContractId(BLEND_BACKSTOP_MAINNET_ID),
    ]);
    expect(sha(testnetWasm)).toBe(sha(mainnetWasm));
  });
});
