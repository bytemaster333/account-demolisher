import { describe, it, expect } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  StrKey,
  xdr,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import type { NetworkConfig } from "@/lib/config/networks";
import type { BatchedOperation, ClassicBatch, ClassicMemo } from "@/lib/types/plan";

// computeFee is not exported, so drive it through the public builder. the fee
// is a u32 stroop field, so the total (feeBase * opCount) must stay <= 0xffffffff
// or the envelope cannot be encoded. these tests pin the ceiling guard.

const TEST_NET: NetworkConfig = {
  passphrase: Networks.TESTNET,
} as NetworkConfig;

const SOURCE = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function singleOpBatch(): ClassicBatch {
  return {
    operations: [
      {
        kind: "manage_data_delete",
        summary: "delete data k1",
        metadata: { name: "k1" },
      },
    ],
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  };
}

function multiOpBatch(opCount: number): ClassicBatch {
  return {
    operations: Array.from({ length: opCount }, (_, i) => ({
      kind: "manage_data_delete" as const,
      summary: `delete data k${i}`,
      metadata: { name: `k${i}` },
    })),
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  };
}

function newSource(): Horizon.AccountResponse {
  // sequence value is irrelevant for fee computation; the builder only reads
  // accountId()/sequenceNumber(), so an Account stands in for AccountResponse
  return new Account(SOURCE, "1") as unknown as Horizon.AccountResponse;
}

describe("buildClassicTransaction fee computation", () => {
  it("prices a batch at feeBase * opCount under normal conditions", () => {
    const built = buildClassicTransaction(singleOpBatch(), newSource(), TEST_NET, 100);
    expect(built.estimatedFee).toBe("100");
  });

  it("accepts a surge-derived base whose total sits at the u32 ceiling", () => {
    // one op, feeBase == 0xffffffff -> total == ceiling, must NOT throw
    const built = buildClassicTransaction(singleOpBatch(), newSource(), TEST_NET, 0xffffffff);
    expect(built.estimatedFee).toBe("4294967295");
  });

  it("throws when feeBase * opCount overflows the u32 fee ceiling", () => {
    // one op, feeBase one stroop over the ceiling -> total exceeds u32 max
    expect(() =>
      buildClassicTransaction(singleOpBatch(), newSource(), TEST_NET, 0xffffffff + 1),
    ).toThrow(/exceeds the u32 ceiling/);
  });

  it("charges feeBase * opCount total, NOT feeBase * opCount² (SDK multiplies by op count)", () => {
    // regression: feeBase was pre-multiplied AND the SDK multiplied again, so a
    // 5-op batch at base 100 was charged 100*5*5 = 2500 instead of 100*5 = 500.
    const built = buildClassicTransaction(multiOpBatch(5), newSource(), TEST_NET, 100);
    expect(built.transaction.fee).toBe("500");
    expect(built.estimatedFee).toBe("500");
  });
});

function batchOf(op: BatchedOperation, memo?: ClassicMemo): ClassicBatch {
  return {
    operations: [op],
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    ...(memo ? { memo } : {}),
  };
}

function firstOp(batch: ClassicBatch): Record<string, unknown> {
  const tx = buildClassicTransaction(batch, newSource(), TEST_NET, 100).transaction as Transaction;
  return tx.operations[0] as unknown as Record<string, unknown>;
}

const HASH_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

function clearSigner(signerKey: string, signerType: string): BatchedOperation {
  return {
    kind: "set_options_clear_signers",
    summary: "clear signer",
    metadata: { signerKey, signerType },
  };
}

// horizon reports every signer type by its strkey; set_options needs each one in
// its own field, so passing them all as ed25519PublicKey made the close unbuildable
describe("buildClassicTransaction signer removal per signer type", () => {
  it("removes an ed25519 signer", () => {
    const key = Keypair.random().publicKey();
    const op = firstOp(batchOf(clearSigner(key, "ed25519_public_key")));
    expect(op["signer"]).toEqual({ ed25519PublicKey: key, weight: 0 });
  });

  it("removes a pre-authorized transaction signer", () => {
    const key = StrKey.encodePreAuthTx(HASH_BYTES);
    const op = firstOp(batchOf(clearSigner(key, "preauth_tx")));
    const signer = op["signer"] as { preAuthTx: Uint8Array; weight: number };
    expect(Array.from(signer.preAuthTx)).toEqual(Array.from(HASH_BYTES));
    expect(signer.weight).toBe(0);
  });

  it("removes a sha256 hash signer", () => {
    const key = StrKey.encodeSha256Hash(HASH_BYTES);
    const op = firstOp(batchOf(clearSigner(key, "sha256_hash")));
    const signer = op["signer"] as { sha256Hash: Uint8Array; weight: number };
    expect(Array.from(signer.sha256Hash)).toEqual(Array.from(HASH_BYTES));
    expect(signer.weight).toBe(0);
  });

  it("removes a signed payload signer", () => {
    const payload = new xdr.SignerKeyEd25519SignedPayload({
      ed25519: Keypair.random().rawPublicKey(),
      payload: Uint8Array.from([1, 2, 3, 4]),
    });
    const key = StrKey.encodeSignedPayload(payload.toXdr());
    const op = firstOp(batchOf(clearSigner(key, "ed25519_signed_payload")));
    expect(op["signer"]).toEqual({ ed25519SignedPayload: key, weight: 0 });
  });

  it("refuses an unknown or missing signer type", () => {
    const key = Keypair.random().publicKey();
    expect(() => firstOp(batchOf(clearSigner(key, "mystery")))).toThrow(/signer type/);
    expect(() =>
      firstOp(
        batchOf({
          kind: "set_options_clear_signers",
          summary: "clear signer",
          metadata: { signerKey: key },
        }),
      ),
    ).toThrow(/signer type/);
  });

  it("refuses a key that does not match its declared type", () => {
    const key = Keypair.random().publicKey();
    expect(() => firstOp(batchOf(clearSigner(key, "preauth_tx")))).toThrow();
  });
});

