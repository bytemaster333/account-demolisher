import { describe, it, expect } from "vitest";
import type { CexInfo, MemoLike } from "@/lib/safety/cex-registry";
import { StrKey } from "@stellar/stellar-sdk";
import {
  KNOWN_CEXES,
  REFUSED_DESTINATIONS,
  cexMemoTypes,
  destinationRequiresMediator,
  isSep29MemoRequired,
  lookupCex,
  lookupRefusedDestination,
  requireMemoEnforcement,
  validateMemoFormat,
} from "@/lib/safety/cex-registry";
import { memoHashBytes } from "@/lib/stellar/memo";

// cex-registry is the last line of defense against depositing to an exchange
// hot wallet without the per-user memo that routes the funds. These tests pin
// the registry lookups, the SEP-29 memo-required check, requireMemoEnforcement
// and validateMemoFormat, the memo shape validator every destination goes
// through.

// Real entries read directly from the source registry.
const KRAKEN_TEXT = "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM";
const BINANCE_ID = "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A";
const BITSTAMP_ID = "GA3NTBDIKQVDDM6ZDKJLGXJFESWJ636AGRIW34RH5WL24LUMX3YASKX2";

// helper to build a MemoLike without repeating the shape everywhere
function memo(type: MemoLike["type"], value: string): MemoLike {
  return { type, value };
}

