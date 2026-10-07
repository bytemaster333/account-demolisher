import { describe, it, expect } from "vitest";
import { Address, Asset, Horizon, scValToNative, xdr, type rpc } from "@stellar/stellar-sdk";

import {
  claim,
  claimConcentratedFees,
  getUserReward,
  readAquariusRewardToken,
  withdrawConcentratedPosition,
} from "@/lib/adapters/aquarius/client";
import {
  discoverConcentratedPositions,
  estimateConcentratedWithdraw,
  type AquariusConcentratedPosition,
} from "@/lib/adapters/aquarius/concentrated";
import {
  MAINNET_CONCENTRATED_POOLS,
  MAINNET_CONCENTRATED_POOL_WASM,
} from "@/lib/adapters/aquarius/concentrated-pools";
import { getAquariusRouterId } from "@/lib/adapters/aquarius/client";
import { poolIndexHexToBytes } from "@/lib/adapters/aquarius/pools";
import { MAINNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { simulateRead } from "@/lib/soroban/simulate";
import { u128 } from "@/lib/soroban/scval";

// read-only checks against live mainnet state: every call below is built by the
// app's own code and run through prepareTransaction (simulation). nothing is
// signed or submitted.

const XLM_USDC_CONCENTRATED = "CBBMQBNHB2FYVZYV7VNHOJHUMTFJLR4PUMRVQYNW6RHIKZO2NQMIBUCV";

async function recentConcentratedHolders(server: rpc.Server): Promise<string[]> {
  const latest = await server.getLatestLedger();
  const resp = await server.getEvents({
    startLedger: latest.sequence - 17_000,
    filters: [
      {
        type: "contract",
        contractIds: [XLM_USDC_CONCENTRATED],
        topics: [[xdr.ScVal.scvSymbol("claim_reward").toXdr("base64"), "*", "*"]],
      },
    ],
    limit: 200,
  });
  const users = new Set<string>();
  for (const ev of resp.events) users.add(String(scValToNative(ev.topic[2]!)));
  return [...users];
}

describe("integration: aquarius exits simulate against mainnet", () => {
  it("the pinned concentrated pools are exactly the router's concentrated pools", async () => {
    const server = getRpc(MAINNET);
    const router = getAquariusRouterId(MAINNET);
    const src = "GC6K27OC6OAA6XWVE3GGMJ2US5MOVMYZT5OJ326KOWKH4ZVMHXT6A7X4";
    const count = scValToNative(
      (await simulateRead(server, router, "get_tokens_sets_count", [], src, MAINNET)).retval,
    ) as bigint;
    const addresses: string[] = [];
    for (let start = 0n; start < count; start += 20n) {
      const end = start + 20n > count ? count : start + 20n;
      const { retval } = await simulateRead(
        server,
        router,
        "get_pools_for_tokens_range",
        [u128(start), u128(end)],
        src,
        MAINNET,
      );
      for (const set of xdr.expectUnionVariant(retval, "scvVec").vec!) {
        const pools = xdr.expectUnionVariant(
          xdr.expectUnionVariant(set, "scvVec").vec![1]!,
          "scvMap",
        );
        for (const e of pools.map!) addresses.push(Address.fromScVal(e.val).toString());
      }
    }
    const concentrated: string[] = [];
    for (let i = 0; i < addresses.length; i += 150) {
      const keys = addresses.slice(i, i + 150).map((a) =>
        xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: new Address(a).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent,
          }),
        ),
      );
      const resp = await server.getLedgerEntries(...keys);
      for (const entry of resp.entries) {
        const cd = xdr.expectUnionVariant(entry.val, "contractData").contractData;
        const exec = xdr.expectUnionVariant(cd.val, "scvContractInstance").instance.executable;
        if (exec.type !== "contractExecutableWasm") continue;
        const wasm = Buffer.from(exec.wasmHash.toBytes()).toString("hex");
        if (wasm === MAINNET_CONCENTRATED_POOL_WASM) {
          concentrated.push(Address.fromScAddress(cd.contract).toString());
        }
      }
    }
    expect(concentrated.sort()).toEqual(MAINNET_CONCENTRATED_POOLS.map((p) => p.address).sort());
  });

  it("discovers a live concentrated position and every exit call for it simulates", async () => {
    const server = getRpc(MAINNET);
    const horizon = new Horizon.Server(MAINNET.horizon);
    let holder: string | undefined;
    let position: AquariusConcentratedPosition | undefined;
    for (const user of await recentConcentratedHolders(server)) {
      const found = await discoverConcentratedPositions(server, MAINNET, user);
      position = found.find((p) => p.poolAddress === XLM_USDC_CONCENTRATED && p.ranges.length > 0);
      if (position) {
        holder = user;
        break;
      }
    }
    expect(position, "no recent claimant still holds a concentrated range").toBeDefined();
    const user = holder!;
    const range = position!.ranges[0]!;

    const estimate = await estimateConcentratedWithdraw(server, MAINNET, {
      poolAddress: position!.poolAddress,
      user,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      liquidity: range.liquidity,
    });
    expect(estimate).toHaveLength(2);

    const withdraw = await withdrawConcentratedPosition(
      {
        user,
        poolAddress: position!.poolAddress,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        liquidity: range.liquidity,
        minAmounts: estimate.map((e) => (e * 99n) / 100n),
        sourceAccount: await horizon.loadAccount(user),
        network: MAINNET,
      },
      { server },
    );
    expect(BigInt(withdraw.fee)).toBeGreaterThan(100_000n);

    await claimConcentratedFees(
      {
        user,
        poolAddress: position!.poolAddress,
        sourceAccount: await horizon.loadAccount(user),
        network: MAINNET,
      },
      { server },
    );

    const poolIndex = poolIndexHexToBytes(position!.poolIndex);
    const reward = await getUserReward(server, {
      user,
      tokens: position!.tokens,
      poolIndex,
      network: MAINNET,
    });
    expect(reward).toBeGreaterThanOrEqual(0n);
    await claim(
      {
        user,
        tokens: position!.tokens,
        poolIndex,
        sourceAccount: await horizon.loadAccount(user),
        network: MAINNET,
      },
      { server },
    );
  });

  // a reward claim pays this token, so a holder needs its trustline before the claim
  it("reads the router's reward token as the AQUA SAC", async () => {
    const aqua = new Asset(
      "AQUA",
      "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    ).contractId(MAINNET.passphrase);
    await expect(readAquariusRewardToken(getRpc(MAINNET), MAINNET)).resolves.toBe(aqua);
  });
});
