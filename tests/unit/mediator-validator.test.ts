import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { encodeMemoCommitment, MAX_FORWARD_FEE_PER_OP } from "@/lib/mediator/forward-terms";
import {
  MAX_TIME_BOUND_SECONDS,
  validateMediatorForwardEnvelope as validateWithTerms,
} from "@/lib/mediator/validator";

// The mediator co-signing validator is the primary server-side security
// boundary. The mediator ONLY signs the forward envelope: a mediator-sourced
// native payout + accountMerge, both to the same destination. (The old "merge"
// variant left op1's amount/destination unbounded, a mediator-siphon surface ,
// and was removed, so there is nothing else to accept.)

const NET = Networks.TESTNET;
const mediator = Keypair.random();
const MED = mediator.publicKey();
const user = Keypair.random().publicKey();
const cex = Keypair.random().publicKey();
const otherIssuer = Keypair.random().publicKey();
type BuilderOptions = Partial<NonNullable<ConstructorParameters<typeof TransactionBuilder>[1]>>;
const NO_MEMO = encodeMemoCommitment(Memo.none());

// most cases commit no memo; the memo cases pass their own terms
function validateMediatorForwardEnvelope(
  envelopeXdr: string,
  passphrase: string,
  mediatorPk: string,
  destination: string,
  memoXdr: string = NO_MEMO,
) {
  return validateWithTerms(envelopeXdr, passphrase, mediatorPk, { destination, memoXdr });
}

function builder(
  sourcePk: string,
  maxTimeOffset: number = 1800,
  extra: BuilderOptions = {},
): TransactionBuilder {
  const now = Math.floor(Date.now() / 1000);
  return new TransactionBuilder(new Account(sourcePk, "1"), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: now + maxTimeOffset },
    ...extra,
  });
}

function forwardWith(extra: BuilderOptions): string {
  return builder(MED, 1800, extra)
    .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "5" }))
    .addOperation(Operation.accountMerge({ destination: cex }))
    .build()
    .toXdr();
}

// canonical, valid forward envelope: mediator pays out then merges to the cex
function validForwardTx(): Transaction {
  return builder(MED)
    .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "5" }))
    .addOperation(Operation.accountMerge({ destination: cex }))
    .build();
}

