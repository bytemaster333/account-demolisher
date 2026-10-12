// curated registry of known cex hot-wallet stellar addresses

import { memoHashBytes } from "@/lib/stellar/memo";

export type CexMemoType = "text" | "id" | "hash" | "return";

export interface CexInfo {
  // g... stellar account id of the cex hot wallet
  readonly address: string;
  // human-readable name shown to the user
  readonly name: string;
  // true if the cex requires a deposit memo
  readonly requiresMemo: boolean;
  // memo encoding the cex expects, when memo is required and it names one
  readonly memoType?: CexMemoType;
  // set instead of memoType when the cex accepts more than one encoding
  readonly acceptedMemoTypes?: readonly CexMemoType[];
  // decimal-string xlm minimum deposit, if the cex publishes one
  readonly minimumDeposit?: string;
  // iso date this address+policy was verified
  readonly verifiedAt: string;
  // citation for the address+policy
  readonly source: string;
  // set only on a deposit address the owner chose to keep although horizon shows
  // the account unchanged since this ledger. the scheduled live check
  // (tests/integration/mainnet/cex-registry-live.test.ts) skips its activity limit only
  // while the account still sits at exactly this ledger, so any later change to
  // the account is reported again instead of hiding behind the exception
  readonly dormantSinceLedger?: number;
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
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". Kraken XLM deposit help (support.kraken.com) confirms a 1 XLM minimum and a required memo.`,
  },
  {
    address: "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A",
    name: "Binance",
    requiresMemo: true,
    memoType: "id",
    minimumDeposit: "0.1",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". Binance XLM deposit page (binance.com) requires a numeric memo per user.`,
  },
  {
    address: "GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6",
    name: "Binance Deposits",
    requiresMemo: true,
    memoType: "id",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". Secondary Binance deposit address from the directory.`,
  },
  {
    address: "GAWPTHY6233GRWZZ7JXDMVXDUDCVQVVQ2SXCSTG3R3CNP5LQPDAHNBKL",
    name: "Bitfinex",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". Bitfinex deposit help (support.bitfinex.com) requires a memo on XLM deposits.`,
  },
  {
    address: "GA3NTBDIKQVDDM6ZDKJLGXJFESWJ636AGRIW34RH5WL24LUMX3YASKX2",
    name: "Bitstamp",
    requiresMemo: true,
    memoType: "id",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". Bitstamp's XLM deposit page (bitstamp.net) requires a numeric memo per user.`,
  },
  {
    address: "GAJ4BSGJE6UQHZAZ5U5IUOABPDCYPKPS3RFS2NVNGFGFXGVQDLBQJW2P",
    name: "KuCoin",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". KuCoin XLM deposit page (kucoin.com) requires a per-user memo.`,
  },
  {
    address: "GAW4E6NGM4NPNX2LO2BKDPCCTUX3FJLKWHPU4VQPGBIBQGD6JTVF5C7C",
    name: "Upbit",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-10-06",
    source: `${STELLAR_EXPERT_DIRECTORY}: name "Upbit", tags exchange + memo-required, checked 2026-10-06. Upbit publishes no deposit address (it shows one only to logged-in users); horizon shows the account unchanged since ledger 56030614, so the active deposit account is the "Upbit Deposits" entry below.`,
    // kept by owner decision 2026-10-06 although dormant (L-24)
    dormantSinceLedger: 56030614,
  },
  // the active upbit deposit account (owner decision 2026-10-06). upbit shows
  // deposit addresses only to logged-in users, so there is no upbit-published
  // source and the memo type is not known: both id and text are accepted
  {
    address: "GCZLCMUM4Q4H324CTT3753P6656CYR4KPLHYFPGYPGE6JVHONGLNRDI5",
    name: "Upbit Deposits",
    requiresMemo: true,
    acceptedMemoTypes: ["id", "text"],
    verifiedAt: "2026-10-06",
    source:
      "stellar.expert directory, tags exchange + memo-required, checked 2026-10-06; not confirmed by Upbit",
  },
  {
    address: "GB3RMPTL47E4ULVANHBNCXSXM2ZA5JFY5ISDRERPCXNJUDEO73QFZUNK",
    name: "CEX.IO",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". CEX.IO deposit interface (cex.io) requires a per-user memo.`,
  },
  {
    address: "GB67TJFJO3GUA432EJ4JTODHFYSBTM44P4XQCDOFTXJNNPV2UKUJYVBF",
    name: "Crypto.com",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". Crypto.com app's XLM deposit screen (help.crypto.com) requires a memo.`,
  },
  {
    address: "GB2ES2N326MZK4EGJBKN3ZARCQ5RTFQSAWIJAAKFVIIIJSCC35TXIMLB",
    name: "Robinhood",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". Robinhood's crypto deposit flow requires a memo for XLM.`,
  },
  {
    address: "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D",
    name: "Coinbase Deposits",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". Coinbase XLM deposit help (help.coinbase.com) requires a memo.`,
  },
  {
    address: "GARAR5QR7WRL24MQMSO4INWV7C5SE4EE2YVXTLD6ORONYFHSUAGZYSLN",
    name: "Blockchain.com",
    requiresMemo: true,
    memoType: "text",
    verifiedAt: "2026-05-15",
    source: `${STELLAR_EXPERT_DIRECTORY}: tag "memo-required". Blockchain.com (wallet+exchange) requires a memo for XLM deposits.`,
  },
];

