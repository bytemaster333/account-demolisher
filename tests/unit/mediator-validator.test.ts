import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  MAX_TIME_BOUND_SECONDS,
  validateMediatorForwardEnvelope,
  validateMergeEnvelope,
} from "@/lib/mediator/validator";

// The mediator co-signing validator is the primary server-side security
// boundary: it decides which 2-op envelopes the mediator key will sign. These
// tests lock in the exact shape it accepts and every reason it rejects.

const NET = Networks.TESTNET;
const mediator = Keypair.random();
const MED = mediator.publicKey();
const user = Keypair.random().publicKey();
const cex = Keypair.random().publicKey();
const otherIssuer = Keypair.random().publicKey();

function builder(sourcePk: string, maxTimeOffset: number = 1800): TransactionBuilder {
  const now = Math.floor(Date.now() / 1000);
  return new TransactionBuilder(new Account(sourcePk, "1"), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: now + maxTimeOffset },
  });
}

// canonical, valid merge envelope: user merges into mediator, mediator funds
function validMergeTx(): Transaction {
  return builder(user)
    .addOperation(Operation.accountMerge({ destination: MED }))
    .addOperation(
      Operation.payment({ source: MED, destination: user, asset: Asset.native(), amount: "1" }),
    )
    .build();
}

// canonical, valid forward envelope: mediator pays out then merges to the cex
function validForwardXdr(): string {
  return builder(MED)
    .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "5" }))
    .addOperation(Operation.accountMerge({ destination: cex }))
    .build()
    .toXDR();
}

