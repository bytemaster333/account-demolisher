import { describe, it, expect } from "vitest";
import {
  Asset,
  Contract,
  Keypair,
  Operation,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { getAquariusRouterId } from "@/lib/adapters/aquarius/client";
import { readGaugeRewards } from "@/lib/adapters/aquarius/gauges";
import { TESTNET } from "@/lib/config/networks";
import { address as addr, fromScValAddress, fromScValU128, u128 } from "@/lib/soroban/scval";
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

// a full close of an account whose Aquarius pool share is owed reward-gauge
// rewards, run through the app's own state machine and executor. gauges are
// extra rewards a third party schedules on a pool; the router's claim does not
// pay them, so the close has to claim them from the pool's gauge before it
// withdraws the share.
//
// on 2026-10-09 none of the 9 testnet pools with gauges had a reward
// scheduled (gauges_get_reward_configs was empty for every gauge), so the test
// schedules one itself the way any distributor does: router
// pool_gauge_schedule_reward, paying AQUA on the XLM/AQUA constant-product
// pool for the router's minimum duration and above its minimum daily amount.
// when an earlier run's schedule is still paying, that one is used instead.
//
// the pool keeps two more gauges, paying DAI (a classic asset's SAC) and Time
// Rebased Token, with nothing scheduled. gauges_claim runs every gauge and each
// transfers what it owes, zero included, and a zero SAC transfer to an account
// without a DAI line traps (Error(Contract, #13), "trustline entry is
// missing"). the close has to deal with that for an account that holds no DAI
// line, which is what this account is: it opens the DAI line ahead of the claim,
// and the classic close removes it again with the account.

const AQUA_ISSUER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const AQUA = new Asset("AQUA", AQUA_ISSUER);
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);
const AQUA_SAC = AQUA.contractId(TESTNET.passphrase);
// the pool's DAI gauge token, a SAC of DAI from the AQUA issuer
const DAI_SAC = new Asset("DAI", AQUA_ISSUER).contractId(TESTNET.passphrase);
const POOL_INDEX = "9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e";
const POOL_ADDRESS = "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC";

const router = () => new Contract(getAquariusRouterId(TESTNET));
const tokens = (): xdr.ScVal => xdr.ScVal.scvVec([XLM_SAC, AQUA_SAC].sort().map(addr));
const poolIndex = (): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(POOL_INDEX, "hex"));

function mapField(v: xdr.ScVal, name: string): xdr.ScVal | undefined {
  if (v.type !== "scvMap" || v.map === null) throw new TypeError(`expected a map, got ${v.type}`);
  return v.map.find((e) => e.key.type === "scvSymbol" && e.key.sym.toString() === name)?.val;
}

// whether the pool's AQUA gauge pays a positive rate for at least another hour
async function aquaGaugePaying(reader: string): Promise<boolean> {
  const { retval } = await simulateRead(
    rpc,
    POOL_ADDRESS,
    "gauges_get_reward_info",
    [addr(reader)],
    reader,
    TESTNET,
  );
  if (retval.type !== "scvMap" || retval.map === null) throw new TypeError("reward info");
  const aqua = retval.map.find(
    (e) => e.key.type === "scvAddress" && fromScValAddress(e.key) === AQUA_SAC,
  );
  if (aqua === undefined) return false;
  const tps = mapField(aqua.val, "tps");
  const expiredAt = mapField(aqua.val, "expired_at");
  if (tps === undefined || expiredAt === undefined) return false;
  return (
    BigInt(scValToNative(tps) as bigint) > 0n &&
    BigInt(scValToNative(expiredAt) as bigint) > BigInt(Math.floor(Date.now() / 1000) + 3600)
  );
}

function u64(v: xdr.ScVal): bigint {
  if (v.type !== "scvU64") throw new TypeError(`expected u64, got ${v.type}`);
  return BigInt(scValToNative(v) as bigint);
}

async function buyAqua(kp: Keypair, xlm: bigint): Promise<void> {
  await submitClassicAs(kp, (b) => b.addOperation(Operation.changeTrust({ asset: AQUA })));
  await submitSorobanAs(
    kp,
    router().call(
      "swap",
      addr(kp.publicKey()),
      tokens(),
      addr(XLM_SAC),
      addr(AQUA_SAC),
      poolIndex(),
      u128(xlm),
      u128(1n),
    ),
  );
}

async function aquaBalance(publicKey: string): Promise<bigint> {
  const line = (await horizon.loadAccount(publicKey)).balances.find(
    (b) => "asset_code" in b && b.asset_code === "AQUA" && b.asset_issuer === AQUA_ISSUER,
  );
  return BigInt(Math.floor(Number(line?.balance ?? "0") * 1e7));
}

