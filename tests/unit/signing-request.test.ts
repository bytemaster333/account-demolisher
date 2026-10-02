import {
  Account,
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { TESTNET } from "@/lib/config/networks";
import { closeMarkerOperations } from "@/lib/metrics/close-marker";
import type { AccountAudit, AuditSigner } from "@/lib/types/account";
import {
  assessBundleability,
  buildCloseTransaction,
  closeThreshold,
  collectedWeight,
  inspectClose,
  requiredSigners,
  signedSigners,
  thresholdForClose,
} from "@/lib/multisig/signing-request";

const NET = Networks.TESTNET;

// a single-op account-close transaction (accountMerge), the shape a signing
// request always wraps.
function buildClose(sourcePk: string, destination: string, seq = "1") {
  return new TransactionBuilder(new Account(sourcePk, seq), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.accountMerge({ destination }))
    .build();
}

function signedXdr(sourcePk: string, destination: string, ...kps: Keypair[]): string {
  const tx = TransactionBuilder.fromXdr(buildClose(sourcePk, destination).toXdr(), NET);
  for (const kp of kps) tx.sign(kp);
  return tx.toXdr();
}

function auditWith(signers: AuditSigner[], high: number): AccountAudit {
  return {
    accountId: signers[0]?.key ?? "G",
    signers,
    thresholds: { low: 0, medium: 0, high, masterWeight: signers[0]?.weight ?? 0 },
  } as unknown as AccountAudit;
}

describe("inspectClose", () => {
  it("decodes an account-close and flags it as a close", () => {
    const source = Keypair.random().publicKey();
    const dest = Keypair.random().publicKey();
    const info = inspectClose(buildClose(source, dest).toXdr(), NET);
    expect(info).not.toBeNull();
    expect(info?.isClose).toBe(true);
    expect(info?.source).toBe(source);
    expect(info?.mergeDestination).toBe(dest);
    expect(info?.operations[0]?.type).toBe("Close this account");
  });

  it("reports a non-close transaction as isClose=false", () => {
    const source = Keypair.random().publicKey();
    const tx = new TransactionBuilder(new Account(source, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(Operation.payment({ destination: source, asset: Asset.native(), amount: "1" }))
      .build();
    const info = inspectClose(tx.toXdr(), NET);
    expect(info?.isClose).toBe(false);
  });

  it("returns null for undecodable input", () => {
    expect(inspectClose("garbage", NET)).toBeNull();
  });
});

describe("inspectClose — SEC-04: value-moving ops must be flagged for the co-signer", () => {
  const source = Keypair.random().publicKey();
  const attacker = Keypair.random().publicKey();
  const dest = Keypair.random().publicKey();

  function bundle(...ops: xdr.Operation[]): string {
    const b = new TransactionBuilder(new Account(source, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: 0, maxTime: 0 },
    });
    for (const op of ops) b.addOperation(op);
    return b.build().toXdr();
  }

  it("flags a pathPaymentStrictSend to an attacker as danger, with its destination", () => {
    const op0 = inspectClose(
      bundle(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: "100",
          destination: attacker,
          destAsset: Asset.native(),
          destMin: "1",
        }),
        Operation.accountMerge({ destination: dest }),
      ),
      NET,
    )!.operations[0]!;
    expect(op0.danger).toBe(true);
    expect(op0.destination).toBe(attacker);
  });

  it("flags a createAccount to an attacker as danger, with its destination", () => {
    const op0 = inspectClose(
      bundle(
        Operation.createAccount({ destination: attacker, startingBalance: "500" }),
        Operation.accountMerge({ destination: dest }),
      ),
      NET,
    )!.operations[0]!;
    expect(op0.danger).toBe(true);
    expect(op0.destination).toBe(attacker);
  });

  it("flags createClaimableBalance as danger", () => {
    const op0 = inspectClose(
      bundle(
        Operation.createClaimableBalance({
          asset: Asset.native(),
          amount: "100",
          claimants: [new Claimant(attacker, Claimant.predicateUnconditional())],
        }),
        Operation.accountMerge({ destination: dest }),
      ),
      NET,
    )!.operations[0]!;
    expect(op0.danger).toBe(true);
  });

  it("does NOT flag an offer cancellation (amount 0) as danger", () => {
    const op0 = inspectClose(
      bundle(
        Operation.manageSellOffer({
          selling: Asset.native(),
          buying: new Asset("USD", attacker),
          amount: "0",
          price: "1",
          offerId: "123",
        }),
        Operation.accountMerge({ destination: dest }),
      ),
      NET,
    )!.operations[0]!;
    expect(op0.danger).toBeFalsy();
    expect(op0.type).toBe("Cancel a DEX offer");
  });

  it("flags a non-zero DEX offer as danger", () => {
    const op0 = inspectClose(
      bundle(
        Operation.manageSellOffer({
          selling: Asset.native(),
          buying: new Asset("USD", attacker),
          amount: "1000",
          price: "1",
        }),
        Operation.accountMerge({ destination: dest }),
      ),
      NET,
    )!.operations[0]!;
    expect(op0.danger).toBe(true);
  });
});

