import { describe, it, expect } from "vitest";
import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

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
      disposal: { returnToIssuerAssetKeys: [`USD:${issuer.publicKey()}`] },
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
});
