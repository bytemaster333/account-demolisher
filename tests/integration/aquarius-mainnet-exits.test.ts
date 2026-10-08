import { describe, it, expect } from "vitest";
import { Address, Asset, Horizon, scValToNative, xdr, type rpc } from "@stellar/stellar-sdk";

import {
  claim,
  claimConcentratedFees,
  getUserReward,
  readAquariusPoolRewardTokens,
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
import { poolIndexHexToBytes, readAquariusPoolAddress } from "@/lib/adapters/aquarius/pools";
import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";
import { claimGaugeRewards, readGaugeRewards } from "@/lib/adapters/aquarius/gauges";
import { MAINNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { readExitPayouts } from "@/lib/soroban/stellar-asset";
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

  // the plan links every reward claim to the router's reward token and refuses
  // a paying pool whose own token list differs, so a pinned concentrated pool
  // that paid anything else would have its pending reward refused
  it("finds every pinned concentrated pool paying its rewards in the router's token", async () => {
    const server = getRpc(MAINNET);
    const [routerToken, byPool] = await Promise.all([
      readAquariusRewardToken(server, MAINNET),
      readAquariusPoolRewardTokens(
        server,
        MAINNET_CONCENTRATED_POOLS.map((p) => p.address),
      ),
    ]);
    for (const pool of MAINNET_CONCENTRATED_POOLS) {
      expect(byPool.get(pool.address), pool.address).toEqual([routerToken]);
    }
  });

  // GDD34D... holds archived shares in standard pool CAUCGD... with AQUA
  // pending; the pool pays that claim from its own RewardToken (simulated
  // 2026-10-08), so the payout read resolves the pool through the router and
  // reads that token
  it("reads the reward token from the paying pool, found through the router", async () => {
    const server = getRpc(MAINNET);
    const user = "GDD34DUAHJA4ZW26H7YUFKXZHS4TRVCU6G7NZ6JBFLTIMV6FNQCIEQ4O";
    const pool = "CAUCGDPDPQL4EPMPPFST63VBDVN6H5LMDYM3OTBGJQZTCTM3DE4IWWWB";
    const index = "37b955f3708dae748cad465441fcad70b26ffe272385227a4a737234ae429bdf";
    const tokens = [
      "CAESLMGW5LYTIEJI7FJHK6SFSWRELLNVX5Q4WR4UZEALMTRWQDBKDPAG",
      "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK",
    ];
    const aqua = new Asset(
      "AQUA",
      "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    ).contractId(MAINNET.passphrase);
    await expect(readAquariusPoolAddress(server, MAINNET, tokens, index, user)).resolves.toBe(pool);
    const payouts = await readExitPayouts(server, MAINNET, user, {
      ...EMPTY_POSITIONS,
      aquarius: [{ poolIndex: index, shareBalance: 1n, tokens }],
    });
    expect(payouts.aquariusRewardToken).toBe(aqua);
    expect([...payouts.tokens].sort()).toEqual([...tokens].sort());
  });

  // stable pool CCNXGPE4... had a gauge paying XLM on
  // 2026-10-08. a share holder the gauge owes is found through stellar.expert's
  // listing of the share token's balances, then the app's own reader and
  // builder run against live state (simulation only)
  it("reads what a pool's gauge owes and builds the claim that pays it", async () => {
    const server = getRpc(MAINNET);
    const horizon = new Horizon.Server(MAINNET.horizon);
    const pool = "CCNXGPE4AQCSNEBZO3XJDKKDI3CRLYMVS6UWBBTVDLALLWMJEXBORQ2A";
    // the pool's key in the router, from the amm-api pool listing
    const api = {
      index: "f56e6f3b43d99643950956cf1dfdfccfc1abe825bef484484911c9f428ff4ba7",
      tokens_addresses: [
        "CAUP7NFABXE5TJRL3FKTPMWRLC7IAXYDCTHQRFSCLR5TMGKHOOQO772J",
        "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN",
      ],
    };
    const share = String(
      scValToNative(
        (
          await simulateRead(
            server,
            getAquariusRouterId(MAINNET),
            "share_id",
            [
              xdr.ScVal.scvVec(api.tokens_addresses.map((t) => new Address(t).toScVal())),
              xdr.ScVal.scvBytes(Buffer.from(poolIndexHexToBytes(api.index))),
            ],
            "GC6K27OC6OAA6XWVE3GGMJ2US5MOVMYZT5OJ326KOWKH4ZVMHXT6A7X4",
            MAINNET,
          )
        ).retval,
      ),
    );
    const listing = (await (
      await fetch(
        `https://api.stellar.expert/explorer/public/contract-data/${share}?limit=200&order=desc`,
      )
    ).json()) as { _embedded?: { records?: { key: string }[] } };
    const holders: string[] = [];
    for (const r of listing._embedded?.records ?? []) {
      const key = scValToNative(xdr.ScVal.fromXdr(r.key, "base64")) as unknown;
      if (Array.isArray(key) && key[0] === "Balance" && String(key[1]).startsWith("G")) {
        holders.push(String(key[1]));
      }
    }
    let found: { user: string; owed: { token: string; amount: bigint }[] } | undefined;
    for (const user of holders.slice(0, 40)) {
      const owed = await readGaugeRewards(server, MAINNET, user, [pool]);
      if (owed.length > 0) {
        found = { user, owed };
        break;
      }
    }
    expect(found, "no holder of CCNXGPE4 is owed a gauge reward any more").toBeDefined();
    // the read must name what gauges_claim really pays: the same tokens, and at
    // least the amount read, since the claim runs a moment later
    const paid = scValToNative(
      (
        await simulateRead(
          server,
          pool,
          "gauges_claim",
          [new Address(found!.user).toScVal()],
          found!.user,
          MAINNET,
        )
      ).retval,
    ) as Record<string, bigint>;
    const paying = Object.entries(paid).filter(([, v]) => v > 0n);
    expect(paying.map(([t]) => t).sort()).toEqual(found!.owed.map((o) => o.token).sort());
    for (const o of found!.owed) expect(paid[o.token]).toBeGreaterThanOrEqual(o.amount);
    const tx = await claimGaugeRewards(
      {
        user: found!.user,
        poolAddress: pool,
        tokens: api.tokens_addresses,
        poolIndex: api.index,
        sourceAccount: await horizon.loadAccount(found!.user),
        network: MAINNET,
      },
      { server },
    );
    const op = tx.operations[0] as unknown as { auth: xdr.SorobanAuthorizationEntry[] };
    expect(op.auth).toHaveLength(1);
    expect(op.auth[0]!.credentials.type).toBe("sorobanCredentialsSourceAccount");
    expect(op.auth[0]!.rootInvocation.subInvocations).toHaveLength(0);
  });
});