const BY_ADDRESS: ReadonlyMap<string, CexInfo> = new Map(KNOWN_CEXES.map((c) => [c.address, c]));

// returns the registry entry or null if not a known cex hot wallet
export function lookupCex(address: string): CexInfo | null {
  return BY_ADDRESS.get(address) ?? null;
}

// the memo encodings an entry accepts
export function cexMemoTypes(cex: CexInfo): readonly CexMemoType[] {
  if (cex.acceptedMemoTypes !== undefined) return cex.acceptedMemoTypes;
  return cex.memoType !== undefined ? [cex.memoType] : [];
}

// "text", or "id" or "text" when several are accepted, for messages
function describeMemoTypes(cex: CexInfo): string {
  return cexMemoTypes(cex)
    .map((t) => `"${t}"`)
    .join(" or ");
}

// exchange accounts that are not deposit addresses (cold storage, withdrawal hot
// wallets). a merge into one is not tied to any customer, so a close is refused
// outright rather than routed with a memo
export interface RefusedDestination {
  readonly address: string;
  // the directory's label for the account
  readonly name: string;
  readonly verifiedAt: string;
  readonly source: string;
}

const UPBIT_INTERNAL_SOURCE =
  "stellar.expert directory (api.stellar.expert/explorer/directory/<address>), domain upbit.com, checked 2026-10-06";

function upbitInternal(address: string, name: string): RefusedDestination {
  return { address, name, verifiedAt: "2026-10-06", source: UPBIT_INTERNAL_SOURCE };
}

export const REFUSED_DESTINATIONS: readonly RefusedDestination[] = [
  upbitInternal("GAGL7APMF7BZT6AVGNLBXKCMEHHLKPOL6PADWSLWFVYULGHPQQSIUU2W", "Upbit ColdStorage"),
  upbitInternal("GCWEER57MBVRXA4I426VL3PSWWM72SSZ3AZ5TGBDSWJMTDFVCABWNZIF", "Upbit ColdWallet"),
  upbitInternal("GB74KSRBBV4HPPGJCXHN54VEHKWW5DYV2EKBQJAU7TO5NQFMCG2736YX", "Upbit Withdrawals"),
  upbitInternal("GC2MRMMX6JPYSMTPGDAUPXPFPLJJMEDHETPP6SNCWCGR6MRSSHJMF7O4", "Upbit Withdrawals"),
  upbitInternal("GCB5WCEQ2S4VFEWYTIAY5P2EXKTQJZEBBA7L7EYFSZ27PTLLIFB47WSM", "Upbit Withdrawals"),
  upbitInternal("GCENZAHLGHSMJTUAHBBHQ3G6K73DURLCEUZYIF45JGGB6W63B6HCHWBU", "Upbit Withdrawals"),
  upbitInternal("GDAZHX3DBBF25VUJ77FKK3ULKJXEUGRVQPCAKSNFOUMFDMVD4JYDIFBB", "Upbit Withdrawals"),
];

const REFUSED_BY_ADDRESS: ReadonlyMap<string, RefusedDestination> = new Map(
  REFUSED_DESTINATIONS.map((r) => [r.address, r]),
);

export function lookupRefusedDestination(address: string): RefusedDestination | null {
  return REFUSED_BY_ADDRESS.get(address) ?? null;
}