describe("validateMediatorForwardEnvelope", () => {
  it("accepts a well-formed forward envelope", () => {
    const res = validateMediatorForwardEnvelope(validForwardTx().toXdr(), NET, MED, cex);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tx.operations).toHaveLength(2);
  });

  it("rejects unparseable XDR (MALFORMED_XDR)", () => {
    expect(validateMediatorForwardEnvelope("nope", NET, MED, cex)).toMatchObject({
      ok: false,
      code: "MALFORMED_XDR",
    });
  });

  it("rejects fee-bump envelopes (FEE_BUMP_NOT_ALLOWED)", () => {
    const fb = TransactionBuilder.buildFeeBumpTransaction(mediator, "10000", validForwardTx(), NET);
    expect(validateMediatorForwardEnvelope(fb.toXdr(), NET, MED, cex)).toMatchObject({
      ok: false,
      code: "FEE_BUMP_NOT_ALLOWED",
    });
  });

  it("rejects a wrong operation count (WRONG_OPERATION_COUNT)", () => {
    const xdr = builder(MED)
      .addOperation(Operation.accountMerge({ destination: cex }))
      .build()
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
      ok: false,
      code: "WRONG_OPERATION_COUNT",
    });
  });

  it("rejects when the tx source is not the mediator (FORWARD_TX_SOURCE_NOT_MEDIATOR)", () => {
    const xdr = builder(user)
      .addOperation(
        Operation.payment({ source: MED, destination: cex, asset: Asset.native(), amount: "5" }),
      )
      .addOperation(Operation.accountMerge({ source: MED, destination: cex }))
      .build()
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
      ok: false,
      code: "FORWARD_TX_SOURCE_NOT_MEDIATOR",
    });
  });

  it("rejects when forward op0 is not a payment (FORWARD_OP0_NOT_PAYMENT)", () => {
    const xdr = builder(MED)
      .addOperation(Operation.accountMerge({ destination: cex }))
      .addOperation(Operation.accountMerge({ destination: cex }))
      .build()
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
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
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
      ok: false,
      code: "FORWARD_OP0_ASSET_NOT_NATIVE",
    });
  });

  it("rejects when forward op1 is not accountMerge (FORWARD_OP1_NOT_ACCOUNT_MERGE)", () => {
    const xdr = builder(MED)
      .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "5" }))
      .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "1" }))
      .build()
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
      ok: false,
      code: "FORWARD_OP1_NOT_ACCOUNT_MERGE",
    });
  });

  it("rejects splitting payout and merge to different destinations (FORWARD_DESTINATION_MISMATCH)", () => {
    const attacker = Keypair.random().publicKey();
    const xdr = builder(MED)
      .addOperation(
        Operation.payment({ destination: attacker, asset: Asset.native(), amount: "5" }),
      )
      .addOperation(Operation.accountMerge({ destination: cex }))
      .build()
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
      ok: false,
      code: "FORWARD_DESTINATION_MISMATCH",
    });
  });

  it("rejects a forward to a destination other than the token-committed one (FORWARD_DESTINATION_NOT_COMMITTED)", () => {
    const otherDest = Keypair.random().publicKey();
    // a well-formed forward to `cex`, but the flow token was committed to otherDest
    expect(
      validateMediatorForwardEnvelope(validForwardTx().toXdr(), NET, MED, otherDest),
    ).toMatchObject({ ok: false, code: "FORWARD_DESTINATION_NOT_COMMITTED" });
  });

  it("rejects a missing/zero maxTime (MISSING_TIME_BOUNDS)", () => {
    const xdr = new TransactionBuilder(new Account(MED, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "5" }))
      .addOperation(Operation.accountMerge({ destination: cex }))
      .build()
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
      ok: false,
      code: "MISSING_TIME_BOUNDS",
    });
  });

  it("rejects a maxTime beyond the allowed horizon (TIME_BOUNDS_EXCESSIVE)", () => {
    const xdr = builder(MED, MAX_TIME_BOUND_SECONDS + 3600)
      .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "5" }))
      .addOperation(Operation.accountMerge({ destination: cex }))
      .build()
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
      ok: false,
      code: "TIME_BOUNDS_EXCESSIVE",
    });
  });

  it("rejects a payment op sourced by another account (FORWARD_OP0_SOURCE_NOT_MEDIATOR)", () => {
    const xdr = builder(MED)
      .addOperation(
        Operation.payment({ source: user, destination: cex, asset: Asset.native(), amount: "5" }),
      )
      .addOperation(Operation.accountMerge({ destination: cex }))
      .build()
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
      ok: false,
      code: "FORWARD_OP0_SOURCE_NOT_MEDIATOR",
    });
  });

  it("rejects a merge op sourced by another account (FORWARD_OP1_SOURCE_NOT_MEDIATOR)", () => {
    const xdr = builder(MED)
      .addOperation(Operation.payment({ destination: cex, asset: Asset.native(), amount: "5" }))
      .addOperation(Operation.accountMerge({ source: user, destination: cex }))
      .build()
      .toXdr();
    expect(validateMediatorForwardEnvelope(xdr, NET, MED, cex)).toMatchObject({
      ok: false,
      code: "FORWARD_OP1_SOURCE_NOT_MEDIATOR",
    });
  });

  describe("committed deposit memo", () => {
    const committed = encodeMemoCommitment(Memo.id("777"));

    it("accepts the exact committed memo", () => {
      const res = validateMediatorForwardEnvelope(
        forwardWith({ memo: Memo.id("777") }),
        NET,
        MED,
        cex,
        committed,
      );
      expect(res.ok).toBe(true);
    });

    it("rejects a different memo value (FORWARD_MEMO_NOT_COMMITTED)", () => {
      expect(
        validateMediatorForwardEnvelope(
          forwardWith({ memo: Memo.id("666") }),
          NET,
          MED,
          cex,
          committed,
        ),
      ).toMatchObject({ ok: false, code: "FORWARD_MEMO_NOT_COMMITTED" });
    });

    it("rejects the same digits as a text memo", () => {
      expect(
        validateMediatorForwardEnvelope(
          forwardWith({ memo: Memo.text("777") }),
          NET,
          MED,
          cex,
          committed,
        ),
      ).toMatchObject({ ok: false, code: "FORWARD_MEMO_NOT_COMMITTED" });
    });

    it("rejects a forward with no memo when one was committed", () => {
      expect(
        validateMediatorForwardEnvelope(forwardWith({}), NET, MED, cex, committed),
      ).toMatchObject({ ok: false, code: "FORWARD_MEMO_NOT_COMMITTED" });
    });

    it("rejects a forward that adds a memo when none was committed", () => {
      expect(
        validateMediatorForwardEnvelope(
          forwardWith({ memo: Memo.text("attacker") }),
          NET,
          MED,
          cex,
        ),
      ).toMatchObject({ ok: false, code: "FORWARD_MEMO_NOT_COMMITTED" });
    });
  });

  describe("fee and preconditions", () => {
    it("accepts a fee at the per-op ceiling", () => {
      const res = validateMediatorForwardEnvelope(
        forwardWith({ fee: String(MAX_FORWARD_FEE_PER_OP) }),
        NET,
        MED,
        cex,
      );
      expect(res.ok).toBe(true);
    });

    it("rejects a fee above the ceiling (FORWARD_FEE_TOO_HIGH)", () => {
      expect(
        validateMediatorForwardEnvelope(forwardWith({ fee: "2147483647" }), NET, MED, cex),
      ).toMatchObject({ ok: false, code: "FORWARD_FEE_TOO_HIGH" });
      expect(
        validateMediatorForwardEnvelope(
          forwardWith({ fee: String(MAX_FORWARD_FEE_PER_OP + 1) }),
          NET,
          MED,
          cex,
        ),
      ).toMatchObject({ ok: false, code: "FORWARD_FEE_TOO_HIGH" });
    });

    it.each([
      ["ledger bounds", { ledgerbounds: { minLedger: 1, maxLedger: 0 } }],
      ["a minimum account sequence", { minAccountSequence: "3" }],
      ["a minimum sequence age", { minAccountSequenceAge: 5n }],
      ["a minimum sequence ledger gap", { minAccountSequenceLedgerGap: 2 }],
      ["extra signers", { extraSigners: [Keypair.random().publicKey()] }],
    ])("rejects %s (FORWARD_PRECONDITION_NOT_ALLOWED)", (_label, extra) => {
      expect(
        validateMediatorForwardEnvelope(forwardWith(extra as BuilderOptions), NET, MED, cex),
      ).toMatchObject({ ok: false, code: "FORWARD_PRECONDITION_NOT_ALLOWED" });
    });
  });
});
