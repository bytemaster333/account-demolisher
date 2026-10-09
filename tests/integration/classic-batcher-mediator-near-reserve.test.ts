import { describe, it, expect } from "vitest";
import { Asset, BASE_FEE, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { batchClassicDemolition, mediatorFundingCheck } from "@/lib/plan/classic-batcher";
import { AccountNotFoundError, auditAccount } from "@/lib/stellar/account-audit";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { DEFAULT_TX_VALIDITY_SECONDS, fetchLedgerClock } from "@/lib/stellar/ledger-clock";
import { getHorizon } from "@/lib/stellar/horizon-client";
import type { ClassicBatch } from "@/lib/types/plan";

import { nativeBalance, toStroops } from "../helpers/headless-close";

// live testnet run of the batcher's exchange close for an account that sits
// close to its reserve (H-16). the close funds the helper (mediator) account
// with 2 XLM, and the account only has that much once its trustlines and data
// entry are removed and their reserves released. the batch therefore creates
// the helper account right before the merge, after the removals. the same
// operations with the creation first, where it used to sit, are refused with
// op_underfunded, which shows the account really is that close to its reserve.

const server = getHorizon(TESTNET);
const BASE_RESERVE = 5_000_000n;
const MEDIATOR_FUNDING = 20_000_000n;

async function friendbot(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

async function submitBatch(batch: ClassicBatch, signer: Keypair) {
  const account = await server.loadAccount(signer.publicKey());
  const clock = await fetchLedgerClock(TESTNET);
  const built = buildClassicTransaction(
    batch,
    account,
    TESTNET,
    Number(BASE_FEE),
    DEFAULT_TX_VALIDITY_SECONDS,
    clock.closedAt,
  );
  built.transaction.sign(signer);
  return server.submitTransaction(built.transaction);
}

function resultCodes(err: unknown): unknown {
  return (err as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data
    ?.extras?.result_codes;
}

describe("integration: exchange close of a near-reserve account (H-16)", () => {
  it("funds the helper account after the removals free the reserve, and merges into it", async () => {
    const funder = Keypair.random();
    const issuer = Keypair.random();
    const closer = Keypair.random();
    const exchange = Keypair.random();
    const mediator = Keypair.random();
    await Promise.all([funder, issuer, exchange].map((k) => friendbot(k.publicKey())));

    // 4.6 XLM with three trustlines and a data entry: a 3 XLM minimum reserve,
    // so 1.6 XLM spendable, under the 2 XLM the helper account needs
    const setup = new TransactionBuilder(await server.loadAccount(funder.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        Operation.createAccount({ destination: closer.publicKey(), startingBalance: "4.6" }),
      )
      .addOperation(
        Operation.changeTrust({
          asset: new Asset("AAA", issuer.publicKey()),
          source: closer.publicKey(),
        }),
      )
      .addOperation(
        Operation.changeTrust({
          asset: new Asset("BBB", issuer.publicKey()),
          source: closer.publicKey(),
        }),
      )
      .addOperation(
        Operation.changeTrust({
          asset: new Asset("CCC", issuer.publicKey()),
          source: closer.publicKey(),
        }),
      )
      .addOperation(Operation.manageData({ name: "k", value: "v", source: closer.publicKey() }))
      .setTimeout(120)
      .build();
    setup.sign(funder, closer);
    await server.submitTransaction(setup);

    const audit = await auditAccount(closer.publicKey(), TESTNET);
    const balance = await nativeBalance(server, closer.publicKey());
    const minReserve = (2n + BigInt(audit.subentryCount)) * BASE_RESERVE;
    expect(balance - minReserve).toBeLessThan(MEDIATOR_FUNDING);

    const batches = batchClassicDemolition(audit, {
      destination: exchange.publicKey(),
      useMediator: true,
      mediatorPublicKey: mediator.publicKey(),
      feePerOpStroops: Number(BASE_FEE),
    });
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    const kinds = batch.operations.map((o) => o.kind);
    // the helper account is created right before the merge, after every removal
    expect(kinds.slice(-2)).toEqual(["create_account_mediator", "account_merge"]);
    expect(kinds.filter((k) => k === "change_trust_remove")).toHaveLength(3);
    expect(kinds.indexOf("create_account_mediator")).toBeGreaterThan(
      kinds.lastIndexOf("change_trust_remove"),
    );
    expect(mediatorFundingCheck(audit, batches, Number(BASE_FEE))?.sufficient).toBe(true);

    // the old order, with the helper account created first, is refused
    const create = batch.operations.find((o) => o.kind === "create_account_mediator")!;
    const createFirst: ClassicBatch = {
      ...batch,
      operations: [create, ...batch.operations.filter((o) => o !== create)],
    };
    let refused: unknown = null;
    try {
      await submitBatch(createFirst, closer);
    } catch (err) {
      refused = resultCodes(err);
    }
    expect(refused).toMatchObject({
      transaction: "tx_failed",
      operations: expect.arrayContaining(["op_underfunded"]),
    });
    expect((refused as { operations: string[] }).operations[0]).toBe("op_underfunded");

    // the batch as planned lands: the account is gone and its XLM, less fees,
    // sits in the helper account
    const before = await nativeBalance(server, closer.publicKey());
    const landed = await submitBatch(batch, closer);
    expect(landed.successful).toBe(true);
    await expect(auditAccount(closer.publicKey(), TESTNET)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
    const helper = await server.loadAccount(mediator.publicKey());
    const held = toStroops(helper.balances.find((b) => b.asset_type === "native")!.balance);
    const fees = BigInt(BASE_FEE) * BigInt(batch.operations.length);
    expect(held).toBe(before - fees);
  });
});
