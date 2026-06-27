import { describe, it, expect } from "vitest";
import { Account, Networks, type Horizon } from "@stellar/stellar-sdk";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import type { NetworkConfig } from "@/lib/config/networks";
import type { ClassicBatch } from "@/lib/types/plan";

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
});
