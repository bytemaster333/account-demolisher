import { describe, it, expect } from "vitest";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";

import { loadBackstopDeposits } from "@/lib/adapters/blend/client";
import { BLEND_BACKSTOP_MAINNET_ID } from "@/lib/adapters/blend/constants";
import { MAINNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";

// read-only: discovery dates an existing backstop queue from the chain's own
// q4w entries. the expected date is decoded here straight from the UserBalance
// ledger entry, without the blend sdk, so the two readings are independent.

// FixedV2 and a depositor with a still-locked queue (exp 1792081911,
// 2026-10-15) found in the v2 backstop's UserBalance entries on 2026-10-07.
// once that unlocks, pick another holder; the precondition below says so.
const FIXED_V2 = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const DEPOSITOR = "GCZNSVG3RKE7YF3DWK45MWK6ADIXDE3SKAUWOEJOY2WZSZY6H5VPT24K";

async function lockedExps(): Promise<bigint[]> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(BLEND_BACKSTOP_MAINNET_ID).toScAddress(),
      key: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("UserBalance"),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("pool"),
            val: new Address(FIXED_V2).toScVal(),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("user"),
            val: new Address(DEPOSITOR).toScVal(),
          }),
        ]),
      ]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const res = await getRpc(MAINNET).getLedgerEntries(key);
  const entry = res.entries[0];
  if (entry === undefined) return [];
  const data = xdr.expectUnionVariant(entry.val, "contractData").contractData;
  const balance = scValToNative(data.val) as { q4w: { amount: bigint; exp: bigint }[] };
  const now = BigInt(Math.floor(Date.now() / 1000));
  return balance.q4w.map((q) => q.exp).filter((exp) => exp > now);
}

describe("integration: backstop queue unlock date from mainnet q4w (M-25)", () => {
  it("reports the latest still-locked exp of an existing queue", async () => {
    const exps = await lockedExps();
    if (exps.length === 0) {
      throw new Error(
        `precondition: ${DEPOSITOR} no longer has a locked queue in the FixedV2 backstop; ` +
          `pick a current holder`,
      );
    }
    const latest = exps.reduce((a, b) => (b > a ? b : a));

    const res = await loadBackstopDeposits(MAINNET, DEPOSITOR, [
      { poolId: FIXED_V2, backstopId: BLEND_BACKSTOP_MAINNET_ID },
    ]);

    expect(res.errors).toEqual([]);
    expect(res.deposits).toHaveLength(1);
    expect(res.deposits[0]?.latestQueueUnlocksAt).toEqual(new Date(Number(latest) * 1000));
  });
});
