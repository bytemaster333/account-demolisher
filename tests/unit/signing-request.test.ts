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
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { TESTNET } from "@/lib/config/networks";
import { closeMarkerOperations } from "@/lib/metrics/close-marker";
import type { AccountAudit } from "@/lib/types/account";
import { pathKey } from "@/lib/types/plan";
import {
  assessBundleability,
  buildCloseTransaction,
  inspectClose,
  signedSigners,
  thresholdForClose,
  type CloseDisposal,
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

describe("inspectClose, SEC-04: value-moving ops must be flagged for the co-signer", () => {
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

describe("signedSigners", () => {
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
});

describe("assessBundleability", () => {
  it("allows a plain classic close", () => {
    expect(
      assessBundleability({
        hasSorobanPositions: false,
        hasSelectedAllowances: false,
        useMediator: false,
        hasClassicPoolShares: false,
        hasSelectedHeldTokens: false,
      }).ok,
    ).toBe(true);
  });

  it("refuses the mediator, Soroban positions, and allowances", () => {
    expect(
      assessBundleability({
        hasSorobanPositions: false,
        hasSelectedAllowances: false,
        useMediator: true,
        hasClassicPoolShares: false,
        hasSelectedHeldTokens: false,
      }).ok,
    ).toBe(false);
    expect(
      assessBundleability({
        hasSorobanPositions: true,
        hasSelectedAllowances: false,
        useMediator: false,
        hasClassicPoolShares: false,
        hasSelectedHeldTokens: false,
      }).ok,
    ).toBe(false);
    expect(
      assessBundleability({
        hasSorobanPositions: false,
        hasSelectedAllowances: true,
        useMediator: false,
        hasClassicPoolShares: false,
        hasSelectedHeldTokens: false,
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

  it("describes the removal of every signer kind the close removes (M-17)", () => {
    const preAuth = new Uint8Array(32).fill(7);
    const hashX = new Uint8Array(32).fill(9);
    const payload = StrKey.encodeSignedPayload(
      new xdr.SignerKeyEd25519SignedPayload({
        ed25519: Keypair.random().rawPublicKey(),
        payload: Buffer.alloc(4, 1),
      }).toXdr(),
    );
    const info = inspectClose(
      build([
        Operation.setOptions({ signer: { preAuthTx: preAuth, weight: 0 } }),
        Operation.setOptions({ signer: { sha256Hash: hashX, weight: 0 } }),
        Operation.setOptions({ signer: { ed25519SignedPayload: payload, weight: 0 } }),
        Operation.accountMerge({ destination: dest }),
      ]),
      NET,
    )!;
    const [a, b, c] = info.operations;
    for (const op of [a!, b!, c!]) {
      expect(op.danger).toBeUndefined();
      expect(op.unexpected).toBeUndefined();
    }
    // named the way Horizon lists the account's signers, so a co-signer can
    // match each removal against the signer set
    expect(a!.detail).toBe(
      `Removes pre-authorized transaction signer ${StrKey.encodePreAuthTx(Buffer.from(preAuth))}.`,
    );
    expect(b!.detail).toBe(`Removes hash signer ${StrKey.encodeSha256Hash(Buffer.from(hashX))}.`);
    expect(c!.detail).toBe(`Removes signed-payload signer ${payload}.`);
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

describe("thresholdForClose uses every threshold (L-89)", () => {
  it("returns the highest of low, medium and high, floored at 1", () => {
    expect(thresholdForClose({ low: 1, medium: 3, high: 2 })).toBe(3);
    expect(thresholdForClose({ low: 1, medium: 1, high: 2 })).toBe(2);
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
      hasSelectedHeldTokens: false,
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
        disposal: { claimableBalanceIds: [] },
      }),
    ).toThrow(/liquidity pool/i);

    // open offers are cancelled in the same leading batch as the withdraw
    const withOffer = {
      ...audit,
      offers: [
        {
          id: "42",
          selling: { kind: "native" },
          buying: { kind: "credit", code: "USD", issuer: issuerA },
          amount: "1.0000000",
          priceR: { n: 1, d: 1 },
        },
      ],
    } as unknown as AccountAudit;
    expect(() =>
      buildCloseTransaction({
        audit: withOffer,
        destination: Keypair.random().publicKey(),
        network: TESTNET,
        sourceAccount: account,
        disposal: { claimableBalanceIds: [] },
      }),
    ).toThrow(/liquidity pool/i);
  });
});

describe("buildCloseTransaction carries the reviewed choices (H-11, H-29, L-25)", () => {
  const kp = Keypair.random();
  const usdIssuer = Keypair.random().publicKey();
  const usd = { kind: "credit", code: "USD", issuer: usdIssuer } as const;

  function cb(id: string, asset: unknown, amount = "5.0000000") {
    return {
      id,
      asset,
      amount,
      sponsor: Keypair.random().publicKey(),
      claimantsRaw: { unconditional: true },
      claimants: [kp.publicKey()],
      claimableNow: true,
    };
  }

  function audit(
    extra: { balances?: unknown[]; claimableBalances?: unknown[]; data?: unknown[] } = {},
  ) {
    return {
      accountId: kp.publicKey(),
      sequence: "1",
      subentryCount: 0,
      thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
      flags: {
        authImmutable: false,
        authRequired: false,
        authRevocable: false,
        authClawbackEnabled: false,
      },
      balances: [
        {
          asset: { kind: "native" },
          amount: "100.0000000",
          buyingLiabilities: "0",
          sellingLiabilities: "0",
        },
        ...(extra.balances ?? []),
      ],
      signers: [{ key: kp.publicKey(), type: "ed25519_public_key", weight: 1 }],
      offers: [],
      data: extra.data ?? [],
      claimableBalances: extra.claimableBalances ?? [],
      poolShares: [],
      sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
      requiresMultisig: true,
      mergeability: { mergeable: true },
    } as unknown as AccountAudit;
  }

  function source(): Horizon.AccountResponse {
    return new Horizon.AccountResponse({
      id: kp.publicKey(),
      account_id: kp.publicKey(),
      sequence: "1",
      balances: [],
      signers: [],
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
  }

  const claimedIds = (t: { operations: readonly { type: string }[] }) =>
    t.operations
      .filter((o) => o.type === "claimClaimableBalance")
      .map((o) => (o as unknown as { balanceId: string }).balanceId);

  const ID1 = `00000000${"1".repeat(64)}`;
  const ID2 = `00000000${"2".repeat(64)}`;

  it("puts the reviewed memo on the bundle", () => {
    const tx = buildCloseTransaction({
      audit: audit(),
      destination: Keypair.random().publicKey(),
      network: TESTNET,
      sourceAccount: source(),
      disposal: { claimableBalanceIds: [], memo: { type: "id", value: "777" } },
    });
    expect(tx.memo.type).toBe("id");
    expect(String(tx.memo.value)).toBe("777");
  });

  it("claims only the reviewed claimable balances, and none for an empty list", () => {
    const a = audit({
      claimableBalances: [cb(ID1, { kind: "native" }), cb(ID2, { kind: "native" })],
    });
    const base = {
      audit: a,
      destination: Keypair.random().publicKey(),
      network: TESTNET,
    };
    expect(
      claimedIds(
        buildCloseTransaction({
          ...base,
          sourceAccount: source(),
          disposal: { claimableBalanceIds: [ID1, ID2] },
        }),
      ),
    ).toEqual([ID1, ID2]);
    expect(
      claimedIds(
        buildCloseTransaction({
          ...base,
          sourceAccount: source(),
          disposal: { claimableBalanceIds: [ID2] },
        }),
      ),
    ).toEqual([ID2]);
    expect(
      claimedIds(
        buildCloseTransaction({
          ...base,
          sourceAccount: source(),
          disposal: { claimableBalanceIds: [] },
        }),
      ),
    ).toEqual([]);
  });

  it("refuses to build without a reviewed claimable balance selection", () => {
    // a missing selection used to mean "claim every balance claimable now",
    // which claims balances nobody reviewed (H-11)
    const a = audit({ claimableBalances: [cb(ID1, { kind: "native" })] });
    const build = (disposal: unknown) => () =>
      buildCloseTransaction({
        audit: a,
        destination: Keypair.random().publicKey(),
        network: TESTNET,
        sourceAccount: source(),
        disposal: disposal as CloseDisposal,
      });
    expect(build(undefined)).toThrow(/claimable balance selection/);
    expect(build({ memo: { type: "id", value: "1" } })).toThrow(/claimable balance selection/);
  });

  it("anchors the expiry to the ledger close time when given", () => {
    const ledgerCloseTime = 2_000_000_000;
    const tx = buildCloseTransaction({
      audit: audit(),
      destination: Keypair.random().publicKey(),
      network: TESTNET,
      sourceAccount: source(),
      disposal: { claimableBalanceIds: [] },
      timeoutSeconds: 3600,
      ledgerCloseTime,
    });
    expect(Number(tx.timeBounds?.maxTime)).toBe(ledgerCloseTime + 3600);
  });

  it("names an undisposed claimed asset when that splits the close", () => {
    const a = audit({
      balances: [
        {
          asset: usd,
          amount: "0.0000000",
          limit: "1000.0000000",
          buyingLiabilities: "0",
          sellingLiabilities: "0",
          isAuthorized: true,
        },
      ],
      claimableBalances: [cb(ID1, usd)],
    });
    expect(() =>
      buildCloseTransaction({
        audit: a,
        destination: Keypair.random().publicKey(),
        network: TESTNET,
        sourceAccount: source(),
        disposal: { claimableBalanceIds: [ID1] },
      }),
    ).toThrow(/claimable balance/i);
  });

  // 110 data entries push the close past 100 operations; packing then moves
  // claims that need no isolation into an earlier batch, which must not be
  // blamed on a claimable balance
  const manyEntries = Array.from({ length: 110 }, (_, i) => ({
    name: `entry-${i}`,
    value: "MQ==",
  }));
  const usdLine = {
    asset: usd,
    amount: "0.0000000",
    limit: "1000.0000000",
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    isAuthorized: true,
  };

  it("reports the operation count for an oversized close with a native claim", () => {
    const a = audit({ data: manyEntries, claimableBalances: [cb(ID1, { kind: "native" })] });
    let message = "";
    try {
      buildCloseTransaction({
        audit: a,
        destination: Keypair.random().publicKey(),
        network: TESTNET,
        sourceAccount: source(),
        disposal: { claimableBalanceIds: [ID1] },
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/needs \d+ operations/);
    expect(message).not.toMatch(/claimable balance/i);
  });

  it("checks room for the close marker at the bundle's own fee bid", () => {
    // 1.6 XLM leaves 0.6 above the bare account's reserve: enough for the marker
    // at 100 stroops per op, not at the executor's 0.1 XLM ceiling
    const a = audit();
    const lean = {
      ...a,
      balances: [{ ...a.balances[0]!, amount: "1.6000000" }],
    } as AccountAudit;
    const tx = buildCloseTransaction({
      audit: lean,
      destination: Keypair.random().publicKey(),
      network: TESTNET,
      sourceAccount: source(),
      disposal: { claimableBalanceIds: [] },
    });
    const marker = tx.operations.filter(
      (o) => o.type === "manageData" && o.name === "account-demolisher.close",
    );
    expect(marker).toHaveLength(2);
    expect(Number(tx.fee)).toBe(Number(BASE_FEE) * tx.operations.length);
  });

  it("names the missing trustline when a reviewed claim needs one opened first", () => {
    // the account doesn't trust USD; the issuer needs no authorization, so the
    // batcher opens the line in a leading transaction before the claim
    const a = audit({ claimableBalances: [{ ...cb(ID1, usd), issuerAuthRequired: false }] });
    let message = "";
    try {
      buildCloseTransaction({
        audit: a,
        destination: Keypair.random().publicKey(),
        network: TESTNET,
        sourceAccount: source(),
        disposal: { claimableBalanceIds: [ID1], returnToIssuerAssetKeys: [pathKey(usd)] },
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/doesn't trust/);
    expect(message).toMatch(/USD/);
    expect(message).not.toMatch(/needs \d+ operations/);
  });

  it("reports the operation count when the claimed credit asset has a disposal", () => {
    const a = audit({
      data: manyEntries,
      balances: [usdLine],
      claimableBalances: [cb(ID1, usd)],
    });
    expect(() =>
      buildCloseTransaction({
        audit: a,
        destination: Keypair.random().publicKey(),
        network: TESTNET,
        sourceAccount: source(),
        disposal: { claimableBalanceIds: [ID1], returnToIssuerAssetKeys: [pathKey(usd)] },
      }),
    ).toThrow(/needs \d+ operations/);
  });
});

describe("assessBundleability refuses selected held tokens (H-04)", () => {
  it("refuses when standalone tokens are selected to move", () => {
    const res = assessBundleability({
      hasSorobanPositions: false,
      hasSelectedAllowances: false,
      useMediator: false,
      hasClassicPoolShares: false,
      hasSelectedHeldTokens: true,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/standalone tokens/i);
  });
});

describe("inspectClose flags operations on another account", () => {
  it("marks a payment sourced from a different account as unexpected", () => {
    const closing = Keypair.random().publicKey();
    const other = Keypair.random().publicKey();
    const issuer = Keypair.random().publicKey();
    const usd = new Asset("USD", issuer);
    const dest = Keypair.random().publicKey();
    const tx = new TransactionBuilder(new Account(closing, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NET,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(
        Operation.payment({ destination: issuer, asset: usd, amount: "5", source: other }),
      )
      .addOperation(
        Operation.payment({ destination: dest, asset: usd, amount: "5", source: other }),
      )
      .addOperation(Operation.accountMerge({ destination: dest }))
      .build();
    const info = inspectClose(tx.toXdr(), NET)!;
    for (const op of info.operations.slice(0, 2)) {
      expect(op.danger).toBe(true);
      expect(op.unexpected).toBe(true);
      expect(op.detail).toContain(other);
    }
    expect(info.operations[2]!.unexpected).toBeFalsy();
  });
});
