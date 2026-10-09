import { randomBytes } from "node:crypto";

import { describe, it, expect } from "vitest";
import { Address, Asset, Contract, Keypair, Operation, nativeToScVal } from "@stellar/stellar-sdk";

import { getSoroswapRouterId } from "@/lib/adapters/soroswap/router";
import { TESTNET } from "@/lib/config/networks";
import { address as addr, fromScValI128, i128 } from "@/lib/soroban/scval";
import { simulateRead } from "@/lib/soroban/simulate";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

import {
  accountExists,
  closeHeadless,
  friendbotFund,
  nativeBalance,
  outcomeSummary,
} from "../helpers/headless-close";
import { horizon, rpc, submitSorobanAs } from "../helpers/testnet-seed";

// full closes of an account that holds a standalone SEP-41 token (a contract
// token, not a classic asset's SAC), run through the app's own state machine
// and executor. the token is a fresh instance of the soroban token wasm already
// installed on testnet. with "convert held tokens to XLM" chosen, the token has
// a Soroswap pair against XLM that another account funds deeply, so the user's
// sale stays under the price-impact cap and the pair keeps liquidity after it;
// the close must quote the route, swap the whole balance through the
// allow-listed router and merge the XLM it got. without it, the close must send
// the token to the destination as it is. sending it creates the destination's
// balance entry, whose rent put the transfer at about 0.26 XLM of resource fee
// on 2026-10-09, over the 0.2 XLM cap the transfer used to share with the
// allowance revoke; the close refused it and left the token behind.
//
// a held "token" whose transfer can't even be built must not end as a clean
// close either: the run names it as left on the closed account.
//
// the wasm is the one behind testnet token CCYPRFTJ...; if it is ever archived
// or pruned the deploy fails and names the hash.

const TOKEN_WASM_HASH = "464c7cf3fb3cd426e700973c98ae63dee903e83d411491b691dad72c035dcd7d";
const XLM_SAC = Asset.native().contractId(TESTNET.passphrase);

async function tokenBalance(token: string, holder: string): Promise<bigint> {
  const { retval } = await simulateRead(rpc, token, "balance", [addr(holder)], holder, TESTNET);
  return fromScValI128(retval);
}

// a fresh token instance the admin administers
async function deployToken(admin: Keypair): Promise<string> {
  let deployHash: string;
  try {
    deployHash = await submitSorobanAs(
      admin,
      Operation.createCustomContract({
        address: Address.fromString(admin.publicKey()),
        wasmHash: Buffer.from(TOKEN_WASM_HASH, "hex"),
        salt: randomBytes(32),
      }),
    );
  } catch (err) {
    throw new Error(`deploying token wasm ${TOKEN_WASM_HASH} failed: ${String(err)}`);
  }
  const deployed = await rpc.getTransaction(deployHash);
  if (deployed.status !== "SUCCESS" || deployed.returnValue === undefined) {
    throw new Error(`deploy ${deployHash} returned no contract address`);
  }
  const token = Address.fromScVal(deployed.returnValue).toString();
  await submitSorobanAs(
    admin,
    new Contract(token).call(
      "initialize",
      addr(admin.publicKey()),
      nativeToScVal(7, { type: "u32" }),
      nativeToScVal("Close Test Token", { type: "string" }),
      nativeToScVal("CTT", { type: "string" }),
    ),
  );
  return token;
}

