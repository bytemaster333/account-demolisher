import { describe, it, expect } from "vitest";
import {
  Asset,
  Horizon,
  Keypair,
  TransactionBuilder,
  Contract,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { loadUserPositions } from "@/lib/adapters/blend/client";
import { buildBlendRepayTx, buildBlendWithdrawTx } from "@/lib/adapters/blend/exit";
import { BLEND_TESTNET_POOL_IDS } from "@/lib/adapters/blend/pools";
import { TESTNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { fetchLedgerClock } from "@/lib/stellar/ledger-clock";

// Live testnet proof that a Blend borrower can be closed out: open a real loan
// on the testnet v2 pool, then repay and withdraw with the transactions the
// close builds. Before the fix the repay asked for i128::MAX, which the pool
// forwards to the SAC transfer and the SAC rejects (Error(Contract, #12)).
const rpc = getRpc(TESTNET);
const horizon = new Horizon.Server(TESTNET.horizon);
const POOL = BLEND_TESTNET_POOL_IDS[0]!;
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);

async function friendbot(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: ${res.status}`);
}

async function signAndSend(kp: Keypair, tx: Transaction): Promise<void> {
  tx.sign(kp);
  const sent = await rpc.sendTransaction(tx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`sendTransaction returned ${sent.status}`);
  }
  const res = await rpc.pollTransaction(sent.hash, { attempts: 60 });
  if (res.status !== "SUCCESS") {
    const detail =
      res.status === "FAILED"
        ? (res.diagnosticEventsXdr ?? []).map((e) => JSON.stringify(e).slice(0, 400)).join("\n")
        : "";
    throw new Error(`soroban tx ${sent.hash} failed: ${res.status}\n${detail}`);
  }
}

function request(type: number, amount: bigint): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("address", { type: "symbol" }),
      val: nativeToScVal(XLM_SAC, { type: "address" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("amount", { type: "symbol" }),
      val: nativeToScVal(amount, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("request_type", { type: "symbol" }),
      val: nativeToScVal(type, { type: "u32" }),
    }),
  ]);
}

describe("integration: Blend borrower exit on testnet", () => {
  it("repays a live loan and withdraws the collateral with the built transactions", async () => {
    const kp = Keypair.random();
    const user = kp.publicKey();
    await friendbot(user);

    // open the position: 2000 XLM collateral, 100 XLM borrowed
    const open = new TransactionBuilder(await horizon.loadAccount(user), {
      fee: SOROBAN_INCLUSION_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        new Contract(POOL).call(
          "submit",
          nativeToScVal(user, { type: "address" }),
          nativeToScVal(user, { type: "address" }),
          nativeToScVal(user, { type: "address" }),
          xdr.ScVal.scvVec([request(2, 2000_0000000n), request(4, 100_0000000n)]),
        ),
      )
      .setTimeout(120)
      .build();
    await signAndSend(kp, (await rpc.prepareTransaction(open)) as Transaction);

    const opened = await loadUserPositions(TESTNET, user, [POOL]);
    expect(opened.errors).toEqual([]);
    const debt = opened.positions[0]!.liabilities.get(XLM_SAC)!;
    // underlying units: the 100 XLM borrowed plus at most a little interest
    expect(debt).toBeGreaterThanOrEqual(100_0000000n);
    expect(debt).toBeLessThan(100_1000000n);

    const repay = await buildBlendRepayTx(
      TESTNET,
      { poolId: POOL, asset: XLM_SAC },
      user,
      await horizon.loadAccount(user),
      { server: rpc, ledgerCloseTime: (await fetchLedgerClock(TESTNET)).closedAt },
    );
    expect(repay.amount).toBeLessThan(2n ** 63n);
    expect(repay.amount).toBeGreaterThan(repay.debt);
    await signAndSend(kp, repay.transaction);

    const repaid = await loadUserPositions(TESTNET, user, [POOL]);
    expect(repaid.positions[0]!.liabilities.size).toBe(0);
    expect(repaid.positions[0]!.collateral.get(XLM_SAC)).toBeGreaterThan(0n);

    const withdraw = await buildBlendWithdrawTx(
      TESTNET,
      { poolId: POOL, asset: XLM_SAC, bucket: "collateral" },
      user,
      await horizon.loadAccount(user),
      { server: rpc, ledgerCloseTime: (await fetchLedgerClock(TESTNET)).closedAt },
    );
    await signAndSend(kp, withdraw.transaction);

    const closed = await loadUserPositions(TESTNET, user, [POOL]);
    const left = closed.positions[0]!;
    expect(left.liabilities.size + left.collateral.size + left.supply.size).toBe(0);
  });
});
