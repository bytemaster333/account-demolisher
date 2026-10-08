import { describe, it, expect } from "vitest";
import { Asset, Contract, Keypair, Operation, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { getAquariusRouterId } from "@/lib/adapters/aquarius/client";
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import type { AquariusPositionSummary } from "@/lib/adapters/positions/interface";
import { TESTNET } from "@/lib/config/networks";
import { pathKey } from "@/lib/types/plan";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

import {
  accountExists,
  closeHeadless,
  friendbotFund,
  nativeBalance,
  outcomeSummary,
} from "../helpers/headless-close";
import { horizon, submitClassicAs, submitSorobanAs } from "../helpers/testnet-seed";

// a full close of an account that holds a live Aquarius pool share, run through
// the app's own state machine and executor. the account buys testnet AQUA in
// the XLM/AQUA constant-product pool on the allow-listed testnet router and
// deposits into that pool, so the close must withdraw the share through the
// router (claiming whatever the pool's rewards owe first), dispose of the AQUA
// it gets back and merge.
//
// the pool belongs to Aquarius's testnet deployment, listed by
// amm-api-testnet.aqua.network/api/external/v1/pools; if Aquarius drains or
// removes it the setup swap fails and names the pool.

const AQUA_ISSUER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const AQUA = new Asset("AQUA", AQUA_ISSUER);
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);
const AQUA_SAC = AQUA.contractId(TESTNET.passphrase);
// constant product, 0.30% fee
const POOL_INDEX = "9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e";
const POOL_ADDRESS = "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC";

const tokens = (): xdr.ScVal =>
  xdr.ScVal.scvVec([XLM_SAC, AQUA_SAC].sort().map((t) => nativeToScVal(t, { type: "address" })));
const poolIndex = (): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(POOL_INDEX, "hex"));
const u128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u128" });

async function aquariusPools(user: string): Promise<readonly AquariusPositionSummary[]> {
  const positions = await new DirectContractProvider().getPositions(user, TESTNET);
  if (positions.errors.length > 0) {
    throw new Error(`discovery errors: ${JSON.stringify(positions.errors)}`);
  }
  return positions.aquarius;
}

describe("integration: closing an account with a live Aquarius pool share (testnet)", () => {
  it("withdraws the share, returns the AQUA and merges through the executor", async () => {
    const kp = Keypair.random();
    const user = kp.publicKey();
    const destination = Keypair.random();
    await friendbotFund(TESTNET, user);
    await friendbotFund(TESTNET, destination.publicKey());

    await submitClassicAs(kp, (b) => b.addOperation(Operation.changeTrust({ asset: AQUA })));
    const router = new Contract(getAquariusRouterId(TESTNET));
    try {
      await submitSorobanAs(
        kp,
        router.call(
          "swap",
          nativeToScVal(user, { type: "address" }),
          tokens(),
          nativeToScVal(XLM_SAC, { type: "address" }),
          nativeToScVal(AQUA_SAC, { type: "address" }),
          poolIndex(),
          u128(100_0000000n),
          u128(1n),
        ),
      );
    } catch (err) {
      throw new Error(`buying AQUA in testnet pool ${POOL_ADDRESS} failed: ${String(err)}`);
    }
    const aquaLine = (await horizon.loadAccount(user)).balances.find(
      (b) => "asset_code" in b && b.asset_code === "AQUA",
    );
    const aquaStroops = BigInt(Math.floor(Number(aquaLine?.balance ?? "0") * 1e7));
    expect(aquaStroops).toBeGreaterThan(0n);

    // all the AQUA and as much XLM as the pool price asks; a generous XLM
    // ceiling, the router takes the matching amount
    const desired = [XLM_SAC, AQUA_SAC]
      .sort()
      .map((t) => (t === XLM_SAC ? 1000_0000000n : aquaStroops));
    await submitSorobanAs(
      kp,
      router.call(
        "deposit",
        nativeToScVal(user, { type: "address" }),
        tokens(),
        poolIndex(),
        xdr.ScVal.scvVec(desired.map(u128)),
        u128(0n),
      ),
    );
    expect((await aquariusPools(user)).length).toBeGreaterThan(0);

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
    expect(kinds).toEqual(expect.arrayContaining(["WithdrawAquarius", "FinalClassicTx"]));

    expect(outcome.matches("succeeded"), outcomeSummary(outcome)).toBe(true);

    expect(await accountExists(horizon, user)).toBe(false);
    expect(await aquariusPools(user)).toHaveLength(0);
    // the 100 XLM that bought AQUA went back as AQUA to its issuer, so the
    // destination gets about 9,900 XLM: the friendbot 10,000 less that and fees
    const received = (await nativeBalance(horizon, destination.publicKey())) - destBefore;
    expect(received).toBeGreaterThan(9_890_0000000n);
    expect(received).toBeLessThan(10_000_0000000n);
  });
});
