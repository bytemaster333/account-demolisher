// ceiling on what a prepared Soroban transaction may cost before anyone signs it.
//
// assembleSubmittable takes the resource fee and the declared resources from the
// simulation, and the simulation runs whatever the invoked contracts do. for an
// untrusted token (revoke, held-token transfer, held-token convert, a token in
// a permissionless pool being exited) that is attacker code: its transfer or
// approve can write large persistent entries with a long TTL and the rent lands
// on the signer. a faulty or hostile rpc can inflate the numbers too. so every
// Soroban tx is checked against a cap for its class right before signing, and
// refused with the fee spelled out when it is over.
//
// resource fees (stroops) measured by simulating the app's own builders through
// assembleSubmittable (with its instruction leeway), read-only. "archived" means
// the call restores entries from the archive (protocol 23 does that inside the
// call), "idle" that it pays rent to bump entries close to expiry. fees drift
// with network state, so a re-run lands near these, not on them.
//                                                  testnet     mainnet
//   approve(0) revoke, live token                   16,321      16,321
//   approve(0) revoke, token instance archived     300,759     936,287
//   SAC transfer to an existing balance             23,660      24,505
//   SAC transfer creating a contract balance       569,817     454,754
//   sep-41 token transfer to an existing balance    21,598         -
//   sep-41 token transfer creating a balance     2,563,891     308,336
//   aquarius share token transfer to a new holder      -     2,478,533
//   soroswap convert, direct pair                   43,574      43,607
//   soroswap convert, one hop, live pairs              -       111,002
//   soroswap convert, one hop, idle pairs        1,347,990        -
//   soroswap convert, one hop, archived pairs    5,308,082   2,825,629
//   soroswap remove_liquidity, archived pair     6,923,446   2,956,310
//   aquarius router withdraw, live state               -        65,319
//   aquarius router withdraw, archived user state      -    15,993,759
//   aquarius router claim, archived user state         -    16,305,049
//   aquarius withdraw_position (concentrated)          -     4,517,897
//   aquarius claim_all_position_fees                   -     6,317,225
//   aquarius pool gauges_claim, paying XLM             -     1,694,330
//   blend submit withdraw_collateral, live             -        35,811
//   blend submit withdraw, archived Positions          -    11,763,314
//   blend YieldBloxV2 withdraw_collateral, archived    -     1,060,719
//   blend backstop queue_withdrawal, archived          -     2,524,898
// the gauges_claim row is a holder owed XLM by the gauge of stable pool
// CCNXGPE4... on 2026-10-08. the sep-41 transfer rows were measured on
// 2026-10-09: on testnet a fresh instance of the soroban token wasm 464c7cf3...
// (the one the held-token close test deploys), whose new balance entry pays
// about 0.25 XLM of rent there; on mainnet a token that answered a fresh-holder
// transfer (CBIJBDNZ...) and five aquarius pool share tokens (wasm 72eb5d52...,
// 1,700,217 to 2,478,533, 6,524 to 9,092 write bytes and 10 to 14 read-write
// entries, since a share transfer checkpoints the pool's rewards). the others
// come from sweeps on 2026-10-06 and 2026-10-07: lp holders of every archived mainnet soroswap pair (16) and of
// 70 archived testnet pairs, every aquarius standard and stable pool (318) for
// a holder whose share balance is archived, position holders of the 37 pinned
// concentrated pools (none of the 1,017 User entries the sweep listed through
// stellar.expert was archived, so no archived concentrated position could be
// measured), and archived blend Positions and backstop balances in every pinned
// pool, YieldBloxV2 included.
// the YieldBloxV2 row is the largest of its 8 archived holders (2 entries
// restored, 1,232 to 1,336 write bytes, 5 read-write entries), far under the
// worst blend row, so no cap changed for it. those withdraws trapped before 2026-10-07 only because the builder asked for i128::MAX of a
// reserve whose b_rate is below 1e12, which overflowed the pool's bToken
// conversion (fixed in blend/exit.ts v2WithdrawRequest). the aquarius worst
// cases restore the pool's reward pages (one RewardInvData page is 3,316 bytes),
// the blend ones up to 8 entries.
//
// 17 of the 70 testnet remove_liquidity runs cost 36,812,907 to 174,084,607 and
// declared 14,700 to 53,204 write bytes: those checked restore an archived
// contract code entry (the token's or an old pair's wasm, 17 to 24 KB each). that
// is the same shape a hostile token would use to push rent onto the signer, so
// the bounded classes refuse it rather than pay for it; the step fails with the
// fee spelled out. no mainnet pair needed that in the sweep.
//
// the classes, each capped at two to three times its largest measured case:
// untrusted-token (an allowance revoke): the archived-instance revoke.
// untrusted-transfer (a held token sent as it is): the testnet transfer that
// creates the destination's balance. a revoke writes no new entry, so it keeps
// the tighter cap.
// untrusted-convert (a held token sold through the router, or a soroswap lp
// exit; both run token code nobody vetted): the archived-pair remove_liquidity.
// pool-exit (aquarius standard, stable and concentrated pools and their gauge
// reward claims; the protocol code is pinned but the pools are permissionless,
// so a pool token can be anything):
// the archived router claim. defi-exit (blend steps against the pinned pools and
// backstops): the archived blend withdraw, at 11,763,314 still the largest
// blend row, so the cap stays where it was.
// declared write bytes and read-write entries are bounded for all but the last
// (largest measured without a code restore: 3,128 bytes and 10 entries for the
// archived one-hop convert; 9,092 bytes and 14 entries for a share token
// transfer; 15,984 bytes for a concentrated withdraw and 22 entries for
// another). within those bounds it is the resource-fee cap that limits what a
// hostile token can add in rent: up to 0.75 XLM for a held-token transfer the
// user chose to send, and about 3.3 XLM for a pool exit, where the worst
// legitimate one measured cost 1.6 XLM.