describe("signedSigners / collectedWeight", () => {
  it("reports only the keys that actually signed, verified over the tx hash", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const c = Keypair.random();
    const dest = Keypair.random().publicKey();
    const xdr = signedXdr(a.publicKey(), dest, a); // only a signs

    const signers = [a.publicKey(), b.publicKey(), c.publicKey()];
    expect(signedSigners(xdr, NET, signers)).toEqual([a.publicKey()]);

    const bothXdr = signedXdr(a.publicKey(), dest, a, b);
    const signed = signedSigners(bothXdr, NET, signers);
    expect(new Set(signed)).toEqual(new Set([a.publicKey(), b.publicKey()]));
  });

  it("sums the collected weight from the audit", () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const audit = auditWith(
      [
        { key: a.publicKey(), type: "ed25519_public_key", weight: 1 },
        { key: b.publicKey(), type: "ed25519_public_key", weight: 2 },
      ],
      2,
    );
    expect(collectedWeight([a.publicKey()], audit)).toBe(1);
    expect(collectedWeight([a.publicKey(), b.publicKey()], audit)).toBe(3);
  });
});

describe("requiredSigners / closeThreshold", () => {
  it("keeps only ed25519 signers with weight, and reads the high threshold", () => {
    const a = Keypair.random().publicKey();
    const audit = auditWith(
      [
        { key: a, type: "ed25519_public_key", weight: 1 },
        { key: "Xhash", type: "sha256_hash", weight: 5 },
        { key: "Gzero", type: "ed25519_public_key", weight: 0 },
      ],
      2,
    );
    expect(requiredSigners(audit)).toEqual([{ key: a, weight: 1 }]);
    expect(closeThreshold(audit)).toBe(2);
  });

  it("floors the threshold at 1 even when high is 0", () => {
    const a = Keypair.random().publicKey();
    const audit = auditWith([{ key: a, type: "ed25519_public_key", weight: 1 }], 0);
    expect(closeThreshold(audit)).toBe(1);
  });
});

describe("assessBundleability", () => {
  it("allows a plain classic close", () => {
    expect(
      assessBundleability({
        hasSorobanPositions: false,
        hasSelectedAllowances: false,
        useMediator: false,
      }).ok,
    ).toBe(true);
  });

  it("refuses the mediator, Soroban positions, and allowances", () => {
    expect(
      assessBundleability({
        hasSorobanPositions: false,
        hasSelectedAllowances: false,
        useMediator: true,
      }).ok,
    ).toBe(false);
    expect(
      assessBundleability({
        hasSorobanPositions: true,
        hasSelectedAllowances: false,
        useMediator: false,
      }).ok,
    ).toBe(false);
    expect(
      assessBundleability({
        hasSorobanPositions: false,
        hasSelectedAllowances: true,
        useMediator: false,
      }).ok,
    ).toBe(false);
  });
});