describe("validateMergeEnvelope", () => {
  it("accepts a well-formed 2-op merge envelope", () => {
    const res = validateMergeEnvelope(validMergeTx().toXDR(), NET, MED);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tx.operations).toHaveLength(2);
  });

  it("rejects unparseable XDR with MALFORMED_XDR", () => {
    const res = validateMergeEnvelope("definitely-not-xdr", NET, MED);
    expect(res).toMatchObject({ ok: false, code: "MALFORMED_XDR" });
  });

  it("rejects fee-bump envelopes with FEE_BUMP_NOT_ALLOWED", () => {
    const fb = TransactionBuilder.buildFeeBumpTransaction(mediator, "10000", validMergeTx(), NET);
    const res = validateMergeEnvelope(fb.toXDR(), NET, MED);
    expect(res).toMatchObject({ ok: false, code: "FEE_BUMP_NOT_ALLOWED" });
  });

  it("rejects a wrong operation count with WRONG_OPERATION_COUNT", () => {
    const xdr = builder(user)
      .addOperation(Operation.accountMerge({ destination: MED }))
      .build()
      .toXDR();
    const res = validateMergeEnvelope(xdr, NET, MED);
    expect(res).toMatchObject({ ok: false, code: "WRONG_OPERATION_COUNT" });
  });

  it("rejects when op0 is not accountMerge (OP0_NOT_ACCOUNT_MERGE)", () => {
    const xdr = builder(user)
      .addOperation(Operation.payment({ destination: MED, asset: Asset.native(), amount: "1" }))
      .addOperation(
        Operation.payment({ source: MED, destination: user, asset: Asset.native(), amount: "1" }),
      )
      .build()
      .toXDR();
    const res = validateMergeEnvelope(xdr, NET, MED);
    expect(res).toMatchObject({ ok: false, code: "OP0_NOT_ACCOUNT_MERGE" });
  });

  it("rejects when merge destination is not the mediator (OP0_DESTINATION_NOT_MEDIATOR)", () => {
    const xdr = builder(user)
      .addOperation(Operation.accountMerge({ destination: cex }))
      .addOperation(
        Operation.payment({ source: MED, destination: user, asset: Asset.native(), amount: "1" }),
      )
      .build()
      .toXDR();
    const res = validateMergeEnvelope(xdr, NET, MED);
    expect(res).toMatchObject({ ok: false, code: "OP0_DESTINATION_NOT_MEDIATOR" });
  });

  it("rejects when op1 is neither payment nor createAccount (OP1_NOT_PAYMENT_OR_CREATE_ACCOUNT)", () => {
    const xdr = builder(user)
      .addOperation(Operation.accountMerge({ destination: MED }))
      .addOperation(Operation.bumpSequence({ source: MED, bumpTo: "2" }))
      .build()
      .toXDR();
    const res = validateMergeEnvelope(xdr, NET, MED);
    expect(res).toMatchObject({ ok: false, code: "OP1_NOT_PAYMENT_OR_CREATE_ACCOUNT" });
  });

  it("accepts createAccount as op1", () => {
    const xdr = builder(user)
      .addOperation(Operation.accountMerge({ destination: MED }))
      .addOperation(
        Operation.createAccount({ source: MED, destination: user, startingBalance: "1" }),
      )
      .build()
      .toXDR();
    expect(validateMergeEnvelope(xdr, NET, MED).ok).toBe(true);
  });

  it("rejects when op1 source is not the mediator (OP1_SOURCE_NOT_MEDIATOR)", () => {
    const xdr = builder(user)
      .addOperation(Operation.accountMerge({ destination: MED }))
      .addOperation(Operation.payment({ destination: user, asset: Asset.native(), amount: "1" }))
      .build()
      .toXDR();
    const res = validateMergeEnvelope(xdr, NET, MED);
    expect(res).toMatchObject({ ok: false, code: "OP1_SOURCE_NOT_MEDIATOR" });
  });

  it("rejects a non-native op1 payment asset (OP1_ASSET_NOT_NATIVE)", () => {
    const xdr = builder(user)
      .addOperation(Operation.accountMerge({ destination: MED }))
      .addOperation(
        Operation.payment({
          source: MED,
          destination: user,
          asset: new Asset("USD", otherIssuer),
          amount: "1",
        }),
      )
      .build()
      .toXDR();
    const res = validateMergeEnvelope(xdr, NET, MED);
    expect(res).toMatchObject({ ok: false, code: "OP1_ASSET_NOT_NATIVE" });
  });

  it("rejects an envelope with no maxTime (MISSING_TIME_BOUNDS)", () => {
    const xdr = new TransactionBuilder(new Account(user, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(Operation.accountMerge({ destination: MED }))
      .addOperation(
        Operation.payment({ source: MED, destination: user, asset: Asset.native(), amount: "1" }),
      )
      .build()
      .toXDR();
    const res = validateMergeEnvelope(xdr, NET, MED);
    expect(res).toMatchObject({ ok: false, code: "MISSING_TIME_BOUNDS" });
  });

  it("rejects a maxTime further than the allowed horizon (TIME_BOUNDS_EXCESSIVE)", () => {
    const xdr = builder(user, MAX_TIME_BOUND_SECONDS + 3600)
      .addOperation(Operation.accountMerge({ destination: MED }))
      .addOperation(
        Operation.payment({ source: MED, destination: user, asset: Asset.native(), amount: "1" }),
      )
      .build()
      .toXDR();
    const res = validateMergeEnvelope(xdr, NET, MED);
    expect(res).toMatchObject({ ok: false, code: "TIME_BOUNDS_EXCESSIVE" });
  });
});

describe("validateMediatorForwardEnvelope", () => {
  it("accepts a well-formed forward envelope", () => {
    const res = validateMediatorForwardEnvelope(validForwardXdr(), NET, MED);
    expect(res.ok).toBe(true);
  });

  it("rejects unparseable XDR with MALFORMED_XDR", () => {
    expect(validateMediatorForwardEnvelope("nope", NET, MED)).toMatchObject({
      ok: false,
      code: "MALFORMED_XDR",
    });
  });

  it("rejects when the tx source is not the mediator (FORWARD_TX_SOURCE_NOT_MEDIATOR)", () => {
    const xdr = builder(user)
      .addOperation(
        Operation.payment({ source: MED, destination: cex, asset: Asset.native(), amount: "5" }),
      )
      .addOperation(Operation.accountMerge({ source: MED, destination: cex }))
      .build()
      .toXDR();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED)).toMatchObject({
      ok: false,
      code: "FORWARD_TX_SOURCE_NOT_MEDIATOR",
    });
  });

  it("rejects when forward op0 is not a payment (FORWARD_OP0_NOT_PAYMENT)", () => {
    const xdr = builder(MED)
      .addOperation(Operation.accountMerge({ destination: cex }))
      .addOperation(Operation.accountMerge({ destination: cex }))
      .build()
      .toXDR();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED)).toMatchObject({
      ok: false,
      code: "FORWARD_OP0_NOT_PAYMENT",
    });
  });

  it("rejects a non-native forward payment (FORWARD_OP0_ASSET_NOT_NATIVE)", () => {
    const xdr = builder(MED)
      .addOperation(
        Operation.payment({ destination: cex, asset: new Asset("USD", otherIssuer), amount: "5" }),
      )
      .addOperation(Operation.accountMerge({ destination: cex }))
      .build()
      .toXDR();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED)).toMatchObject({
      ok: false,
      code: "FORWARD_OP0_ASSET_NOT_NATIVE",
    });
  });

  it("rejects when forward op1 is not accountMerge (FORWARD_OP1_NOT_ACCOUNT_MERGE)", () => {
    const xdr = builder(MED)
      .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "5" }))
      .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "1" }))
      .build()
      .toXDR();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED)).toMatchObject({
      ok: false,
      code: "FORWARD_OP1_NOT_ACCOUNT_MERGE",
    });
  });

  it("rejects a forward that splits payout and merge to different destinations (FORWARD_DESTINATION_MISMATCH)", () => {
    const attacker = Keypair.random().publicKey();
    const xdr = builder(MED)
      .addOperation(
        Operation.payment({ destination: attacker, asset: Asset.native(), amount: "5" }),
      )
      .addOperation(Operation.accountMerge({ destination: cex }))
      .build()
      .toXDR();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED)).toMatchObject({
      ok: false,
      code: "FORWARD_DESTINATION_MISMATCH",
    });
  });
});