describe("lookupCex", () => {
  it("returns the full registry entry for a known text-memo CEX (Kraken)", () => {
    const entry = lookupCex(KRAKEN_TEXT);
    expect(entry).not.toBeNull();
    // narrow for the type checker and assert the concrete fields
    const kraken = entry as CexInfo;
    expect(kraken.name).toBe("Kraken");
    expect(kraken.requiresMemo).toBe(true);
    expect(kraken.memoType).toBe("text");
    expect(kraken.minimumDeposit).toBe("1");
  });

  it("returns the full registry entry for a known id-memo CEX (Binance)", () => {
    const entry = lookupCex(BINANCE_ID);
    expect(entry).not.toBeNull();
    const binance = entry as CexInfo;
    expect(binance.name).toBe("Binance");
    expect(binance.requiresMemo).toBe(true);
    expect(binance.memoType).toBe("id");
  });

  it("returns the same object identity that lives in KNOWN_CEXES", () => {
    const fromRegistry = KNOWN_CEXES.find((c) => c.address === KRAKEN_TEXT);
    expect(fromRegistry).toBeDefined();
    expect(lookupCex(KRAKEN_TEXT)).toBe(fromRegistry);
  });

  it("returns null for an address that is not a known CEX hot wallet", () => {
    expect(lookupCex("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(lookupCex("")).toBeNull();
  });

  it("does not fuzzy-match: a valid address with a trailing character misses", () => {
    expect(lookupCex(`${KRAKEN_TEXT}X`)).toBeNull();
  });
});

describe("KNOWN_CEXES registry invariants", () => {
  it("every entry requires a memo and declares text or id memo types only", () => {
    for (const cex of KNOWN_CEXES) {
      expect(cex.requiresMemo).toBe(true);
      // exactly one of the two ways to declare the memo type
      expect((cex.memoType === undefined) !== (cex.acceptedMemoTypes === undefined)).toBe(true);
      const types = cexMemoTypes(cex);
      expect(types.length).toBeGreaterThan(0);
      // the registry only ships text/id today; hash/return are unused
      for (const t of types) expect(t === "text" || t === "id").toBe(true);
    }
  });

  it("holds only valid account ids", () => {
    for (const { address } of [...KNOWN_CEXES, ...REFUSED_DESTINATIONS]) {
      expect(StrKey.isValidEd25519PublicKey(address)).toBe(true);
    }
  });

  it("has no duplicate addresses", () => {
    const addresses = KNOWN_CEXES.map((c) => c.address);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("classifies the known text-memo and id-memo exchanges correctly", () => {
    const byName = new Map(KNOWN_CEXES.map((c) => [c.name, c.memoType]));
    expect(byName.get("Kraken")).toBe("text");
    expect(byName.get("KuCoin")).toBe("text");
    expect(byName.get("Coinbase Deposits")).toBe("text");
    expect(byName.get("Binance")).toBe("id");
    expect(byName.get("Binance Deposits")).toBe("id");
    expect(byName.get("Bitstamp")).toBe("id");
  });

  // a dormancy exception switches off the live check's activity limit, so the
  // list of excepted accounts is exactly the one the owner approved (L-24)
  it("marks only the owner-kept Upbit account as known dormant", () => {
    const dormant = KNOWN_CEXES.filter((c) => c.dormantSinceLedger !== undefined).map((c) => [
      c.address,
      c.dormantSinceLedger,
    ]);
    expect(dormant).toEqual([
      ["GAW4E6NGM4NPNX2LO2BKDPCCTUX3FJLKWHPU4VQPGBIBQGD6JTVF5C7C", 56030614],
    ]);
  });
});

describe("requireMemoEnforcement, non-CEX and requirement gating", () => {
  it("returns ok:true for a destination that is not a known CEX", () => {
    const res = requireMemoEnforcement("GNOTACEXADDRESS", memo("text", "anything"));
    expect(res.ok).toBe(true);
  });

  it("returns ok:true for a non-CEX destination even with no memo", () => {
    expect(requireMemoEnforcement("GNOTACEXADDRESS").ok).toBe(true);
  });

  it("rejects a known CEX destination when the memo is missing entirely", () => {
    const res = requireMemoEnforcement(KRAKEN_TEXT);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("Kraken");
      expect(res.reason).toContain("requires a deposit memo");
      // names the expected memo type
      expect(res.reason).toContain('type "text"');
    }
  });

  it("rejects when the memo type does not match the CEX's required type", () => {
    // Binance requires an id memo; supply a text memo
    const res = requireMemoEnforcement(BINANCE_ID, memo("text", "hello"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('type "id"');
      expect(res.reason).toContain('got "text"');
    }
  });

  it("rejects a memo whose value is empty / whitespace only", () => {
    const res = requireMemoEnforcement(KRAKEN_TEXT, memo("text", "   "));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("non-empty memo");
  });
});

describe("requireMemoEnforcement, id memo validation", () => {
  it("accepts a plain numeric id memo", () => {
    expect(requireMemoEnforcement(BINANCE_ID, memo("id", "1234567890")).ok).toBe(true);
  });

  it("accepts 0 and the maximum uint64 value", () => {
    expect(requireMemoEnforcement(BINANCE_ID, memo("id", "0")).ok).toBe(true);
    const maxUint64 = "18446744073709551615"; // 2^64 - 1
    expect(requireMemoEnforcement(BINANCE_ID, memo("id", maxUint64)).ok).toBe(true);
  });

  it("rejects a non-numeric id memo", () => {
    const res = requireMemoEnforcement(BITSTAMP_ID, memo("id", "12ab"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("numeric memo");
  });

  it("rejects an id memo above the uint64 range", () => {
    const overUint64 = "18446744073709551616"; // 2^64
    const res = requireMemoEnforcement(BINANCE_ID, memo("id", overUint64));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("out of range");
  });

  it("trims surrounding whitespace before validating the id", () => {
    expect(requireMemoEnforcement(BINANCE_ID, memo("id", "  42  ")).ok).toBe(true);
  });
});

describe("requireMemoEnforcement, text memo validation", () => {
  it("accepts a short text memo", () => {
    expect(requireMemoEnforcement(KRAKEN_TEXT, memo("text", "user-12345")).ok).toBe(true);
  });

  it("accepts a text memo exactly at the 28-byte cap", () => {
    const exactly28 = "a".repeat(28);
    expect(requireMemoEnforcement(KRAKEN_TEXT, memo("text", exactly28)).ok).toBe(true);
  });

  it("rejects a text memo over the 28-byte cap", () => {
    const tooLong = "a".repeat(29);
    const res = requireMemoEnforcement(KRAKEN_TEXT, memo("text", tooLong));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("≤ 28 bytes");
      expect(res.reason).toContain("got 29");
    }
  });

  it("measures the cap in UTF-8 bytes, not characters", () => {
    // "é" is 2 UTF-8 bytes, so 14 of them = 28 bytes (ok), 15 = 30 bytes (reject)
    expect(requireMemoEnforcement(KRAKEN_TEXT, memo("text", "é".repeat(14))).ok).toBe(true);
    const res = requireMemoEnforcement(KRAKEN_TEXT, memo("text", "é".repeat(15)));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("got 30");
  });
});

// No registry entry declares memoType "hash" or "return", and requireMemoEnforcement
// checks memo.type against cex.memoType before it validates the value's shape, so
// a hash or return memo to a registry exchange is refused on the type mismatch.
// These tests pin that observable behavior.
describe("requireMemoEnforcement, hash/return branches are gated out by type", () => {
  it("rejects a well-formed 64-char hex hash memo at a text CEX on type mismatch", () => {
    const hex = "a".repeat(64);
    const res = requireMemoEnforcement(KRAKEN_TEXT, memo("hash", hex));
    expect(res.ok).toBe(false);
    // rejected for wrong type, not for bad shape
    if (!res.ok) expect(res.reason).toContain('got "hash"');
  });

  it("rejects a well-formed 64-char hex return memo at an id CEX on type mismatch", () => {
    const hex = "0123456789abcdef".repeat(4); // 64 hex chars
    const res = requireMemoEnforcement(BINANCE_ID, memo("return", hex));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('got "return"');
  });
});

describe("validateMemoFormat (shape validation for ALL destinations)", () => {
  it("accepts well-formed memos of each type", () => {
    expect(validateMemoFormat("id", "1234567890")).toBeNull();
    expect(validateMemoFormat("id", "0")).toBeNull();
    expect(validateMemoFormat("text", "hello")).toBeNull();
    expect(validateMemoFormat("hash", "0123456789abcdef".repeat(4))).toBeNull(); // 64 hex
    expect(validateMemoFormat("return", "0123456789abcdef".repeat(4))).toBeNull();
  });

  it("rejects a non-numeric id memo (would throw in Memo.id at execute time)", () => {
    expect(validateMemoFormat("id", "notanumber")).toContain("numeric memo");
  });

  it("rejects an id above the uint64 range", () => {
    expect(validateMemoFormat("id", "18446744073709551616")).toContain("out of range");
  });

  it("rejects a text memo over 28 bytes", () => {
    expect(validateMemoFormat("text", "x".repeat(29))).toContain("≤ 28 bytes");
  });

  it("rejects a hash/return memo that is not 32 bytes", () => {
    expect(validateMemoFormat("hash", "deadbeef")).toContain("32 bytes");
    // a 44-char string without valid padding is not accepted as 32-byte base64
    expect(validateMemoFormat("return", "A".repeat(44))).not.toBeNull();
    // ...but a correctly-padded 44-char base64 (decodes to 32 bytes) IS accepted
    expect(validateMemoFormat("hash", "A".repeat(43) + "=")).toBeNull();
  });

  it("rejects an empty value", () => {
    expect(validateMemoFormat("id", "  ")).not.toBeNull();
  });

  // a memo the validator passes must be one the builder can encode
  it("accepts exactly the hash/return values the memo builder can encode", () => {
    const b64 = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i)).toString("base64");
    for (const value of [b64, "0123456789abcdef".repeat(4), "A".repeat(43) + "="]) {
      expect(validateMemoFormat("hash", value)).toBeNull();
      expect(() => memoHashBytes(value)).not.toThrow();
    }
    for (const value of ["A".repeat(44), "deadbeef", Buffer.alloc(31).toString("base64")]) {
      expect(validateMemoFormat("hash", value)).not.toBeNull();
      expect(() => memoHashBytes(value)).toThrow();
    }
  });
});

// SEP-29: an account publishes config.memo_required = "1" (base64 "MQ==") to say
// deposits without a memo are not credited
const UNLISTED = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("isSep29MemoRequired", () => {
  it("reads the config.memo_required data entry the way the sdk does", () => {
    expect(isSep29MemoRequired({ "config.memo_required": "MQ==" })).toBe(true);
    expect(isSep29MemoRequired({ "config.memo_required": "MA==" })).toBe(false);
    expect(isSep29MemoRequired({ other: "MQ==" })).toBe(false);
    expect(isSep29MemoRequired({})).toBe(false);
  });
});

describe("destinationRequiresMediator", () => {
  it("routes a registry exchange through the mediator", () => {
    expect(destinationRequiresMediator(KRAKEN_TEXT, false)).toBe(true);
  });

  it("routes an unlisted SEP-29 memo-required destination through the mediator", () => {
    expect(destinationRequiresMediator(UNLISTED, true)).toBe(true);
  });

  it("merges directly into an ordinary destination", () => {
    expect(destinationRequiresMediator(UNLISTED, false)).toBe(false);
  });
});

describe("requireMemoEnforcement for SEP-29 destinations", () => {
  it("refuses an unlisted SEP-29 destination without a memo", () => {
    const res = requireMemoEnforcement(UNLISTED, undefined, { sep29MemoRequired: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("requires a memo");
  });

  it("refuses a malformed memo for an unlisted SEP-29 destination", () => {
    const res = requireMemoEnforcement(UNLISTED, memo("id", "abc"), { sep29MemoRequired: true });
    expect(res.ok).toBe(false);
  });

  it("accepts any well-formed memo type for an unlisted SEP-29 destination", () => {
    expect(
      requireMemoEnforcement(UNLISTED, memo("text", "user-42"), { sep29MemoRequired: true }),
    ).toEqual({ ok: true });
    expect(requireMemoEnforcement(UNLISTED, memo("id", "42"), { sep29MemoRequired: true })).toEqual(
      { ok: true },
    );
  });

  it("does not demand a memo from an ordinary destination", () => {
    expect(requireMemoEnforcement(UNLISTED, undefined, { sep29MemoRequired: false })).toEqual({
      ok: true,
    });
  });
});

// owner decision 2026-10-06 (L-24), from the stellar.expert directory
const UPBIT = "GAW4E6NGM4NPNX2LO2BKDPCCTUX3FJLKWHPU4VQPGBIBQGD6JTVF5C7C";
const UPBIT_DEPOSITS = "GCZLCMUM4Q4H324CTT3753P6656CYR4KPLHYFPGYPGE6JVHONGLNRDI5";
const UPBIT_INTERNAL = [
  "GAGL7APMF7BZT6AVGNLBXKCMEHHLKPOL6PADWSLWFVYULGHPQQSIUU2W",
  "GCWEER57MBVRXA4I426VL3PSWWM72SSZ3AZ5TGBDSWJMTDFVCABWNZIF",
  "GB74KSRBBV4HPPGJCXHN54VEHKWW5DYV2EKBQJAU7TO5NQFMCG2736YX",
  "GC2MRMMX6JPYSMTPGDAUPXPFPLJJMEDHETPP6SNCWCGR6MRSSHJMF7O4",
  "GCB5WCEQ2S4VFEWYTIAY5P2EXKTQJZEBBA7L7EYFSZ27PTLLIFB47WSM",
  "GCENZAHLGHSMJTUAHBBHQ3G6K73DURLCEUZYIF45JGGB6W63B6HCHWBU",
  "GDAZHX3DBBF25VUJ77FKK3ULKJXEUGRVQPCAKSNFOUMFDMVD4JYDIFBB",
];

describe("Upbit", () => {
  it("keeps the original Upbit entry", () => {
    expect(lookupCex(UPBIT)).toMatchObject({ name: "Upbit", requiresMemo: true });
  });

  it("lists Upbit Deposits as a memo-required exchange that accepts id and text memos", () => {
    const entry = lookupCex(UPBIT_DEPOSITS);
    expect(entry).toMatchObject({
      name: "Upbit Deposits",
      requiresMemo: true,
      acceptedMemoTypes: ["id", "text"],
      verifiedAt: "2026-10-06",
    });
    expect(entry!.source).toContain("stellar.expert directory");
    expect(entry!.source).toContain("not confirmed by Upbit");
  });

  it("routes Upbit Deposits through the mediator even without a SEP-29 flag", () => {
    expect(destinationRequiresMediator(UPBIT_DEPOSITS, false)).toBe(true);
  });

  it("requires a memo for Upbit Deposits and accepts a well-formed id or text memo", () => {
    const missing = requireMemoEnforcement(UPBIT_DEPOSITS);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('"id" or "text"');
    expect(requireMemoEnforcement(UPBIT_DEPOSITS, memo("id", "123456"))).toEqual({ ok: true });
    expect(requireMemoEnforcement(UPBIT_DEPOSITS, memo("text", "123456"))).toEqual({ ok: true });
    expect(requireMemoEnforcement(UPBIT_DEPOSITS, memo("id", "12ab")).ok).toBe(false);
    const hash = requireMemoEnforcement(UPBIT_DEPOSITS, memo("hash", "a".repeat(64)));
    expect(hash.ok).toBe(false);
    if (!hash.ok) expect(hash.reason).toContain('got "hash"');
  });

  it.each(UPBIT_INTERNAL)("refuses the Upbit internal wallet %s as a close destination", (a) => {
    const refused = lookupRefusedDestination(a);
    expect(refused).not.toBeNull();
    expect(refused!.name).toMatch(/^Upbit (ColdStorage|ColdWallet|Withdrawals)$/);
    expect(lookupCex(a)).toBeNull();
    for (const m of [undefined, memo("id", "1"), memo("text", "1")]) {
      const res = requireMemoEnforcement(a, m);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toContain("internal wallet, not a deposit address");
        expect(res.reason).toContain(a);
      }
    }
    // a SEP-29 flag does not turn it into a deposit address
    expect(requireMemoEnforcement(a, memo("id", "1"), { sep29MemoRequired: true }).ok).toBe(false);
  });

  it("refuses exactly the seven internal wallets and nothing in the exchange registry", () => {
    expect(REFUSED_DESTINATIONS.map((r) => r.address).sort()).toEqual([...UPBIT_INTERNAL].sort());
    for (const cex of KNOWN_CEXES) expect(lookupRefusedDestination(cex.address)).toBeNull();
    expect(lookupRefusedDestination(UNLISTED)).toBeNull();
  });
});