import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { stroopsToTrimmedDecimal } from "@/lib/stellar/amount";

export type SorobanFeeClass =
  "untrusted-token" | "untrusted-transfer" | "untrusted-convert" | "pool-exit" | "defi-exit";

export const SOROBAN_RESOURCE_FEE_CAPS: Readonly<Record<SorobanFeeClass, bigint>> = {
  "untrusted-token": 2_000_000n,
  "untrusted-transfer": 7_500_000n,
  "untrusted-convert": 14_000_000n,
  "pool-exit": 33_000_000n,
  "defi-exit": 33_000_000n,
};

// the most a step of this class is ever signed for: the inclusion bid every
// soroban step carries plus its resource fee cap. the executor re-simulates each
// step right before signing, so this, not the preview's simulated fee, bounds it
export function sorobanFeeCeiling(feeClass: SorobanFeeClass): bigint {
  return BigInt(SOROBAN_INCLUSION_FEE) + SOROBAN_RESOURCE_FEE_CAPS[feeClass];
}

export const UNTRUSTED_TOKEN_MAX_WRITE_BYTES = 8_192;
export const UNTRUSTED_TOKEN_MAX_READ_WRITE_ENTRIES = 16;
export const UNTRUSTED_TRANSFER_MAX_WRITE_BYTES = 16_384;
export const UNTRUSTED_TRANSFER_MAX_READ_WRITE_ENTRIES = 24;
export const POOL_EXIT_MAX_WRITE_BYTES = 32_768;
export const POOL_EXIT_MAX_READ_WRITE_ENTRIES = 40;

// the classes whose declared writes are bounded, and the bounds
const WRITE_BOUNDS: Readonly<
  Partial<Record<SorobanFeeClass, { readonly bytes: number; readonly entries: number }>>
> = {
  "untrusted-token": {
    bytes: UNTRUSTED_TOKEN_MAX_WRITE_BYTES,
    entries: UNTRUSTED_TOKEN_MAX_READ_WRITE_ENTRIES,
  },
  "untrusted-transfer": {
    bytes: UNTRUSTED_TRANSFER_MAX_WRITE_BYTES,
    entries: UNTRUSTED_TRANSFER_MAX_READ_WRITE_ENTRIES,
  },
  "untrusted-convert": {
    bytes: UNTRUSTED_TOKEN_MAX_WRITE_BYTES,
    entries: UNTRUSTED_TOKEN_MAX_READ_WRITE_ENTRIES,
  },
  "pool-exit": { bytes: POOL_EXIT_MAX_WRITE_BYTES, entries: POOL_EXIT_MAX_READ_WRITE_ENTRIES },
};

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
      `Refusing to sign: this step would cost ${stroopsToTrimmedDecimal(breakdown.totalFee)} XLM in fees ` +
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
      `resource fee ${stroopsToTrimmedDecimal(b.resourceFee)} XLM over the ${stroopsToTrimmedDecimal(cap)} XLM cap`,
    );
  }
  if (b.totalFee > b.inclusionFee + cap) {
    throw new SorobanFeeCapError(
      feeClass,
      b,
      `total fee over the ${stroopsToTrimmedDecimal(b.inclusionFee + cap)} XLM cap`,
    );
  }
  const bound = WRITE_BOUNDS[feeClass];
  if (bound !== undefined) {
    if (b.writeBytes > bound.bytes) {
      throw new SorobanFeeCapError(
        feeClass,
        b,
        `the token asks to write ${b.writeBytes} bytes, over the ${bound.bytes}-byte limit`,
      );
    }
    if (b.readWriteEntries > bound.entries) {
      throw new SorobanFeeCapError(
        feeClass,
        b,
        `the token asks to modify ${b.readWriteEntries} ledger entries, over the limit of ${bound.entries}`,
      );
    }
  }
  return b;
}
