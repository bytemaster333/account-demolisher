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
// resource fees (stroops) measured by simulating the app's own builders through
// assembleSubmittable (with its instruction leeway), read-only. "archived" means
// the call restores entries from the archive (protocol 23 does that inside the
// call), "idle" that it pays rent to bump entries close to expiry.
//                                                  testnet     mainnet
//   approve(0) revoke, live token                   16,321      16,321
//   approve(0) revoke, token instance archived     300,759     936,287
//   SAC transfer to an existing balance             23,660      24,505
//   SAC transfer creating a contract balance       569,817     454,754
//   soroswap convert, direct pair                   43,574      43,607
//   soroswap convert, one hop, live pairs              -       111,002
//   soroswap convert, one hop, idle pairs        1,347,990        -
//   soroswap convert, one hop, archived pairs    5,308,082   2,825,629
//   soroswap remove_liquidity, archived pair     6,923,446   2,956,310
//   aquarius router withdraw, live state               -        65,319
//   aquarius router withdraw, archived user state      -    15,993,759
//   aquarius router claim, archived user state         -    16,305,049
//   aquarius withdraw_position (concentrated)          -       178,136
//   aquarius claim_all_position_fees                   -       137,855
//   blend submit withdraw_collateral, live             -        35,811
//   blend submit withdraw, archived Positions          -    11,763,314
//   blend backstop queue_withdrawal, archived          -     2,524,898
// the archived rows come from sweeps on 2026-10-06 and 2026-10-07: lp holders of
// every archived mainnet soroswap pair (16) and of 70 archived testnet pairs,
// every aquarius standard and stable pool (318) for a holder whose share balance
// is archived, and archived blend Positions and backstop balances in every pinned
// pool. the aquarius worst cases restore the pool's reward pages (one
// RewardInvData page is 3,316 bytes), the blend ones up to 8 entries. idle state
// sets the legitimate ceiling, not the common case.
// 17 of the 71 testnet remove_liquidity runs cost 36,812,907 to 174,326,303 and
// declared 14,700 to 53,284 write bytes: those checked restore an archived
// contract code entry (the token's or an old pair's wasm, 17 to 24 KB each). that
// is the same shape a hostile token would use to push rent onto the signer, so
// the untrusted classes refuse it rather than pay for it; the step fails with the
// fee spelled out. no mainnet pair needed that in the sweep.
// untrusted-token (revoke, held-token transfer): about twice the largest
// measured case, the archived-instance revoke. untrusted-convert (a held token
// sold through the router, or a soroswap lp exit, both of which run token code
// nobody vetted): about twice the archived-pair remove_liquidity. defi-exit
// (allow-listed protocol code only): about twice the archived aquarius claim.
// declared write bytes and read-write entries are bounded for both untrusted
// classes (largest measured without a code restore: 3,128 bytes for the
// archived one-hop convert, 10 entries).

import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";

export type SorobanFeeClass = "untrusted-token" | "untrusted-convert" | "defi-exit";

export const SOROBAN_RESOURCE_FEE_CAPS: Readonly<Record<SorobanFeeClass, bigint>> = {
  "untrusted-token": 2_000_000n,
  "untrusted-convert": 14_000_000n,
  "defi-exit": 33_000_000n,
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