describe("inspectClose: offers are never mislabeled (H-33)", () => {
  const source = Keypair.random().publicKey();
  const attacker = Keypair.random().publicKey();
  const dest = Keypair.random().publicKey();
  const scam = new Asset("SCAM", attacker);

  function bundle(...ops: xdr.Operation[]): string {
    const b = new TransactionBuilder(new Account(source, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: 0, maxTime: 0 },
    });
    for (const op of ops) b.addOperation(op);
    b.addOperation(Operation.accountMerge({ destination: dest }));
    return b.build().toXdr();
  }

  function firstOp(...ops: xdr.Operation[]) {
    return inspectClose(bundle(...ops), NET)!.operations[0]!;
  }

  it("flags a manageBuyOffer as danger with its amount, assets and price", () => {
    const op = firstOp(
      Operation.manageBuyOffer({
        selling: Asset.native(),
        buying: scam,
        buyAmount: "1000000",
        price: "0.5",
      }),
    );
    expect(op.danger).toBe(true);
    expect(op.unexpected).toBe(true);
    expect(op.type).not.toBe("Cancel a DEX offer");
    expect(op.detail).toContain("1000000");
    expect(op.detail).toContain("XLM");
    expect(op.detail).toContain("SCAM");
    expect(op.detail).toContain(attacker);
    expect(op.detail).toContain("0.5");
  });

  it("never labels a createPassiveSellOffer as a cancel", () => {
    const op = firstOp(
      Operation.createPassiveSellOffer({
        selling: Asset.native(),
        buying: scam,
        amount: "0.0000001",
        price: "1",
      }),
    );
    expect(op.type).not.toBe("Cancel a DEX offer");
    expect(op.danger).toBe(true);
    expect(op.unexpected).toBe(true);
  });

  it("does not label a manageSellOffer with amount 0 and offerId 0 as a cancel", () => {
    const op = firstOp(
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: scam,
        amount: "0",
        price: "1",
        offerId: "0",
      }),
    );
    expect(op.type).not.toBe("Cancel a DEX offer");
    expect(op.danger).toBe(true);
  });

  it("shows assets, amount and price for a non-zero manageSellOffer", () => {
    const op = firstOp(
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: scam,
        amount: "250",
        price: "3",
      }),
    );
    expect(op.danger).toBe(true);
    expect(op.unexpected).toBe(true);
    expect(op.detail).toContain("250");
    expect(op.detail).toContain("SCAM");
    expect(op.detail).toContain(attacker);
  });

  it("keeps a real offer cancel (amount 0, offerId set) as an expected step", () => {
    const op = firstOp(
      Operation.manageSellOffer({
        selling: scam,
        buying: Asset.native(),
        amount: "0",
        price: "1",
        offerId: "42",
      }),
    );
    expect(op.type).toBe("Cancel a DEX offer");
    expect(op.danger).toBeFalsy();
    expect(op.detail).toContain("42");
  });
});

