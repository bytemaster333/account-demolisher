// curated registry of known cex hot-wallet stellar addresses

export type CexMemoType = "text" | "id" | "hash" | "return";

export interface CexInfo {
  // g... stellar account id of the cex hot wallet
  readonly address: string;
  // human-readable name shown to the user
  readonly name: string;
  // true if the cex requires a deposit memo
  readonly requiresMemo: boolean;
  // memo encoding the cex expects, when memo is required
  readonly memoType?: CexMemoType;
  // decimal-string xlm minimum deposit, if the cex publishes one
  readonly minimumDeposit?: string;
  // iso date this address+policy was verified
  readonly verifiedAt: string;
  // citation for the address+policy
  readonly source: string;
}

const STELLAR_EXPERT_DIRECTORY =
  "stellar.expert/directory (api.stellar.expert/explorer/public/directory?tag[]=exchange)";

export const KNOWN_CEXES: readonly CexInfo[] = [
  {
    address: "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM",
    name: "Kraken",
    requiresMemo: true,
    memoType: "text",
    minimumDeposit: "1",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Kraken XLM deposit help (support.kraken.com) confirms a 1 XLM minimum and a required memo.`,
  },
  {
    address: "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
    name: "Binance",
    requiresMemo: true,
    memoType: "id",
    minimumDeposit: "0.1",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Binance XLM deposit page (binance.com) requires a numeric memo per user.`,
  },
  {
    address: "GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6",
    name: "Binance Deposits",
    requiresMemo: true,
    memoType: "id",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Secondary Binance deposit address from the directory.`,
  },
  {
    address: "GAWPTHY6233GRWZZ7JXDMVXDUDCVQVVQ2SXCSTG3R3CNP5LQPDAHNBKL",
    name: "Bitfinex",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Bitfinex deposit help (support.bitfinex.com) requires a memo on XLM deposits.`,
  },
  {
    address: "GA3NTBDIKQVDDM6ZDKJLGXJFESWJ636AGRIW34RH5WL24LUMX3YASKX2",
    name: "Bitstamp",
    requiresMemo: true,
    memoType: "id",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Bitstamp's XLM deposit page (bitstamp.net) requires a numeric memo per user.`,
  },
  {
    address: "GAJ4BSGJE6UQHZAZ5U5IUOABPDCYPKPS3RFS2NVNGFGFXGVQDLBQJW2P",
    name: "KuCoin",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". KuCoin XLM deposit page (kucoin.com) requires a per-user memo.`,
  },
  {
    address: "GAW4E6NGM4NPNX2LO2BKDPCCTUX3FJLKWHPU4VQPGBIBQGD6JTVF5C7C",
    name: "Upbit",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Upbit XLM deposit page requires a per-user memo.`,
  },
  {
    address: "GB3RMPTL47E4ULVANHBNCXSXM2ZA5JFY5ISDRERPCXNJUDEO73QFZUNK",
    name: "CEX.IO",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". CEX.IO deposit interface (cex.io) requires a per-user memo.`,
  },
  {
    address: "GB67TJFJO3GUA432EJ4JTODHFYSBTM44P4XQCDOFTXJNNPV2UKUJYVBF",
    name: "Crypto.com",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Crypto.com app's XLM deposit screen (help.crypto.com) requires a memo.`,
  },
  {
    address: "GB2ES2N326MZK4EGJBKN3ZARCQ5RTFQSAWIJAAKFVIIIJSCC35TXIMLB",
    name: "Robinhood",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Robinhood's crypto deposit flow requires a memo for XLM.`,
  },
  {
    address: "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D",
    name: "Coinbase Deposits",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Coinbase XLM deposit help (help.coinbase.com) requires a memo.`,
  },
  {
    address: "GARAR5QR7WRL24MQMSO4INWV7C5SE4EE2YVXTLD6ORONYFHSUAGZYSLN",
    name: "Blockchain.com",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY} — tag "memo-required". Blockchain.com (wallet+exchange) requires a memo for XLM deposits.`,
  },
];