function refusedDestinationReason(refused: RefusedDestination): string {
  return (
    `${refused.address} is ${refused.name}, an exchange internal wallet, not a deposit ` +
    `address. A close cannot send funds there. Use the deposit address and memo your ` +
    `exchange account shows you.`
  );
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

// checks a memo value's shape against its type (the content can't be checked
// against the user's exchange account from the client). returns an error string,
// or null for a well-formed memo. used by exchange enforcement and the general
// pre-flight, so a malformed memo never reaches the sdk Memo constructors and
// throws mid-close on any destination.
export function validateMemoFormat(type: CexMemoType, value: string): string | null {
  const v = value.trim();
  if (v.length === 0) return "Enter a non-empty memo value.";
  switch (type) {
    case "id": {
      if (!/^\d+$/.test(v))
        return `A numeric memo (type "id") must be digits only; got "${value}".`;
      let asBig: bigint;
      try {
        asBig = BigInt(v);
      } catch {
        return `A numeric memo "${value}" is not a valid uint64.`;
      }
      if (asBig < 0n || asBig > 0xffff_ffff_ffff_ffffn) {
        return `Memo id "${value}" is out of range (must be a uint64).`;
      }
      return null;
    }
    case "text": {
      const bytes = new TextEncoder().encode(v);
      if (bytes.length > TEXT_MEMO_MAX_BYTES) {
        return `A text memo must be ≤ ${TEXT_MEMO_MAX_BYTES} bytes; got ${bytes.length}.`;
      }
      return null;
    }
    case "hash":
    case "return": {
      // exactly 32 bytes, hex or base64: the same decoding the memo builder uses,
      // so a value accepted here always encodes
      try {
        memoHashBytes(v);
        return null;
      } catch {
        return `A "${type}" memo must be 32 bytes as hex (${HASH_MEMO_HEX_LENGTH} chars) or base64 (${HASH_MEMO_BASE64_LENGTH} chars).`;
      }
    }
  }
}

// SEP-29: an account that does not credit memo-less deposits publishes the data
// entry config.memo_required with value "1" (base64 "MQ=="). this is the exact
// check the sdk's submitTransaction runs, done up front so the close is routed
// and gated before any step runs instead of failing at the final merge.
export const SEP29_MEMO_REQUIRED_KEY = "config.memo_required";
const SEP29_MEMO_REQUIRED_VALUE = "MQ==";

export function isSep29MemoRequired(dataAttr: Readonly<Record<string, string>>): boolean {
  return dataAttr[SEP29_MEMO_REQUIRED_KEY] === SEP29_MEMO_REQUIRED_VALUE;
}

// every memo-required destination, a registry exchange or an account flagged
// under SEP-29, goes through the mediator: a memo-carrying account_merge is not
// credited as a deposit
export function destinationRequiresMediator(
  destination: string,
  sep29MemoRequired: boolean,
): boolean {
  return lookupCex(destination) !== null || sep29MemoRequired;
}

// verify that a destination's memo requirement (registry exchange, or SEP-29
// flag read from the destination account) is satisfied by the caller-supplied
// memo, if any. an exchange internal wallet is refused whatever the memo.
// returns ok:true for a destination with no memo requirement
export function requireMemoEnforcement(
  destination: string,
  memo?: MemoLike,
  options: { readonly sep29MemoRequired?: boolean } = {},
): MemoEnforcementResult {
  const refused = lookupRefusedDestination(destination);
  if (refused !== null) return { ok: false, reason: refusedDestinationReason(refused) };
  const cex = lookupCex(destination);
  if (cex === null) {
    return options.sep29MemoRequired === true ? requireSep29Memo(memo) : { ok: true };
  }
  if (!cex.requiresMemo) return { ok: true };

  const types = cexMemoTypes(cex);
  const typeHint = types.length > 0 ? ` (type ${describeMemoTypes(cex)})` : "";
  if (memo === undefined) {
    return {
      ok: false,
      reason: `${cex.name} requires a deposit memo${typeHint}. Sending without one will lose your funds.`,
    };
  }

  if (types.length > 0 && !types.includes(memo.type)) {
    return {
      ok: false,
      reason: `${cex.name} requires a memo of type ${describeMemoTypes(cex)}; got "${memo.type}". Wrong memo type at the CEX = lost funds.`,
    };
  }

  const value = memo.value.trim();
  if (value.length === 0) {
    return {
      ok: false,
      reason: `${cex.name} requires a non-empty memo${typeHint}. Supply your CEX deposit memo before proceeding.`,
    };
  }

  // shape validation per memo type via the shared validator (content can't be
  // verified against the user's exchange account from the client)
  const formatError = validateMemoFormat(memo.type, value);
  if (formatError !== null) {
    return {
      ok: false,
      reason: `${cex.name}: ${formatError} Wrong memo at the CEX means lost funds.`,
    };
  }
  return { ok: true };
}

// an unlisted SEP-29 account says a memo is required but not which type, so any
// well-formed memo is accepted
function requireSep29Memo(memo: MemoLike | undefined): MemoEnforcementResult {
  if (memo === undefined || memo.value.trim().length === 0) {
    return {
      ok: false,
      reason:
        "This destination requires a memo (it sets SEP-29 config.memo_required). Enter the " +
        "deposit memo it gave you; without it the funds may never be credited.",
    };
  }
  const formatError = validateMemoFormat(memo.type, memo.value);
  return formatError === null ? { ok: true } : { ok: false, reason: formatError };
}