function thresholdReset(thresholds: unknown): BatchedOperation {
  return {
    kind: "set_options_clear_signers",
    summary: "reset thresholds",
    metadata: { thresholds },
  };
}

describe("buildClassicTransaction threshold reset validation", () => {
  it("builds a complete threshold reset", () => {
    const op = firstOp(batchOf(thresholdReset({ low: 0, medium: 0, high: 0, masterWeight: 1 })));
    expect(op).toMatchObject({
      masterWeight: 1,
      lowThreshold: 0,
      medThreshold: 0,
      highThreshold: 0,
    });
  });

  it("refuses missing or partial thresholds instead of defaulting them", () => {
    expect(() => firstOp(batchOf(thresholdReset(undefined)))).toThrow(/thresholds/);
    expect(() => firstOp(batchOf(thresholdReset({ low: 0, medium: 0, high: 0 })))).toThrow(
      /masterWeight/,
    );
  });

  it("refuses out-of-range or fractional weights", () => {
    expect(() =>
      firstOp(batchOf(thresholdReset({ low: 0, medium: 0, high: 256, masterWeight: 1 }))),
    ).toThrow(/high/);
    expect(() =>
      firstOp(batchOf(thresholdReset({ low: 0.5, medium: 0, high: 0, masterWeight: 1 }))),
    ).toThrow(/low/);
  });
});

describe("buildClassicTransaction path validation", () => {
  const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  function pathPayment(path: unknown): BatchedOperation {
    return {
      kind: "path_payment_strict_send",
      summary: "convert",
      metadata: {
        sendAsset: { kind: "credit", code: "USDC", issuer: ISSUER },
        sendAmount: "1",
        destination: SOURCE,
        destAsset: { kind: "native" },
        destMin: "0.5",
        path,
      },
    };
  }

  it("builds a valid intermediate path", () => {
    const op = firstOp(batchOf(pathPayment([{ kind: "credit", code: "EURC", issuer: ISSUER }])));
    expect((op["path"] as unknown[]).length).toBe(1);
  });

  it("refuses malformed path entries", () => {
    expect(() => firstOp(batchOf(pathPayment([{ kind: "bogus" }])))).toThrow(/path/);
    expect(() => firstOp(batchOf(pathPayment([null])))).toThrow(/path/);
    expect(() => firstOp(batchOf(pathPayment("USDC")))).toThrow(/path/);
  });
});

describe("buildClassicTransaction memos", () => {
  const hex = Buffer.from(HASH_BYTES).toString("hex");
  const b64 = Buffer.from(HASH_BYTES).toString("base64");

  it("builds hash and return memos given as hex or base64 to the same 32 bytes", () => {
    for (const type of ["hash", "return"] as const) {
      for (const value of [hex, b64]) {
        const tx = buildClassicTransaction(
          batchOf(singleOpBatch().operations[0]!, { type, value }),
          newSource(),
          TEST_NET,
          100,
        ).transaction as Transaction;
        expect(tx.memo.type).toBe(type);
        expect(Array.from(tx.memo.value as Uint8Array)).toEqual(Array.from(HASH_BYTES));
      }
    }
  });

  it("refuses a hash memo that is not 32 bytes", () => {
    expect(() =>
      buildClassicTransaction(
        batchOf(singleOpBatch().operations[0]!, {
          type: "hash",
          value: Buffer.alloc(31).toString("base64"),
        }),
        newSource(),
        TEST_NET,
        100,
      ),
    ).toThrow(/32 bytes/);
  });
});

// the browser clock can be minutes off; time bounds anchored to the ledger close
// time keep a slow clock from producing tx_too_late on every submit
describe("buildClassicTransaction time bounds", () => {
  it("sets maxTime from the supplied ledger close time", () => {
    const ledgerCloseTime = 1_900_000_000;
    const tx = buildClassicTransaction(
      singleOpBatch(),
      newSource(),
      TEST_NET,
      100,
      300,
      ledgerCloseTime,
    ).transaction as Transaction;
    expect(tx.timeBounds).toEqual({ minTime: "0", maxTime: String(ledgerCloseTime + 300) });
  });

  it("refuses a malformed ledger close time", () => {
    expect(() =>
      buildClassicTransaction(singleOpBatch(), newSource(), TEST_NET, 100, 300, Number.NaN),
    ).toThrow(/ledger close time/);
  });
});