const BY_ADDRESS: ReadonlyMap<string, CexInfo> = new Map(KNOWN_CEXES.map((c) => [c.address, c]));

// returns the registry entry or null if not a known cex hot wallet
export function lookupCex(address: string): CexInfo | null {
  return BY_ADDRESS.get(address) ?? null;
}

// result of a memo-enforcement check
export type MemoEnforcementResult = { ok: true } | { ok: false; reason: string };

// caller-supplied memo descriptor. dependency-free shape mirroring stellar-sdk
export interface MemoLike {
  readonly type: CexMemoType;
  readonly value: string;
}

const TEXT_MEMO_MAX_BYTES = 28;
const HASH_MEMO_HEX_LENGTH = 64; // 32 bytes
const HASH_MEMO_BASE64_LENGTH = 44; // 32 bytes base64-encoded with padding

// verify that a destination's cex memo requirement is satisfied by the
// caller-supplied memo, if any. returns ok:true for non-cex destinations
export function requireMemoEnforcement(
  destination: string,
  memo?: MemoLike,
): MemoEnforcementResult {
  const cex = lookupCex(destination);
  if (cex === null) return { ok: true };
  if (!cex.requiresMemo) return { ok: true };

  if (memo === undefined) {
    return {
      ok: false,
      reason: `${cex.name} requires a deposit memo${
        cex.memoType !== undefined ? ` (type "${cex.memoType}")` : ""
      }. Sending without one will lose your funds.`,
    };
  }

  if (cex.memoType !== undefined && memo.type !== cex.memoType) {
    return {
      ok: false,
      reason: `${cex.name} requires a memo of type "${cex.memoType}"; got "${memo.type}". Wrong memo type at the CEX = lost funds.`,
    };
  }

  const value = memo.value.trim();
  if (value.length === 0) {
    return {
      ok: false,
      reason: `${cex.name} requires a non-empty memo${
        cex.memoType !== undefined ? ` (type "${cex.memoType}")` : ""
      }. Supply your CEX deposit memo before proceeding.`,
    };
  }

  // shape validation per memo type. we can't validate the memo's content
  // against the user's cex account from the client
  switch (memo.type) {
    case "id": {
      if (!/^\d+$/.test(value)) {
        return {
          ok: false,
          reason: `${cex.name} expects a numeric memo (memo type "id"); got "${memo.value}".`,
        };
      }
      // memo-id is uint64
      let asBig: bigint;
      try {
        asBig = BigInt(value);
      } catch {
        return {
          ok: false,
          reason: `${cex.name} expects a numeric memo; "${memo.value}" is not a valid uint64.`,
        };
      }
      if (asBig < 0n || asBig > 0xffff_ffff_ffff_ffffn) {
        return {
          ok: false,
          reason: `${cex.name} expects a uint64 memo; "${memo.value}" is out of range.`,
        };
      }
      return { ok: true };
    }
    case "text": {
      const bytes = new TextEncoder().encode(value);
      if (bytes.length > TEXT_MEMO_MAX_BYTES) {
        return {
          ok: false,
          reason: `${cex.name} memo (type "text") must be ≤ ${TEXT_MEMO_MAX_BYTES} bytes; got ${bytes.length}.`,
        };
      }
      return { ok: true };
    }
    case "hash":
    case "return": {
      const looksHex = /^[0-9a-fA-F]+$/.test(value) && value.length === HASH_MEMO_HEX_LENGTH;
      const looksBase64 =
        /^[A-Za-z0-9+/]+=*$/.test(value) && value.length === HASH_MEMO_BASE64_LENGTH;
      if (!looksHex && !looksBase64) {
        return {
          ok: false,
          reason: `${cex.name} memo (type "${memo.type}") must be 32 bytes encoded as hex (${HASH_MEMO_HEX_LENGTH} chars) or base64 (${HASH_MEMO_BASE64_LENGTH} chars).`,
        };
      }
      return { ok: true };
    }
  }
}
