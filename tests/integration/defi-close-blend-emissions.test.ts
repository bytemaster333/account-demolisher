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

import { loadUserPositions } from "@/lib/adapters/blend/client";
import { BLEND_TESTNET_INFRASTRUCTURE, BLEND_TESTNET_POOL_IDS } from "@/lib/adapters/blend/pools";
import { TESTNET } from "@/lib/config/networks";
import { address as addr, i128 } from "@/lib/soroban/scval";
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

// a full close of an account that has accrued BLND emissions in a Blend pool,
// run through the app's own state machine and executor. the account borrows
// USDC against XLM collateral in the testnet v2 pool, whose USDC borrow side
// carries an emission program, so the close has to repay, withdraw, open the
// BLND trustline the claim pays into, claim the emissions and merge.
//
// on 2026-10-09 every emission program in the testnet pool had expired
// (expiration 1783301379, 2026-07-06) because nobody had run the pool's
// gulp_emissions since. it is a permissionless upkeep call that starts the next
// period from what the backstop already allotted the pool, so the test runs it
// when the USDC borrow program has run out. XLM reserves have no program.

const POOL = BLEND_TESTNET_POOL_IDS[0]!;
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);

function infra(name: string): string {
  const entry = BLEND_TESTNET_INFRASTRUCTURE.find((e) => e.name === name);
  if (entry === undefined) throw new Error(`no ${name} in the blend testnet snapshot`);
  return entry.id;
}
const USDC = infra("USDC");
const BLND = infra("BLND");

// blend request_type values (pool contract Request)
const SUPPLY_COLLATERAL = 2;
const BORROW = 4;

function request(asset: string, type: number, amount: bigint): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: nativeToScVal("address", { type: "symbol" }), val: addr(asset) }),
    new xdr.ScMapEntry({ key: nativeToScVal("amount", { type: "symbol" }), val: i128(amount) }),
    new xdr.ScMapEntry({
      key: nativeToScVal("request_type", { type: "symbol" }),
      val: nativeToScVal(type, { type: "u32" }),
    }),
  ]);
}

async function read(contract: string, fn: string, args: xdr.ScVal[], source: string) {
  return scValToNative((await simulateRead(rpc, contract, fn, args, source, TESTNET)).retval);
}

// a stellar asset contract's classic asset, from its "CODE:ISSUER" name
async function classicAsset(sac: string, source: string): Promise<{ asset: Asset; key: string }> {
  const [code, issuer] = String(await read(sac, "name", [], source)).split(":");
  if (code === undefined || issuer === undefined) throw new Error(`${sac} is not a SAC`);
  return { asset: new Asset(code, issuer), key: pathKey({ kind: "credit", code, issuer }) };
}

async function borrow(kp: Keypair, collateralXlm: bigint, usdc: bigint): Promise<void> {
  const user = kp.publicKey();
  await submitSorobanAs(
    kp,
    new Contract(POOL).call(
      "submit",
      addr(user),
      addr(user),
      addr(user),
      xdr.ScVal.scvVec([
        request(XLM_SAC, SUPPLY_COLLATERAL, collateralXlm),
        request(USDC, BORROW, usdc),
      ]),
    ),
  );
}

describe("integration: closing an account with accrued Blend emissions (testnet)", () => {
  it("repays, withdraws, opens the BLND line, claims the emissions and merges", async () => {
    const friend = Keypair.random();
    const kp = Keypair.random();
    const user = kp.publicKey();
    const destination = Keypair.random();
    await friendbotFund(TESTNET, friend.publicKey());
    await friendbotFund(TESTNET, user);
    await friendbotFund(TESTNET, destination.publicKey());

    const usdc = await classicAsset(USDC, user);
    const blnd = await classicAsset(BLND, user);

    // the USDC borrow side's emission program, restarted when it has run out
    const reserves = (await read(POOL, "get_reserve_list", [], user)) as string[];
    const usdcIndex = reserves.indexOf(USDC);
    expect(usdcIndex).toBeGreaterThanOrEqual(0);
    const borrowTokenId = usdcIndex * 2;
    const programOf = async () =>
      (await read(
        POOL,
        "get_reserve_emissions",
        [nativeToScVal(borrowTokenId, { type: "u32" })],
        user,
      )) as { eps: bigint; expiration: bigint } | null;
    const program = await programOf();
    if (program === null) throw new Error(`pool ${POOL} has no USDC borrow emission program`);
    if (program.expiration < BigInt(Math.floor(Date.now() / 1000) + 600)) {
      await submitSorobanAs(friend, new Contract(POOL).call("gulp_emissions"));
      const restarted = await programOf();
      expect(restarted?.expiration ?? 0n).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
    }

    // a friend borrows USDC too and sends 5 to the user, so the user holds more
    // USDC than its own debt plus the interest it accrues before the repay
    for (const kpx of [friend, kp]) {
      await submitClassicAs(kpx, (b) =>
        b.addOperation(Operation.changeTrust({ asset: usdc.asset })),
      );
    }
    await borrow(friend, 500_0000000n, 10_0000000n);
    await submitClassicAs(friend, (b) =>
      b.addOperation(Operation.payment({ destination: user, asset: usdc.asset, amount: "5" })),
    );
    await borrow(kp, 1500_0000000n, 50_0000000n);

    // emissions accrue per second; wait until the borrow position has some
    let claimable: readonly number[] = [];
    for (let i = 0; i < 30 && !claimable.includes(borrowTokenId); i++) {
      const loaded = await loadUserPositions(TESTNET, user, [POOL]);
      expect(loaded.errors).toEqual([]);
      claimable = loaded.positions[0]?.claimableEmissionTokenIds ?? [];
      if (!claimable.includes(borrowTokenId)) await new Promise((r) => setTimeout(r, 2_000));
    }
    expect(claimable).toContain(borrowTokenId);

    const destBefore = await nativeBalance(horizon, destination.publicKey());

    const { review, outcome } = await closeHeadless({
      publicKey: user,
      network: TESTNET,
      connector: new SecretKeyConnector(kp.secret()),
      destination: destination.publicKey(),
      useMediator: false,
      returnToIssuerAssetKeys: [usdc.key, blnd.key],
    });

    const kinds = [...review.context.tree!.allNodes.values()].map((n) => n.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "RepayBlend",
        "WithdrawBlend",
        "AddBlndTrustline",
        "ClaimBlendEmissions",
        "FinalClassicTx",
      ]),
    );

    expect(outcome.matches("succeeded"), outcomeSummary(outcome)).toBe(true);
    const claim = [...outcome.context.tree!.allNodes.values()].find(
      (n) => n.kind === "ClaimBlendEmissions",
    );
    expect(claim?.status).toBe("confirmed");
    const claimTx = await rpc.getTransaction(claim!.executed!.txHash);
    expect(claimTx.status).toBe("SUCCESS");

    // on chain: the account is gone and the pool holds nothing for it
    expect(await accountExists(horizon, user)).toBe(false);
    const after = await loadUserPositions(TESTNET, user, [POOL]);
    expect(after.errors).toEqual([]);
    const left = after.positions[0];
    expect((left?.collateral.size ?? 0) + (left?.liabilities.size ?? 0)).toBe(0);
    // the collateral came back as XLM; the USDC and BLND went to their issuers
    const received = (await nativeBalance(horizon, destination.publicKey())) - destBefore;
    expect(received).toBeGreaterThan(9_990_0000000n);
    expect(received).toBeLessThan(10_000_0000000n);
  }, 270_000);
});
