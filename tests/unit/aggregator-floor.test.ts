import { describe, it, expect } from "vitest";

import { convertToXLM, SlippageGuardTripped } from "@/lib/adapters/soroswap/aggregator";
import { TESTNET } from "@/lib/config/networks";
import type { AssetIdentifier } from "@/lib/types/account";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const ISSUER = "GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN";
const ASSET_IN: AssetIdentifier = { kind: "credit", code: "TEST", issuer: ISSUER };

function clientReturning(amountOut: bigint, otherAmountThreshold: bigint) {
  return {
    quote: async () => ({ amountOut, otherAmountThreshold }) as never,
    build: async () => ({ xdr: "SHOULD_NOT_BE_REACHED" }) as never,
  };
}

describe("convertToXLM absolute floor (SEC-07)", () => {
  it("refuses a swap the aggregator prices at zero output (would accept any result)", async () => {
    await expect(
      convertToXLM(
        { assetIn: ASSET_IN, amountIn: "1000000", userAddress: USER, network: TESTNET },
        { client: clientReturning(0n, 0n) as never },
      ),
    ).rejects.toBeInstanceOf(SlippageGuardTripped);
  });

  it("still refuses when the aggregator's own threshold sits below our slippage minimum", async () => {
    // non-zero expected, but the aggregator's threshold is far below our derived min
    await expect(
      convertToXLM(
        { assetIn: ASSET_IN, amountIn: "1000000", userAddress: USER, network: TESTNET },
        { client: clientReturning(1_000_000n, 1n) as never },
      ),
    ).rejects.toBeInstanceOf(SlippageGuardTripped);
  });
});