describe("inspectClose: full transaction facts and op details (L-91)", () => {
  const source = Keypair.random().publicKey();
  const dest = Keypair.random().publicKey();
  const issuer = Keypair.random().publicKey();
  const other = Keypair.random().publicKey();
  const usd = new Asset("USD", issuer);

  function build(
    ops: xdr.Operation[],
    opts: { fee?: string; memoText?: string; maxTime?: number; minTime?: number } = {},
  ): string {
    const b = new TransactionBuilder(new Account(source, "41"), {
      fee: opts.fee ?? BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: opts.minTime ?? 0, maxTime: opts.maxTime ?? 0 },
    });
    for (const op of ops) b.addOperation(op);
    if (opts.memoText !== undefined) b.addMemo(Memo.text(opts.memoText));
    return b.build().toXdr();
  }

  it("reports fee, memo, sequence and time bounds", () => {
    const info = inspectClose(
      build([Operation.accountMerge({ destination: dest })], {
        fee: "4000000000",
        memoText: "exchange-42",
        minTime: 1_700_000_000,
        maxTime: 1_700_007_200,
      }),
      NET,
    )!;
    expect(info.feeStroops).toBe("4000000000");
    expect(info.feeXlm).toBe("400.0000000");
    expect(info.memo).toEqual({ type: "text", value: "exchange-42" });
    expect(info.sequence).toBe("42");
    expect(info.timeBounds).toEqual({ minTime: 1_700_000_000, maxTime: 1_700_007_200 });
    expect(info.preconditions).toBeNull();
  });

  it("reports V2 preconditions", () => {
    const b = new TransactionBuilder(new Account(source, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: 0, maxTime: 0 },
      ledgerbounds: { minLedger: 5, maxLedger: 100 },
      minAccountSequenceAge: 60n,
    }).addOperation(Operation.accountMerge({ destination: dest }));
    const info = inspectClose(b.build().toXdr(), NET)!;
    expect(info.preconditions).not.toBeNull();
    expect(info.preconditions?.ledgerBounds).toEqual({ minLedger: 5, maxLedger: 100 });
    expect(info.preconditions?.minAccountSequenceAge).toBe("60");
  });

  it("flags a preAuthTx signer addition as danger", () => {
    const info = inspectClose(
      build([
        Operation.setOptions({ signer: { preAuthTx: new Uint8Array(32).fill(7), weight: 1 } }),
        Operation.accountMerge({ destination: dest }),
      ]),
      NET,
    )!;
    const op = info.operations[0]!;
    expect(op.danger).toBe(true);
    expect(op.detail).toMatch(/pre-authorized transaction/i);
  });

  it("flags flag, home domain and inflation changes as danger", () => {
    const info = inspectClose(
      build([
        Operation.setOptions({ setFlags: 1, homeDomain: "evil.example", inflationDest: other }),
        Operation.accountMerge({ destination: dest }),
      ]),
      NET,
    )!;
    const op = info.operations[0]!;
    expect(op.danger).toBe(true);
    expect(op.detail).toContain("evil.example");
    expect(op.detail).toContain(other);
  });

  it("keeps the close's own signer removal and threshold reset as expected steps", () => {
    const info = inspectClose(
      build([
        Operation.setOptions({ signer: { ed25519PublicKey: other, weight: 0 } }),
        Operation.setOptions({
          masterWeight: 1,
          lowThreshold: 0,
          medThreshold: 0,
          highThreshold: 0,
        }),
        Operation.accountMerge({ destination: dest }),
      ]),
      NET,
    )!;
    expect(info.operations[0]!.danger).toBeFalsy();
    expect(info.operations[1]!.danger).toBeFalsy();
  });

  it("shows sendMax and destAmount for a strict-receive path payment", () => {
    const op = inspectClose(
      build([
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: "777",
          destination: other,
          destAsset: usd,
          destAmount: "12",
          path: [],
        }),
        Operation.accountMerge({ destination: dest }),
      ]),
      NET,
    )!.operations[0]!;
    expect(op.danger).toBe(true);
    expect(op.detail).toContain("777");
    expect(op.detail).toContain("12");
    expect(op.detail).toContain("USD");
    expect(op.destination).toBe(other);
  });

  it("shows sendAmount and destMin for a strict-send path payment", () => {
    const op = inspectClose(
      build([
        Operation.pathPaymentStrictSend({
          sendAsset: usd,
          sendAmount: "33",
          destination: other,
          destAsset: Asset.native(),
          destMin: "9",
          path: [],
        }),
        Operation.accountMerge({ destination: dest }),
      ]),
      NET,
    )!.operations[0]!;
    expect(op.detail).toContain("33");
    expect(op.detail).toContain("9");
  });

  it("lists the claimants of a createClaimableBalance", () => {
    const op = inspectClose(
      build([
        Operation.createClaimableBalance({
          asset: Asset.native(),
          amount: "100",
          claimants: [new Claimant(other, Claimant.predicateUnconditional())],
        }),
        Operation.accountMerge({ destination: dest }),
      ]),
      NET,
    )!.operations[0]!;
    expect(op.danger).toBe(true);
    expect(op.detail).toContain(other);
    expect(op.detail).toContain("100");
  });

  it("does not flag a return-to-issuer payment, but flags a payment elsewhere", () => {
    const info = inspectClose(
      build([
        Operation.payment({ destination: issuer, asset: usd, amount: "5" }),
        Operation.payment({ destination: other, asset: usd, amount: "5" }),
        Operation.changeTrust({ asset: usd, limit: "0" }),
        Operation.accountMerge({ destination: dest }),
      ]),
      NET,
    )!;
    expect(info.operations[0]!.danger).toBeFalsy();
    expect(info.operations[1]!.danger).toBe(true);
    expect(info.operations[2]!.danger).toBeFalsy();
  });

  it("flags a trustline being added (non-zero limit) as danger", () => {
    const op = inspectClose(
      build([Operation.changeTrust({ asset: usd }), Operation.accountMerge({ destination: dest })]),
      NET,
    )!.operations[0]!;
    expect(op.danger).toBe(true);
    expect(op.unexpected).toBe(true);
  });

  it("labels the close marker pair as an expected step", () => {
    const [set, del] = closeMarkerOperations();
    const info = inspectClose(
      build([set, del, Operation.accountMerge({ destination: dest })]),
      NET,
    )!;
    expect(info.operations[0]!.danger).toBeFalsy();
    expect(info.operations[1]!.danger).toBeFalsy();
  });

  it("flags any other data entry being written", () => {
    const op = inspectClose(
      build([
        Operation.manageData({ name: "x", value: "y" }),
        Operation.accountMerge({ destination: dest }),
      ]),
      NET,
    )!.operations[0]!;
    expect(op.danger).toBe(true);
  });
});

