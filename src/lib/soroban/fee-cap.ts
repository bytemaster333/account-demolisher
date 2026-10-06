// ceiling on what a prepared Soroban transaction may cost before anyone signs it.
//
// prepareTransaction takes the resource fee and the declared resources from the
// simulation, and the simulation runs whatever the invoked contracts do. for an
// untrusted token (revoke, held-token transfer, held-token convert) that is
// attacker code: its transfer/approve can write large persistent entries with a
// long TTL and the rent lands on the signer. a faulty or hostile rpc can inflate
// the numbers too. so every Soroban tx is checked against a cap for its class
// right before signing, and refused with the fee spelled out when it is over.
//
// caps come from mainnet simulations on 2026-10-02 (resource fee, stroops):
//   approve(0) revoke on the USDC SAC              15,929
//   SAC transfer to an existing balance            24,106
//   SAC transfer creating a new contract balance  454,439  (persistent entry rent)
//   soroswap swap, direct pair                     43,275
//   soroswap swap through one hop                 173,547
//   blend FixedV2 submit withdraw_collateral       35,811
//   aquarius router claim (concentrated pool)      66,448
//   aquarius claim_all_position_fees              120,477
//   aquarius withdraw_position                    167,250
// untrusted-token cap: about twice the largest legitimate case (a transfer that
// has to create the recipient's balance entry). defi-exit cap: three times the
// largest measured exit, for allow-listed protocol code under heavier state.
// declared write bytes and read-write entries are bounded for untrusted tokens as
// well (largest measured: 2,176 bytes and 8 entries for the one-hop swap).

import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";

export type SorobanFeeClass = "untrusted-token" | "defi-exit";

export const SOROBAN_RESOURCE_FEE_CAPS: Readonly<Record<SorobanFeeClass, bigint>> = {
  "untrusted-token": 1_000_000n,
  "defi-exit": 5_000_000n,
};

export const UNTRUSTED_TOKEN_MAX_WRITE_BYTES = 8_192;
export const UNTRUSTED_TOKEN_MAX_READ_WRITE_ENTRIES = 16;

const STROOPS_PER_XLM = 10_000_000n;

export interface SorobanFeeBreakdown {
  // the total fee the signer authorizes (inclusion bid + resource fee)
  readonly totalFee: bigint;
  readonly inclusionFee: bigint;
  readonly resourceFee: bigint;
  readonly writeBytes: number;
  readonly readWriteEntries: number;
}

export class SorobanFeeCapError extends Error {
  readonly feeClass: SorobanFeeClass;
  readonly breakdown: SorobanFeeBreakdown;
  constructor(feeClass: SorobanFeeClass, breakdown: SorobanFeeBreakdown, reason: string) {
    super(
      `Refusing to sign: this step would cost ${formatXlm(breakdown.totalFee)} XLM in fees ` +
        `(${reason}). That is above what this kind of step legitimately needs, so it was not signed.`,
    );
    this.name = "SorobanFeeCapError";
    this.feeClass = feeClass;
    this.breakdown = breakdown;
  }
}

// reads the fee the signer would authorize and the resources the tx declares
export function sorobanFeeBreakdown(tx: Transaction | FeeBumpTransaction): SorobanFeeBreakdown {
  const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
  const envelope = inner.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") {
    throw new Error(`not a v1 transaction envelope (${envelope.type})`);
  }
  const ext = envelope.v1.tx.ext;
  if (ext.type !== "sorobanData") {
    throw new Error("transaction carries no Soroban resource data; it was not prepared");
  }
  const data = ext.sorobanData;
  return {
    totalFee: BigInt(tx.fee),
    inclusionFee: BigInt(SOROBAN_INCLUSION_FEE),
    resourceFee: BigInt(data.resourceFee.toString()),
    writeBytes: data.resources.writeBytes,
    readWriteEntries: data.resources.footprint.readWrite.length,
  };
}

// throws SorobanFeeCapError when the prepared tx costs or declares more than its
// class allows
export function assertSorobanFeeWithinCap(
  tx: Transaction | FeeBumpTransaction,
  feeClass: SorobanFeeClass,
): SorobanFeeBreakdown {
  const b = sorobanFeeBreakdown(tx);
  const cap = SOROBAN_RESOURCE_FEE_CAPS[feeClass];
  if (b.resourceFee > cap) {
    throw new SorobanFeeCapError(
      feeClass,
      b,
      `resource fee ${formatXlm(b.resourceFee)} XLM over the ${formatXlm(cap)} XLM cap`,
    );
  }
  if (b.totalFee > b.inclusionFee + cap) {
    throw new SorobanFeeCapError(
      feeClass,
      b,
      `total fee over the ${formatXlm(b.inclusionFee + cap)} XLM cap`,
    );
  }
  if (feeClass === "untrusted-token") {
    if (b.writeBytes > UNTRUSTED_TOKEN_MAX_WRITE_BYTES) {
      throw new SorobanFeeCapError(
        feeClass,
        b,
        `the token asks to write ${b.writeBytes} bytes, over the ${UNTRUSTED_TOKEN_MAX_WRITE_BYTES}-byte limit`,
      );
    }
    if (b.readWriteEntries > UNTRUSTED_TOKEN_MAX_READ_WRITE_ENTRIES) {
      throw new SorobanFeeCapError(
        feeClass,
        b,
        `the token asks to modify ${b.readWriteEntries} ledger entries, over the limit of ${UNTRUSTED_TOKEN_MAX_READ_WRITE_ENTRIES}`,
      );
    }
  }
  return b;
}

export function formatXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}