describe("integration: closing an account that holds a contract token (testnet)", () => {
  it("swaps the token through the Soroswap router and merges through the executor", async () => {
    const lp = Keypair.random();
    const kp = Keypair.random();
    const user = kp.publicKey();
    const destination = Keypair.random();
    await friendbotFund(TESTNET, lp.publicKey());
    await friendbotFund(TESTNET, user);
    await friendbotFund(TESTNET, destination.publicKey());

    const token = await deployToken(lp);
    const tc = new Contract(token);
    await submitSorobanAs(lp, tc.call("mint", addr(lp.publicKey()), i128(10_000_0000000n)));
    await submitSorobanAs(lp, tc.call("mint", addr(user), i128(50_0000000n)));

    // 1,000 XLM against 10,000 CTT: 50 CTT sells for about 5 XLM at about 0.5%
    // price impact, well under the 2% cap
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    await submitSorobanAs(
      lp,
      new Contract(getSoroswapRouterId(TESTNET)).call(
        "add_liquidity",
        addr(XLM_SAC),
        addr(token),
        i128(1_000_0000000n),
        i128(10_000_0000000n),
        i128(0n),
        i128(0n),
        addr(lp.publicKey()),
        nativeToScVal(deadline, { type: "u64" }),
      ),
    );
    expect(await tokenBalance(token, user)).toBe(50_0000000n);

    const destBefore = await nativeBalance(horizon, destination.publicKey());

    const { review, outcome } = await closeHeadless({
      publicKey: user,
      network: TESTNET,
      connector: new SecretKeyConnector(kp.secret()),
      destination: destination.publicKey(),
      useMediator: false,
      selectedHeldTokens: [{ contractId: token, balance: 50_0000000n }],
      convertHeldTokensToXLM: true,
    });

    const nodes = [...review.context.tree!.allNodes.values()];
    expect(nodes.map((n) => n.kind)).toEqual(
      expect.arrayContaining(["ConvertSorobanToXLM", "FinalClassicTx"]),
    );
    expect(nodes.map((n) => n.kind)).not.toContain("TransferAsIs");

    expect(outcome.matches("succeeded"), outcomeSummary(outcome)).toBe(true);
    const convert = [...outcome.context.tree!.allNodes.values()].find(
      (n) => n.kind === "ConvertSorobanToXLM",
    );
    expect(convert?.status).toBe("confirmed");

    // on chain: the account is gone, its token balance went into the pair, and
    // the destination got the friendbot 10,000 XLM plus about 5 XLM from the sale
    expect(await accountExists(horizon, user)).toBe(false);
    expect(await tokenBalance(token, user)).toBe(0n);
    const received = (await nativeBalance(horizon, destination.publicKey())) - destBefore;
    expect(received).toBeGreaterThan(10_004_0000000n);
    expect(received).toBeLessThan(10_005_0000000n);
  });

  it("sends the token to the destination as-is when conversion is not chosen", async () => {
    const admin = Keypair.random();
    const kp = Keypair.random();
    const user = kp.publicKey();
    const destination = Keypair.random();
    await friendbotFund(TESTNET, admin.publicKey());
    await friendbotFund(TESTNET, user);
    await friendbotFund(TESTNET, destination.publicKey());

    const token = await deployToken(admin);
    await submitSorobanAs(admin, new Contract(token).call("mint", addr(user), i128(50_0000000n)));
    const destBefore = await nativeBalance(horizon, destination.publicKey());

    const { review, outcome } = await closeHeadless({
      publicKey: user,
      network: TESTNET,
      connector: new SecretKeyConnector(kp.secret()),
      destination: destination.publicKey(),
      useMediator: false,
      selectedHeldTokens: [{ contractId: token, balance: 50_0000000n }],
    });

    const kinds = [...review.context.tree!.allNodes.values()].map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["TransferAsIs", "FinalClassicTx"]));
    expect(kinds).not.toContain("ConvertSorobanToXLM");

    expect(outcome.matches("succeeded"), outcomeSummary(outcome)).toBe(true);
    expect(outcome.context.leftBehindTokens).toEqual([]);
    const transfer = [...outcome.context.tree!.allNodes.values()].find(
      (n) => n.kind === "TransferAsIs",
    );
    expect(
      transfer?.status,
      `${outcomeSummary(outcome)}\nnotes: ${outcome.context.executionNotes?.join(" | ")}`,
    ).toBe("confirmed");

    // on chain: the account is gone and the whole token balance moved to the
    // destination, next to the merged XLM
    expect(await accountExists(horizon, user)).toBe(false);
    expect(await tokenBalance(token, user)).toBe(0n);
    expect(await tokenBalance(token, destination.publicKey())).toBe(50_0000000n);
    const received = (await nativeBalance(horizon, destination.publicKey())) - destBefore;
    expect(received).toBeGreaterThan(9_999_0000000n);
    expect(received).toBeLessThan(10_000_0000000n);
  });

  it("names a held token it could not send instead of reporting a clean close", async () => {
    // the soroswap router answers no balance(), so no transfer of it can be
    // built: the stand-in for a broken or hostile token the user selected
    const notAToken = getSoroswapRouterId(TESTNET);
    const kp = Keypair.random();
    const user = kp.publicKey();
    const destination = Keypair.random();
    await friendbotFund(TESTNET, user);
    await friendbotFund(TESTNET, destination.publicKey());

    const { outcome } = await closeHeadless({
      publicKey: user,
      network: TESTNET,
      connector: new SecretKeyConnector(kp.secret()),
      destination: destination.publicKey(),
      useMediator: false,
      selectedHeldTokens: [{ contractId: notAToken, balance: 5n }],
    });

    // the merge landed, so the account is gone; the run says what it left
    expect(outcome.matches("succeeded"), outcomeSummary(outcome)).toBe(true);
    expect(await accountExists(horizon, user)).toBe(false);
    expect(outcome.context.leftBehindTokens).toEqual([
      expect.objectContaining({ contractId: notAToken, amount: 5n }),
    ]);
    const last = outcome.context.progress.at(-1);
    expect(last?.message).toBe(
      "Account closed, but 1 held token could not be sent and stays on the closed account.",
    );
  });
});
