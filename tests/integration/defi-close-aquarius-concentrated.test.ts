import { describe, it, expect } from "vitest";
import { Asset, Contract, Keypair, Operation, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { getAquariusRouterId } from "@/lib/adapters/aquarius/client";
import { TESTNET_CONCENTRATED_POOLS } from "@/lib/adapters/aquarius/concentrated-pools";
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import type { AquariusConcentratedPositionSummary } from "@/lib/adapters/positions/interface";
import { TESTNET } from "@/lib/config/networks";
import { fromScValI32 } from "@/lib/soroban/scval";
import { simulateRead } from "@/lib/soroban/simulate";
import { pathKey } from "@/lib/types/plan";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

import {
  accountExists,
  closeHeadless,
  friendbotFund,
  nativeBalance,
  outcomeSummary,
} from "../helpers/headless-close";
import { horizon, rpc, submitClassicAs, submitSorobanAs } from "../helpers/testnet-seed";

// a full close of an account that holds a live Aquarius concentrated-liquidity
// position, run through the app's own state machine and executor. the account
// buys testnet USDT through the router in the pinned XLM/USDT concentrated pool,
// then opens a tick range around the current price in that pool by calling it
// directly, as the Aquarius app does. the close must withdraw the range from the
// pool (a concentrated pool has no share token, so this is a different exit from
// the router withdraw), collect the swap fees a trade through the range paid it,
// dispose of the USDT and merge.
//
// the pool belongs to Aquarius's testnet deployment and is on the app's pinned
// list. it runs no reward program. the pinned XLM/AQUA concentrated pool
// (CBEPUTV5...) is not used: it lists a second reward token in its
// RewardTokenRegistry, and the app refuses to plan a close with a position
// there (UnplannableRewardClaimError), which it reported when tried on
// 2026-10-09. if Aquarius drains or removes the pool, the setup fails and names
// it.

const USDT_ISSUER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const USDT = new Asset("USDT", USDT_ISSUER);
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);
const USDT_SAC = USDT.contractId(TESTNET.passphrase);
// the pinned XLM/USDT concentrated pool (0.10% fee, tick spacing 20), which had
// about 5e11 active liquidity at tick 14787 on 2026-10-09
const CONCENTRATED_POOL = "CBM6DJUR6NYRLJPQZ3JNVOSWHLJKPATTCFJZCONNAVHIRHKDMFICMRGU";

const u128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u128" });
const addr = (a: string): xdr.ScVal => nativeToScVal(a, { type: "address" });

async function concentratedPositions(
  user: string,
): Promise<readonly AquariusConcentratedPositionSummary[]> {
  const positions = await new DirectContractProvider().getPositions(user, TESTNET);
  if (positions.errors.length > 0) {
    throw new Error(`discovery errors: ${JSON.stringify(positions.errors)}`);
  }
  return positions.aquariusConcentrated;
}

// a struct field of a pool read, by name
function field(v: xdr.ScVal, name: string): xdr.ScVal {
  if (v.type !== "scvMap" || v.map === null)
    throw new TypeError(`expected a struct, got ${v.type}`);
  const entry = v.map.find((e) => e.key.type === "scvSymbol" && e.key.sym.toString() === name);
  if (entry === undefined) throw new TypeError(`struct has no field ${name}`);
  return entry.val;
}

