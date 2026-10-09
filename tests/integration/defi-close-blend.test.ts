import { describe, it, expect } from "vitest";
import { Asset, Contract, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { loadUserPositions } from "@/lib/adapters/blend/client";
import { BLEND_TESTNET_POOL_IDS } from "@/lib/adapters/blend/pools";
import { TESTNET } from "@/lib/config/networks";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

import {
  accountExists,
  closeHeadless,
  friendbotFund,
  nativeBalance,
  outcomeSummary,
} from "../helpers/headless-close";
import { horizon, submitSorobanAs } from "../helpers/testnet-seed";

// a full close of an account with live Blend positions, run through the app's
// own state machine and executor (discovery, plan, hydration, signing, submit,
// re-audit, merge). the account supplies XLM to the testnet v2 pool both as a
// plain supply and as collateral, and borrows against it, so the close has to
// repay, withdraw both buckets and merge, in that order, for real.

const POOL = BLEND_TESTNET_POOL_IDS[0]!;
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);

// blend request_type values (pool contract Request)
const SUPPLY = 0;
const SUPPLY_COLLATERAL = 2;
const BORROW = 4;

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

describe("integration: closing an account with live Blend positions (testnet)", () => {
  it("repays, withdraws supply and collateral, and merges through the executor", async () => {
    const kp = Keypair.random();
    const user = kp.publicKey();
    const destination = Keypair.random();
    await friendbotFund(TESTNET, user);
    await friendbotFund(TESTNET, destination.publicKey());

    // 500 XLM plain supply, 1500 XLM collateral, 100 XLM borrowed
    await submitSorobanAs(
      kp,
      new Contract(POOL).call(
        "submit",
        nativeToScVal(user, { type: "address" }),
        nativeToScVal(user, { type: "address" }),
        nativeToScVal(user, { type: "address" }),
        xdr.ScVal.scvVec([
          request(SUPPLY, 500_0000000n),
          request(SUPPLY_COLLATERAL, 1500_0000000n),
          request(BORROW, 100_0000000n),
        ]),
      ),
    );
    const opened = await loadUserPositions(TESTNET, user, [POOL]);
    expect(opened.errors).toEqual([]);
    const pos = opened.positions[0]!;
    expect(pos.supply.get(XLM_SAC) ?? 0n).toBeGreaterThan(0n);
    expect(pos.collateral.get(XLM_SAC) ?? 0n).toBeGreaterThan(0n);
    expect(pos.liabilities.get(XLM_SAC) ?? 0n).toBeGreaterThan(0n);

    const destBefore = await nativeBalance(horizon, destination.publicKey());

    const { review, outcome } = await closeHeadless({
      publicKey: user,
      network: TESTNET,
      connector: new SecretKeyConnector(kp.secret()),
      destination: destination.publicKey(),
      useMediator: false,
    });

    // the reviewed plan unwinds the loan before it touches the collateral
    const kinds = [...review.context.tree!.allNodes.values()].map((n) => n.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["RepayBlend", "WithdrawBlend", "FinalClassicTx"]),
    );

    expect(outcome.matches("succeeded"), outcomeSummary(outcome)).toBe(true);
    expect(outcome.context.result?.mergedTxHash).toMatch(/^[0-9a-f]{64}$/);

    // on chain: the account is gone, the pool holds nothing for it, and the
    // destination got the supplied XLM back (10,000 from friendbot, less the 100
    // repaid with interest is a wash with the 100 borrowed, less fees)
    expect(await accountExists(horizon, user)).toBe(false);
    const after = await loadUserPositions(TESTNET, user, [POOL]);
    expect(after.errors).toEqual([]);
    const left = after.positions[0];
    expect((left?.supply.size ?? 0) + (left?.collateral.size ?? 0)).toBe(0);
    expect(left?.liabilities.size ?? 0).toBe(0);
    const received = (await nativeBalance(horizon, destination.publicKey())) - destBefore;
    expect(received).toBeGreaterThan(9_990_0000000n);
    expect(received).toBeLessThan(10_000_0000000n);
  });
});
