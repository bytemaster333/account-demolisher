// ceiling on what a prepared Soroban transaction may cost before anyone signs it.
//
// assembleSubmittable takes the resource fee and the declared resources from the
// simulation, and the simulation runs whatever the invoked contracts do. for an
// untrusted token (revoke, held-token transfer, held-token convert) that is
// attacker code: its transfer/approve can write large persistent entries with a
// long TTL and the rent lands on the signer. a faulty or hostile rpc can inflate
// the numbers too. so every Soroban tx is checked against a cap for its class
// right before signing, and refused with the fee spelled out when it is over.
//
// resource fees (stroops) measured on 2026-10-06 by simulating the app's own
// builders through assembleSubmittable (with its instruction leeway), read-only:
//                                                  testnet     mainnet
//   approve(0) revoke, live token                   16,321      16,321
//   approve(0) revoke, token instance archived     300,759     936,287  (restore)
//   SAC transfer to an existing balance             23,660      24,505
//   SAC transfer creating a contract balance       569,817     454,754
//   soroswap convert, direct pair                   43,574      43,607
//   soroswap convert, one hop, live pairs              -       111,002
//   soroswap convert, one hop, idle pairs        1,347,990        -     (ttl rent)
//   soroswap convert, one hop, archived pairs    5,299,881        -     (restore)
//   aquarius router claim (concentrated pool)          -        55,529
//   aquarius claim_all_position_fees                   -       137,855
//   aquarius withdraw_position                         -       178,136
//   blend FixedV2 submit withdraw_collateral           -        35,811  (2026-10-02)
// an entry that has gone idle costs real rent to touch: the contract bumps its
// ttl, or protocol 23 restores it from the archive inside the same call. so the
// legitimate ceiling is set by that, not by the common case.
// untrusted-token (revoke, held-token transfer): about twice the largest
// measured case, the archived-instance revoke. untrusted-convert (a held token
// sold through the router, which runs the token's own transfer): about twice
// the archived-pair one-hop convert. defi-exit: allow-listed protocol code only;
// kept at three times the largest exit measured on 2026-10-02 (167,250).
// declared write bytes and read-write entries are bounded for both untrusted
// classes (largest measured: 2,264 bytes and 8 entries for a one-hop convert).

import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";

export type SorobanFeeClass = "untrusted-token" | "untrusted-convert" | "defi-exit";

export const SOROBAN_RESOURCE_FEE_CAPS: Readonly<Record<SorobanFeeClass, bigint>> = {
  "untrusted-token": 2_000_000n,
  "untrusted-convert": 11_000_000n,
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
  if (feeClass === "untrusted-token" || feeClass === "untrusted-convert") {
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