describe("integration: closing an account owed Aquarius gauge rewards (testnet)", () => {
  it("claims the gauge, withdraws the share, returns the AQUA and merges", async () => {
    const kp = Keypair.random();
    const user = kp.publicKey();
    const destination = Keypair.random();
    await friendbotFund(TESTNET, user);
    await friendbotFund(TESTNET, destination.publicKey());

    if (!(await aquaGaugePaying(user))) {
      const distributor = Keypair.random();
      await friendbotFund(TESTNET, distributor.publicKey());
      const minDuration = u64(
        (
          await simulateRead(
            rpc,
            router().contractId(),
            "pool_gauge_get_min_duration",
            [],
            user,
            TESTNET,
          )
        ).retval,
      );
      const minDaily = fromScValU128(
        (
          await simulateRead(
            rpc,
            router().contractId(),
            "pool_gauge_get_min_daily_amount",
            [],
            user,
            TESTNET,
          )
        ).retval,
      );
      // twice the minimum daily amount, spread over the minimum duration
      const tps = (2n * minDaily) / 86_400n + 1n;
      const total = tps * minDuration;
      await buyAqua(distributor, 200_0000000n);
      const held = await aquaBalance(distributor.publicKey());
      if (held < total) {
        throw new Error(`the distributor bought ${held} AQUA stroops, the schedule needs ${total}`);
      }
      try {
        await submitSorobanAs(
          distributor,
          router().call(
            "pool_gauge_schedule_reward",
            addr(distributor.publicKey()),
            tokens(),
            poolIndex(),
            addr(AQUA_SAC),
            u128(tps),
            xdr.ScVal.scvVoid(),
            nativeToScVal(minDuration, { type: "u64" }),
            xdr.ScVal.scvVec([]),
          ),
        );
      } catch (err) {
        throw new Error(
          `scheduling an AQUA gauge reward on ${POOL_ADDRESS} failed: ${String(err)}`,
        );
      }
      expect(await aquaGaugePaying(user)).toBe(true);
    }

    // the user's share: AQUA bought with 100 XLM plus the matching XLM
    await buyAqua(kp, 100_0000000n);
    const aqua = await aquaBalance(user);
    expect(aqua).toBeGreaterThan(0n);
    const desired = [XLM_SAC, AQUA_SAC].sort().map((t) => (t === XLM_SAC ? 1000_0000000n : aqua));
    await submitSorobanAs(
      kp,
      router().call(
        "deposit",
        addr(user),
        tokens(),
        poolIndex(),
        xdr.ScVal.scvVec(desired.map(u128)),
        u128(0n),
      ),
    );

    // the gauge accrues per second; wait until it owes the share something
    let owed = 0n;
    for (let i = 0; i < 30 && owed === 0n; i++) {
      const rewards = await readGaugeRewards(rpc, TESTNET, user, [POOL_ADDRESS]);
      owed = rewards.find((r) => r.token === AQUA_SAC)?.amount ?? 0n;
      if (owed === 0n) await new Promise((r) => setTimeout(r, 2_000));
    }
    expect(owed).toBeGreaterThan(0n);

    const destBefore = await nativeBalance(horizon, destination.publicKey());

    const { review, outcome } = await closeHeadless({
      publicKey: user,
      network: TESTNET,
      connector: new SecretKeyConnector(kp.secret()),
      destination: destination.publicKey(),
      useMediator: false,
      returnToIssuerAssetKeys: [pathKey({ kind: "credit", code: AQUA.code, issuer: AQUA_ISSUER })],
    });

    const kinds = [...review.context.tree!.allNodes.values()].map((n) => n.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["ClaimAquariusGaugeRewards", "WithdrawAquarius", "FinalClassicTx"]),
    );
    // the DAI gauge owes nothing, yet its line is opened ahead of the claim
    const reviewed = [...review.context.tree!.allNodes.values()];
    const daiLine = reviewed.find(
      (n) => n.kind === "AddExitTrustline" && n.metadata.contractId === DAI_SAC,
    );
    expect(daiLine, "no DAI line planned for the zero-owed DAI gauge").toBeDefined();
    expect(reviewed.find((n) => n.kind === "ClaimAquariusGaugeRewards")?.dependencies).toContain(
      daiLine!.id,
    );

    expect(outcome.matches("succeeded"), outcomeSummary(outcome)).toBe(true);
    const claim = [...outcome.context.tree!.allNodes.values()].find(
      (n) => n.kind === "ClaimAquariusGaugeRewards",
    );
    expect(claim?.status).toBe("confirmed");
    expect(claim?.executed?.txHash).toMatch(/^[0-9a-f]{64}$/);

    // on chain: the gauge claim landed and the account is gone. the claim runs
    // before the withdraw, so what the gauge accrues in the seconds between the
    // two stays owed to the closed account; that remainder is not asserted here
    const claimTx = await rpc.getTransaction(claim!.executed!.txHash);
    expect(claimTx.status).toBe("SUCCESS");
    expect(await accountExists(horizon, user)).toBe(false);
    const received = (await nativeBalance(horizon, destination.publicKey())) - destBefore;
    expect(received).toBeGreaterThan(9_890_0000000n);
    expect(received).toBeLessThan(10_000_0000000n);
  }, 270_000);
});
