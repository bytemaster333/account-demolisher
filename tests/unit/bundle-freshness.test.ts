// the freshness check against a bundle built by the real close builder and a
// real Horizon.AccountResponse; only the account state fed in is varied.

import {
  Account,
  BASE_FEE,
  Horizon,
  Keypair,
  NotFoundError,
  Operation,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { TESTNET } from "@/lib/config/networks";
import { CLOSE_MARKER_NAME, closeMarkerOperations } from "@/lib/metrics/close-marker";
import {
  checkBundleFreshness,
  feeBumpBundle,
  loadBundleFreshness,
} from "@/lib/multisig/bundle-freshness";
import { buildCloseTransaction } from "@/lib/multisig/signing-request";
import type { AccountAudit } from "@/lib/types/account";

const owner = Keypair.random();
const cosigner = Keypair.random();
const issuer = Keypair.random().publicKey();
const dest = Keypair.random().publicKey();
const OFFER_ID = "777";

const audit = {
  accountId: owner.publicKey(),
  sequence: "5000",
  subentryCount: 4,
  thresholds: { low: 1, medium: 2, high: 2, masterWeight: 1 },
  flags: {
    authImmutable: false,
    authRequired: false,
    authRevocable: false,
    authClawbackEnabled: false,
  },
  balances: [
    {
      asset: { kind: "credit", code: "USD", issuer },
      amount: "5.0000000",
      buyingLiabilities: "0",
      sellingLiabilities: "0",
    },
  ],
  signers: [
    { key: owner.publicKey(), type: "ed25519_public_key", weight: 1 },
    { key: cosigner.publicKey(), type: "ed25519_public_key", weight: 1 },
  ],
  offers: [
    {
      id: OFFER_ID,
      selling: { kind: "credit", code: "USD", issuer },
      buying: { kind: "native" },
      amount: "1.0000000",
      priceR: { n: 1, d: 2 },
    },
  ],
  data: [{ name: "note", value: "aGk=" }],
  claimableBalances: [],
  poolShares: [],
  sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
  requiresMultisig: true,
  mergeability: { mergeable: true },
} as unknown as AccountAudit;

interface LiveState {
  sequence?: string;
  usd?: string | null;
  extraLine?: boolean;
  signers?: { key: string; weight: number }[];
  thresholds?: { low: number; med: number; high: number };
  data?: Record<string, string>;
}

function live(state: LiveState = {}): Horizon.AccountResponse {
  const balances: Record<string, unknown>[] = [{ asset_type: "native", balance: "100.0000000" }];
  if (state.usd !== null) {
    balances.push({
      asset_type: "credit_alphanum4",
      asset_code: "USD",
      asset_issuer: issuer,
      balance: state.usd ?? "5.0000000",
    });
  }
  if (state.extraLine) {
    balances.push({
      asset_type: "credit_alphanum4",
      asset_code: "EUR",
      asset_issuer: issuer,
      balance: "0.0000000",
    });
  }
  const signers = state.signers ?? [
    { key: owner.publicKey(), weight: 1 },
    { key: cosigner.publicKey(), weight: 1 },
  ];
  const t = state.thresholds ?? { low: 1, med: 2, high: 2 };
  return new Horizon.AccountResponse({
    id: owner.publicKey(),
    account_id: owner.publicKey(),
    sequence: state.sequence ?? "5000",
    balances,
    signers: signers.map((s) => ({ ...s, type: "ed25519_public_key" })),
    thresholds: { low_threshold: t.low, med_threshold: t.med, high_threshold: t.high },
    // Horizon's `data` link shadows the entries, so the sdk exposes them as data_attr
    data_attr: state.data ?? { note: "aGk=" },
  } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
}

const bundle: Transaction = buildCloseTransaction({
  audit,
  destination: dest,
  network: TESTNET,
  sourceAccount: live(),
  disposal: { claimableBalanceIds: [], returnToIssuerAssetKeys: [`USD:${issuer}`] },
});
const XDR = bundle.toXdr();
const snapshot = {
  signers: [
    { key: owner.publicKey(), weight: 1 },
    { key: cosigner.publicKey(), weight: 1 },
  ],
  thresholds: { low: 1, med: 2, high: 2 },
};

function check(state: LiveState, offerIds: string[] = [OFFER_ID]) {
  return checkBundleFreshness({
    xdr: XDR,
    passphrase: TESTNET.passphrase,
    account: live(state),
    offerIds,
    claimableBalances: [],
    snapshot,
  });
}

describe("checkBundleFreshness", () => {
  it("accepts an unchanged account", () => {
    expect(check({})).toEqual({ ok: true });
  });

  it("detects a sequence bump", () => {
    const res = check({ sequence: "5001" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toMatch(/sequence number moved/);
  });

  it("detects a dust credit to a trustline the bundle removes", () => {
    const res = check({ usd: "5.0000001" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toMatch(/USD .* is now 5\.0000001/);
  });

  it("detects a new trustline the bundle doesn't remove", () => {
    const res = check({ extraLine: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toMatch(/EUR/);
  });

  it("detects a filled offer and a new offer", () => {
    const filled = check({}, []);
    expect(filled.ok).toBe(false);
    if (!filled.ok) expect(filled.reasons.join(" ")).toMatch(/Offer 777 is no longer open/);
    const extra = check({}, [OFFER_ID, "888"]);
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.reasons.join(" ")).toMatch(/Offer 888 is open/);
  });

  it("detects a removed data entry", () => {
    const res = check({ data: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toMatch(/"note" no longer exists/);
  });

  it("detects a rotated signer and changed thresholds (L-90)", () => {
    const rotated = check({
      signers: [
        { key: owner.publicKey(), weight: 1 },
        { key: Keypair.random().publicKey(), weight: 1 },
      ],
    });
    expect(rotated.ok).toBe(false);
    if (!rotated.ok) expect(rotated.reasons.join(" ")).toMatch(/signers or their weights changed/);
    const raised = check({ thresholds: { low: 1, med: 3, high: 2 } });
    expect(raised.ok).toBe(false);
    if (!raised.ok) expect(raised.reasons.join(" ")).toMatch(/thresholds changed/);
  });
});

describe("feeBumpBundle", () => {
  it("wraps a signed bundle without invalidating its signatures", () => {
    const signed = TransactionBuilder.fromXdr(XDR, TESTNET.passphrase) as Transaction;
    signed.sign(owner);
    signed.sign(cosigner);
    const payer = Keypair.random();
    const bump = feeBumpBundle(signed.toXdr(), TESTNET.passphrase, payer.publicKey(), "1000");
    const inner = bump.innerTransaction;
    expect(inner.signatures).toHaveLength(2);
    expect(owner.verify(inner.hash(), inner.signatures[0]!.signature.toBytes())).toBe(true);
    expect(bump.feeSource).toBe(payer.publicKey());
  });
});

describe("bundle freshness edge cases", () => {
  function markerBundle(extra: xdr.Operation[] = []): string {
    const tx = new TransactionBuilder(new Account(owner.publicKey(), "5000"), {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
      timebounds: { minTime: 0, maxTime: 0 },
    });
    for (const op of extra) tx.addOperation(op);
    for (const op of closeMarkerOperations()) tx.addOperation(op);
    tx.addOperation(Operation.accountMerge({ destination: dest }));
    return tx.build().toXdr();
  }

  function bare(data: Record<string, string>): Horizon.AccountResponse {
    return new Horizon.AccountResponse({
      id: owner.publicKey(),
      account_id: owner.publicKey(),
      sequence: "5000",
      balances: [{ asset_type: "native", balance: "100.0000000" }],
      signers: [{ key: owner.publicKey(), weight: 1, type: "ed25519_public_key" }],
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      data_attr: data,
    } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
  }

  it("accepts an existing close marker entry, which the marker pair removes", () => {
    const res = checkBundleFreshness({
      xdr: markerBundle(),
      passphrase: TESTNET.passphrase,
      account: bare({ [CLOSE_MARKER_NAME]: "MQ==" }),
      offerIds: [],
      claimableBalances: [],
    });
    expect(res).toEqual({ ok: true });
  });

  it("treats a claimable balance Horizon answers 404 for as gone", async () => {
    const id = `00000000${"3".repeat(64)}`;
    const xdrStr = markerBundle([Operation.claimClaimableBalance({ balanceId: id })]);
    const horizon = {
      loadAccount: () => Promise.resolve(bare({})),
      offers: () => ({
        forAccount: () => ({
          limit: () => ({ call: () => Promise.resolve({ records: [] }) }),
        }),
      }),
      claimableBalances: () => ({
        claimableBalance: () => ({
          // a 404 from a proxy in front of Horizon carries no problem body
          call: () => Promise.reject(new NotFoundError("Not Found", "<html>not found</html>")),
        }),
      }),
    } as unknown as Horizon.Server;
    const res = await loadBundleFreshness(horizon, xdrStr, TESTNET.passphrase);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reasons.join(" ")).toMatch(/no longer exists/);
  });
});
