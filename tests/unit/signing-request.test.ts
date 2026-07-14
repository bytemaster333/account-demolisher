import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import type { AccountAudit, AuditSigner } from "@/lib/types/account";
import {
  assessBundleability,
  closeThreshold,
  collectedWeight,
  decodeSigningRequest,
  encodeSigningRequest,
  inspectClose,
  requiredSigners,
  signedSigners,
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
  const tx = TransactionBuilder.fromXDR(buildClose(sourcePk, destination).toXDR(), NET);
  for (const kp of kps) tx.sign(kp);
  return tx.toXDR();
}

function auditWith(signers: AuditSigner[], high: number): AccountAudit {
  return {
    accountId: signers[0]?.key ?? "G",
    signers,
    thresholds: { low: 0, medium: 0, high, masterWeight: signers[0]?.weight ?? 0 },
  } as unknown as AccountAudit;
}

describe("encodeSigningRequest / decodeSigningRequest", () => {
  it("round-trips a request", () => {
    const xdr = buildClose(Keypair.random().publicKey(), Keypair.random().publicKey()).toXDR();
    const encoded = encodeSigningRequest({ network: "testnet", xdr });
    expect(decodeSigningRequest(encoded)).toEqual({ network: "testnet", xdr });
  });

  it("rejects garbage, wrong version, and unknown networks", () => {
    expect(decodeSigningRequest("not-base64url!!!")).toBeNull();
    // valid base64url but not our payload shape
    const wrongVersion = Buffer.from(JSON.stringify({ v: 2, n: "testnet", x: "x" })).toString(
      "base64url",
    );
    expect(decodeSigningRequest(wrongVersion)).toBeNull();
    const badNetwork = Buffer.from(JSON.stringify({ v: 1, n: "dogenet", x: "x" })).toString(
      "base64url",
    );
    expect(decodeSigningRequest(badNetwork)).toBeNull();
  });
});

describe("inspectClose", () => {
  it("decodes an account-close and flags it as a close", () => {
    const source = Keypair.random().publicKey();
    const dest = Keypair.random().publicKey();
    const info = inspectClose(buildClose(source, dest).toXDR(), NET);
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
    const info = inspectClose(tx.toXDR(), NET);
    expect(info?.isClose).toBe(false);
  });

  it("returns null for undecodable input", () => {
    expect(inspectClose("garbage", NET)).toBeNull();
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