describe("integration: closing an account with a live Aquarius concentrated position (testnet)", () => {
  it("withdraws the tick range, returns the USDT and merges through the executor", async () => {
    const pool = TESTNET_CONCENTRATED_POOLS.find((p) => p.address === CONCENTRATED_POOL);
    if (pool === undefined) {
      throw new Error(`${CONCENTRATED_POOL} is no longer on the pinned testnet list`);
    }
    expect([...pool.tokens].sort()).toEqual([XLM_SAC, USDT_SAC].sort());

    const kp = Keypair.random();
    const user = kp.publicKey();
    const destination = Keypair.random();
    await friendbotFund(TESTNET, user);
    await friendbotFund(TESTNET, destination.publicKey());

    await submitClassicAs(kp, (b) => b.addOperation(Operation.changeTrust({ asset: USDT })));
    // XLM for USDT through the router in the same pool
    const swapXlmForUsdt = async (amount: bigint): Promise<void> => {
      try {
        await submitSorobanAs(
          kp,
          new Contract(getAquariusRouterId(TESTNET)).call(
            "swap",
            addr(user),
            xdr.ScVal.scvVec(pool.tokens.map(addr)),
            addr(XLM_SAC),
            addr(USDT_SAC),
            xdr.ScVal.scvBytes(Buffer.from(pool.poolIndex, "hex")),
            u128(amount),
            u128(1n),
          ),
        );
      } catch (err) {
        throw new Error(
          `buying USDT in ${CONCENTRATED_POOL} through the router failed: ${String(err)}`,
        );
      }
    };
    await swapXlmForUsdt(100_0000000n);

    // a range of 20 spacings on each side of the current tick, so the
    // position holds both tokens
    const pc = new Contract(CONCENTRATED_POOL);
    const slot = (await simulateRead(rpc, CONCENTRATED_POOL, "get_slot0", [], user, TESTNET))
      .retval;
    const tick = fromScValI32(field(slot, "tick"));
    const spacing = fromScValI32(
      (await simulateRead(rpc, CONCENTRATED_POOL, "get_tick_spacing", [], user, TESTNET)).retval,
    );
    const base = Math.floor(tick / spacing) * spacing;
    const tickLower = base - 20 * spacing;
    const tickUpper = base + 20 * spacing;

    const usdtLine = (await horizon.loadAccount(user)).balances.find(
      (b) => "asset_code" in b && b.asset_code === "USDT",
    );
    const usdtStroops = BigInt(Math.floor(Number(usdtLine?.balance ?? "0") * 1e7));
    expect(usdtStroops).toBeGreaterThan(0n);
    const desired = pool.tokens.map((t) => (t === XLM_SAC ? 200_0000000n : usdtStroops));
    try {
      await submitSorobanAs(
        kp,
        pc.call(
          "deposit_position",
          addr(user),
          xdr.ScVal.scvI32(tickLower),
          xdr.ScVal.scvI32(tickUpper),
          xdr.ScVal.scvVec(desired.map(u128)),
          u128(0n),
        ),
      );
    } catch (err) {
      throw new Error(
        `opening a range [${tickLower}, ${tickUpper}] in ${CONCENTRATED_POOL} failed: ${String(err)}`,
      );
    }
    const opened = await concentratedPositions(user);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.poolAddress).toBe(CONCENTRATED_POOL);
    expect(opened[0]!.ranges.map((r) => [r.tickLower, r.tickUpper])).toEqual([
      [tickLower, tickUpper],
    ]);
    expect(opened[0]!.ranges[0]!.liquidity).toBeGreaterThan(0n);

    // a trade through the range pays it a share of the swap fee, so the close
    // also has fees to collect
    await swapXlmForUsdt(20_0000000n);
    const earning = await concentratedPositions(user);
    expect(earning[0]!.pendingFees.some((fee) => fee > 0n)).toBe(true);

    const destBefore = await nativeBalance(horizon, destination.publicKey());

    const { review, outcome } = await closeHeadless({
      publicKey: user,
      network: TESTNET,
      connector: new SecretKeyConnector(kp.secret()),
      destination: destination.publicKey(),
      useMediator: false,
      returnToIssuerAssetKeys: [pathKey({ kind: "credit", code: USDT.code, issuer: USDT_ISSUER })],
    });

    const kinds = [...review.context.tree!.allNodes.values()].map((n) => n.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "ClaimAquariusConcentratedFees",
        "WithdrawAquariusConcentrated",
        "FinalClassicTx",
      ]),
    );

    expect(outcome.matches("succeeded"), outcomeSummary(outcome)).toBe(true);

    // on chain: the account is gone and the pool no longer lists a range for it
    // (a fully withdrawn position is deleted, so get_position on it traps)
    expect(await accountExists(horizon, user)).toBe(false);
    expect(await concentratedPositions(user)).toHaveLength(0);
    const snapshot = (
      await simulateRead(
        rpc,
        CONCENTRATED_POOL,
        "get_user_position_snapshot",
        [addr(user)],
        user,
        TESTNET,
      )
    ).retval;
    const ranges = field(snapshot, "ranges");
    expect(ranges.type).toBe("scvVec");
    expect(ranges.type === "scvVec" ? ranges.vec : null).toEqual([]);

    // the 120 XLM that bought USDT went back to the issuer as USDT, and the
    // range paid its XLM side back out, so the destination gets about 9,880 XLM
    // less fees and what the second trade moved across the range (about 1.8 XLM
    // on 2026-10-09)
    const received = (await nativeBalance(horizon, destination.publicKey())) - destBefore;
    expect(received).toBeGreaterThan(9_860_0000000n);
    expect(received).toBeLessThan(10_000_0000000n);
  });
});