describe("closeThreshold uses every threshold (L-89)", () => {
  it("returns the highest of low, medium and high", () => {
    const a = Keypair.random().publicKey();
    const audit = {
      accountId: a,
      signers: [{ key: a, type: "ed25519_public_key", weight: 1 }],
      thresholds: { low: 1, medium: 3, high: 2, masterWeight: 1 },
    } as unknown as AccountAudit;
    expect(closeThreshold(audit)).toBe(3);
    expect(thresholdForClose({ low: 4, medium: 1, high: 2 })).toBe(4);
    expect(thresholdForClose({ low: 0, medium: 0, high: 0 })).toBe(1);
  });
});

describe("liquidity pool shares cannot be bundled (L-94)", () => {
  it("assessBundleability refuses an account with a classic pool share", () => {
    const res = assessBundleability({
      hasSorobanPositions: false,
      hasSelectedAllowances: false,
      useMediator: false,
      hasClassicPoolShares: true,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/liquidity pool share/i);
  });

  it("buildCloseTransaction names the liquidity pool when it splits the close", () => {
    const kp = Keypair.random();
    const issuerA = Keypair.random().publicKey();
    const poolId = "a".repeat(64);
    const audit = {
      accountId: kp.publicKey(),
      sequence: "1",
      subentryCount: 1,
      thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
      flags: {
        authImmutable: false,
        authRequired: false,
        authRevocable: false,
        authClawbackEnabled: false,
      },
      balances: [
        {
          asset: { kind: "liquidity_pool_shares", poolId },
          amount: "10.0000000",
          buyingLiabilities: "0",
          sellingLiabilities: "0",
        },
      ],
      signers: [{ key: kp.publicKey(), type: "ed25519_public_key", weight: 1 }],
      offers: [],
      data: [],
      claimableBalances: [],
      poolShares: [
        {
          poolId,
          poolType: "constant_product",
          shareBalance: "10.0000000",
          totalShares: "100.0000000",
          shareLimit: "1000",
          fee: 30,
          reserves: [
            { asset: { kind: "native" }, amount: "100.0000000" },
            { asset: { kind: "credit", code: "USD", issuer: issuerA }, amount: "100.0000000" },
          ],
        },
      ],
      sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
      requiresMultisig: true,
      mergeability: { mergeable: true },
    } as unknown as AccountAudit;
    const account = new Horizon.AccountResponse({
      id: kp.publicKey(),
      account_id: kp.publicKey(),
      sequence: "1",
      balances: [],
      signers: [],
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
    expect(() =>
      buildCloseTransaction({
        audit,
        destination: Keypair.random().publicKey(),
        network: TESTNET,
        sourceAccount: account,
      }),
    ).toThrow(/liquidity pool/i);
  });
});
