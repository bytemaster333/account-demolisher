import { describe, it, expect } from "vitest";
import type { CexInfo, MemoLike } from "@/lib/safety/cex-registry";
import { KNOWN_CEXES, lookupCex, requireMemoEnforcement } from "@/lib/safety/cex-registry";

// cex-registry is the last line of defense against depositing to an exchange
// hot wallet without the per-user memo that routes the funds. These tests pin
// the registry lookups and the STRICT memo shape-validator that lives in this
// module (distinct from the weaker requireMemoEnforcement in
// memo-enforcement.ts, which takes a CexInfo rather than a destination string).

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
  it("every entry requires a memo and declares a text or id memo type", () => {
    for (const cex of KNOWN_CEXES) {
      expect(cex.requiresMemo).toBe(true);
      // the registry only ships text/id today; hash/return are unused
      expect(cex.memoType === "text" || cex.memoType === "id").toBe(true);
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

// The switch handles "hash" and "return", validating 32 bytes as either 64 hex
// chars or 44 base64 chars. NOTE: no registry entry declares memoType "hash" or
// "return", and the earlier type-match guard requires memo.type === cex.memoType.
// So these branches are UNREACHABLE via requireMemoEnforcement with the current
// registry: a hash/return memo is rejected on the type mismatch before the
// switch. These tests document that observable behavior rather than the (dead)
// shape-validation logic. See cex-registry.ts:165 (guard) and :220-232 (branch).
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
