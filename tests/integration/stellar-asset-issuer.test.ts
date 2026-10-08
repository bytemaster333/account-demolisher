import { describe, it, expect } from "vitest";
import {
  Asset,
  AuthRequiredFlag,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { exitTrustlineGaps, readWrappedAssets } from "@/lib/soroban/stellar-asset";
import { getHorizon } from "@/lib/stellar/horizon-client";

// live testnet check of what an issuer's account says about a payout line the
// close would open: with auth_required a new line can't receive the SAC payout,
// and with the issuer merged away no line can be opened at all.

const horizon = getHorizon(TESTNET);
const server = getRpc(TESTNET);

async function friendbot(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

async function submitSoroban(tx: Transaction, kp: Keypair): Promise<void> {
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send failed: ${JSON.stringify(sent)}`);
  const final = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} ended ${final.status}`);
  }
}

async function submitClassic(kp: Keypair, ops: xdr.Operation[]) {
  const account = await horizon.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(120).build();
  tx.sign(kp);
  return horizon.submitTransaction(tx);
}

async function deploySac(issuer: Keypair, asset: Asset): Promise<string> {
  const account = await server.getAccount(issuer.publicKey());
  await submitSoroban(
    new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.createStellarAssetContract({ asset }))
      .setTimeout(120)
      .build(),
    issuer,
  );
  return asset.contractId(TESTNET.passphrase);
}

describe("integration: payout lines and their issuer", () => {
  it("tells an auth_required issuer apart, and its new line can't receive the payout", async () => {
    const locked = Keypair.random();
    const open = Keypair.random();
    const holder = Keypair.random();
    await Promise.all([locked, open, holder].map((kp) => friendbot(kp.publicKey())));
    await submitClassic(locked, [Operation.setOptions({ setFlags: AuthRequiredFlag })]);
    const lockedAsset = new Asset("LCK", locked.publicKey());
    const openAsset = new Asset("OPN", open.publicKey());
    const lockedSac = await deploySac(locked, lockedAsset);
    const openSac = await deploySac(open, openAsset);

    const wrapped = await readWrappedAssets(
      server,
      TESTNET,
      [lockedSac, openSac],
      holder.publicKey(),
    );
    expect(wrapped.get(lockedSac)).toEqual({
      kind: "credit",
      code: "LCK",
      issuer: locked.publicKey(),
      issuerAuthRequired: true,
    });
    expect(wrapped.get(openSac)).toMatchObject({ issuerAuthRequired: false });
    expect(exitTrustlineGaps(holder.publicKey(), [], [lockedSac, openSac], wrapped)).toEqual([
      {
        contractId: lockedSac,
        code: "LCK",
        issuer: locked.publicKey(),
        reason: "issuer_requires_authorization",
      },
      { contractId: openSac, code: "OPN", issuer: open.publicKey(), reason: "missing" },
    ]);

    // the reason it is refused rather than planned: once the holder opens the
    // line, the SAC still can't pay into it
    await submitClassic(holder, [Operation.changeTrust({ asset: lockedAsset })]);
    const issuerAccount = await server.getAccount(locked.publicKey());
    const sim = await server.simulateTransaction(
      new TransactionBuilder(issuerAccount, {
        fee: BASE_FEE,
        networkPassphrase: TESTNET.passphrase,
      })
        .addOperation(
          new Contract(lockedSac).call(
            "transfer",
            nativeToScVal(locked.publicKey(), { type: "address" }),
            nativeToScVal(holder.publicKey(), { type: "address" }),
            nativeToScVal(1n, { type: "i128" }),
          ),
        )
        .setTimeout(120)
        .build(),
    );
    expect(rpc.Api.isSimulationError(sim)).toBe(true);
  }, 180_000);

  it("reports a missing line whose issuer account was merged away", async () => {
    const issuer = Keypair.random();
    const holder = Keypair.random();
    await Promise.all([issuer, holder].map((kp) => friendbot(kp.publicKey())));
    const asset = new Asset("GONE", issuer.publicKey());
    const sac = await deploySac(issuer, asset);
    await submitClassic(issuer, [Operation.accountMerge({ destination: holder.publicKey() })]);

    const wrapped = await readWrappedAssets(server, TESTNET, [sac], holder.publicKey());
    expect(wrapped.get(sac)).toMatchObject({ kind: "credit", issuerAuthRequired: null });
    expect(exitTrustlineGaps(holder.publicKey(), [], [sac], wrapped)).toEqual([
      { contractId: sac, code: "GONE", issuer: issuer.publicKey(), reason: "issuer_missing" },
    ]);
    // and the line really can't be opened
    await expect(submitClassic(holder, [Operation.changeTrust({ asset })])).rejects.toThrow();
  }, 180_000);
});
