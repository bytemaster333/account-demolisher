import { describe, it, expect } from "vitest";
import {
  Asset,
  BASE_FEE,
  Claimant,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { loadBundleFreshness } from "@/lib/multisig/bundle-freshness";
import { buildCloseTransaction } from "@/lib/multisig/signing-request";
import { auditAccount } from "@/lib/stellar/account-audit";
import { getHorizon } from "@/lib/stellar/horizon-client";

// live testnet proof that a published bundle is checked against the account
// before submit: build a real bundle, then change the account the way a griefer
// or a second wallet would, and confirm the drift is reported.

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

async function submit(kp: Keypair, ...ops: ReturnType<typeof Operation.payment>[]): Promise<void> {
  const source = await server.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  }).setTimeout(120);
  for (const op of ops) b.addOperation(op);
  const tx = b.build();
  tx.sign(kp);
  await server.submitTransaction(tx);
}

describe("integration: bundle freshness (testnet)", () => {
  it("passes for an unchanged account and reports a dust credit and a sequence bump", async () => {
    const owner = Keypair.random();
    const issuer = Keypair.random();
    const destination = Keypair.random();
    await Promise.all([
      friendbotFund(owner.publicKey()),
      friendbotFund(issuer.publicKey()),
      friendbotFund(destination.publicKey()),
    ]);
    const usd = new Asset("USD", issuer.publicKey());

    await submit(
      owner,
      Operation.changeTrust({ asset: usd }),
      Operation.manageData({ name: "note", value: "hi" }),
    );
    await submit(
      issuer,
      Operation.payment({ destination: owner.publicKey(), asset: usd, amount: "5" }),
    );

    const audit = await auditAccount(owner.publicKey(), TESTNET);
    const tx = buildCloseTransaction({
      audit,
      destination: destination.publicKey(),
      network: TESTNET,
      sourceAccount: await server.loadAccount(owner.publicKey()),
      disposal: { claimableBalanceIds: [], returnToIssuerAssetKeys: [`USD:${issuer.publicKey()}`] },
    });
    tx.sign(owner);
    const xdr = tx.toXdr();

    expect(await loadBundleFreshness(server, xdr, TESTNET.passphrase)).toEqual({ ok: true });

    // anyone can send dust to a trustline the bundle removes
    await submit(
      issuer,
      Operation.payment({ destination: owner.publicKey(), asset: usd, amount: "0.0000001" }),
    );
    const dusted = await loadBundleFreshness(server, xdr, TESTNET.passphrase);
    expect(dusted.ok).toBe(false);
    if (!dusted.ok) expect(dusted.reasons.join(" ")).toMatch(/USD .* is now 5\.0000001/);

    // a second transaction from the account moves its sequence number
    await submit(owner, Operation.bumpSequence({ bumpTo: "0" }));
    const bumped = await loadBundleFreshness(server, xdr, TESTNET.passphrase);
    expect(bumped.ok).toBe(false);
    if (!bumped.ok) expect(bumped.reasons.join(" ")).toMatch(/sequence number moved/);
  });

  it("reports an entry the account starts sponsoring without moving its sequence", async () => {
    const owner = Keypair.random();
    const other = Keypair.random();
    await Promise.all([friendbotFund(owner.publicKey()), friendbotFund(other.publicKey())]);

    // a balance the owner sponsors with two claimants counts twice in
    // num_sponsoring; the bundle claims it, which releases both
    await submit(
      owner,
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: "1",
        claimants: [new Claimant(owner.publicKey()), new Claimant(other.publicKey())],
      }),
    );
    const cbs = await server.claimableBalances().sponsor(owner.publicKey()).call();
    const cbId = cbs.records[0]!.id;

    const audit = await auditAccount(owner.publicKey(), TESTNET);
    const tx = buildCloseTransaction({
      audit,
      destination: other.publicKey(),
      network: TESTNET,
      sourceAccount: await server.loadAccount(owner.publicKey()),
      disposal: { claimableBalanceIds: [cbId] },
    });
    tx.sign(owner);
    const xdr = tx.toXdr();
    expect(await loadBundleFreshness(server, xdr, TESTNET.passphrase)).toEqual({ ok: true });

    // the owner sponsors a data entry of another account, inside that account's
    // transaction, so the owner's sequence stays where the bundle expects it
    const otherAccount = await server.loadAccount(other.publicKey());
    const sandwich = new TransactionBuilder(otherAccount, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        Operation.beginSponsoringFutureReserves({
          sponsoredId: other.publicKey(),
          source: owner.publicKey(),
        }),
      )
      .addOperation(Operation.manageData({ name: "sponsored", value: "1" }))
      .addOperation(Operation.endSponsoringFutureReserves({}))
      .setTimeout(120)
      .build();
    sandwich.sign(other, owner);
    await server.submitTransaction(sandwich);

    const drifted = await loadBundleFreshness(server, xdr, TESTNET.passphrase);
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) {
      expect(drifted.reasons).toHaveLength(1);
      expect(drifted.reasons[0]).toMatch(/sponsors 1 ledger entry/);
    }

    // and the chain agrees: the merge fails because the owner is still a sponsor
    const failed = await server.submitTransaction(tx).then(
      () => null,
      (e: unknown) =>
        (e as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data
          ?.extras?.result_codes,
    );
    expect(JSON.stringify(failed)).toMatch(/op_is_sponsor/);
  });
});
