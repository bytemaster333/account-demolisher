import { describe, it, expect } from "vitest";
import { Asset, Contract, Keypair, Operation, nativeToScVal } from "@stellar/stellar-sdk";

import { discoverSoroswapPositions } from "@/lib/adapters/soroswap/discovery";
import { getSoroswapRouterId } from "@/lib/adapters/soroswap/router";
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
import { horizon, rpc, submitClassicAs, submitSorobanAs } from "../helpers/testnet-seed";

// a full close of an account that holds a live Soroswap LP position, run through
// the app's own state machine and executor. the pair is created for the run on
// the allow-listed testnet router (XLM against a fresh classic asset whose SAC
// is deployed here), so the test does not depend on anyone else's liquidity.
// the close must withdraw the LP through the router, dispose of the credited
// token (returned to its issuer, the consent the review asks for since a fresh
// asset has no market) and merge.

const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);

describe("integration: closing an account with a live Soroswap LP position (testnet)", () => {
  it("withdraws the LP, returns the paired token and merges through the executor", async () => {
    const issuer = Keypair.random();
    const kp = Keypair.random();
    const user = kp.publicKey();
    const destination = Keypair.random();
    await friendbotFund(TESTNET, issuer.publicKey());
    await friendbotFund(TESTNET, user);
    await friendbotFund(TESTNET, destination.publicKey());

    const tok = new Asset("SWLP", issuer.publicKey());
    const tokSac = tok.contractId(TESTNET.passphrase);
    await submitClassicAs(kp, (b) => b.addOperation(Operation.changeTrust({ asset: tok })));
    await submitClassicAs(issuer, (b) =>
      b.addOperation(Operation.payment({ destination: user, asset: tok, amount: "1000" })),
    );
    await submitSorobanAs(issuer, Operation.createStellarAssetContract({ asset: tok }));

    // 200 XLM against all 1000 SWLP, so no SWLP is left on the account before
    // the close and the withdraw is what credits it back
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    await submitSorobanAs(
      kp,
      new Contract(getSoroswapRouterId(TESTNET)).call(
        "add_liquidity",
        nativeToScVal(XLM_SAC, { type: "address" }),
        nativeToScVal(tokSac, { type: "address" }),
        nativeToScVal(200_0000000n, { type: "i128" }),
        nativeToScVal(1000_0000000n, { type: "i128" }),
        nativeToScVal(0n, { type: "i128" }),
        nativeToScVal(0n, { type: "i128" }),
        nativeToScVal(user, { type: "address" }),
        nativeToScVal(deadline, { type: "u64" }),
      ),
    );
    const held = await discoverSoroswapPositions(rpc, TESTNET, user);
    expect(held).toHaveLength(1);

    const destBefore = await nativeBalance(horizon, destination.publicKey());

    const { review, outcome } = await closeHeadless({
      publicKey: user,
      network: TESTNET,
      connector: new SecretKeyConnector(kp.secret()),
      destination: destination.publicKey(),
      useMediator: false,
      returnToIssuerAssetKeys: [
        pathKey({ kind: "credit", code: "SWLP", issuer: issuer.publicKey() }),
      ],
    });

    const kinds = [...review.context.tree!.allNodes.values()].map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["WithdrawSoroswapLp", "FinalClassicTx"]));

    expect(outcome.matches("succeeded"), outcomeSummary(outcome)).toBe(true);

    // on chain: the account is gone, its LP balance is zero, the SWLP went back
    // to the issuer (which holds no line for its own asset, so it just burns)
    // and the destination got the XLM side of the pool plus the rest
    expect(await accountExists(horizon, user)).toBe(false);
    expect(await discoverSoroswapPositions(rpc, TESTNET, user)).toHaveLength(0);
    const received = (await nativeBalance(horizon, destination.publicKey())) - destBefore;
    // 10,000 from friendbot less fees and the pair's permanently locked minimum
    // liquidity, which is a tiny fraction of one XLM
    expect(received).toBeGreaterThan(9_990_0000000n);
    expect(received).toBeLessThan(10_000_0000000n);
  });
});
