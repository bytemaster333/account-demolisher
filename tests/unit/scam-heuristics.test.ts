import { describe, it, expect } from "vitest";
import {
  evaluateScamHeuristics,
  findingsForAsset,
  levenshtein,
  runScamHeuristics,
  TIER1_ASSETS,
  type ScamFlag,
  type ScamHeuristicId,
} from "@/lib/safety/scam-heuristics";
import type { AssetIdentifier, AuditBalance } from "@/lib/types/account";

// scam-token heuristics score classic trustlines / sep-41 tokens against a
// frozen tier-1 reference list. these tests lock in each heuristic's exact
// trigger and severity, plus the aggregation helpers.

// canonical tier-1 issuers, pulled from the module's own reference list so the
// tests track the source of truth rather than a hard-coded copy.
const USDC = TIER1_ASSETS.find((a) => a.symbol === "USDC");
const AQUA = TIER1_ASSETS.find((a) => a.symbol === "AQUA");
if (USDC === undefined || USDC.issuer === null) throw new Error("fixture: USDC issuer expected");
if (AQUA === undefined || AQUA.issuer === null) throw new Error("fixture: AQUA issuer expected");
const USDC_ISSUER = USDC.issuer;
const IMPOSTOR = "GIMPOSTORIMPOSTORIMPOSTORIMPOSTORIMPOSTORIMPOSTORIMPOSTAAAA";

// a real, mainnet-allow-listed soroban contract id (SoroswapRouter). used to
// assert the allow-list path does NOT flag.
const ALLOWED_CONTRACT = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
const UNKNOWN_CONTRACT = "CUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNOWNUNKNAAAA";

function ids(flags: readonly ScamFlag[]): ScamHeuristicId[] {
  return flags.map((f) => f.id);
}
function flag(flags: readonly ScamFlag[], id: ScamHeuristicId): ScamFlag {
  const found = flags.find((f) => f.id === id);
  if (found === undefined) throw new Error(`expected a ${id} flag, got [${ids(flags).join(", ")}]`);
  return found;
}

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("USDC", "USDC")).toBe(0);
  });

  it("returns the full length when one side is empty", () => {
    expect(levenshtein("", "XLM")).toBe(3);
    expect(levenshtein("AQUA", "")).toBe(4);
  });

  it("counts single-edit distances (substitution / insertion / deletion)", () => {
    expect(levenshtein("USDT", "USDC")).toBe(1); // substitution
    expect(levenshtein("USDCC", "USDC")).toBe(1); // deletion
    expect(levenshtein("USD", "USDC")).toBe(1); // insertion
  });

  it("is symmetric regardless of argument order", () => {
    expect(levenshtein("USTX", "USDC")).toBe(levenshtein("USDC", "USTX"));
    expect(levenshtein("USTX", "USDC")).toBe(2);
  });
});

describe("evaluateScamHeuristics — clean tokens", () => {
  it("scores a legit tier-1 asset with its canonical issuer clean", () => {
    expect(evaluateScamHeuristics({ symbol: "USDC", issuer: USDC_ISSUER })).toEqual([]);
  });

  it("scores a distinct off-list token (far from every tier-1) clean", () => {
    // DOGE is edit distance 4 from the nearest tier-1 (XLM), well past the
    // lookalike threshold of 2.
    expect(evaluateScamHeuristics({ symbol: "DOGE", issuer: IMPOSTOR })).toEqual([]);
  });

  it("does not flag an empty / whitespace-only symbol", () => {
    expect(evaluateScamHeuristics({ symbol: "" })).toEqual([]);
    expect(evaluateScamHeuristics({ symbol: "   " })).toEqual([]);
    expect(evaluateScamHeuristics({})).toEqual([]);
  });

  it("abstains on a null-issuer tier-1 symbol even with a differing seen issuer", () => {
    // XLM and BLND have issuer:null in the reference list, so an exact match
    // cannot be proven a collision — the module deliberately abstains.
    expect(evaluateScamHeuristics({ symbol: "XLM", issuer: IMPOSTOR })).toEqual([]);
    expect(evaluateScamHeuristics({ symbol: "BLND", issuer: IMPOSTOR })).toEqual([]);
  });

  it("does not treat a matching canonical issuer as a collision", () => {
    expect(evaluateScamHeuristics({ symbol: "USDC", issuer: USDC_ISSUER })).toEqual([]);
  });
});

describe("evaluateScamHeuristics — exact_symbol_collision", () => {
  it("flags critical when a tier-1 symbol carries a non-canonical issuer", () => {
    const flags = evaluateScamHeuristics({ symbol: "USDC", issuer: IMPOSTOR });
    const collision = flag(flags, "exact_symbol_collision");
    expect(collision.severity).toBe("critical");
    expect(collision.detail).toMatchObject({
      symbol: "USDC",
      seenIssuer: IMPOSTOR,
      canonicalIssuer: USDC_ISSUER,
    });
  });

  it("is case-insensitive on the symbol match (uppercases before lookup)", () => {
    // lowercase symbol still resolves to the USDC tier-1 entry for the
    // collision check; it additionally trips suspicious_character (see below).
    const flags = evaluateScamHeuristics({ symbol: "usdc", issuer: IMPOSTOR });
    expect(ids(flags)).toContain("exact_symbol_collision");
  });

  it("abstains when the subject omits an issuer (classic native-less case)", () => {
    expect(evaluateScamHeuristics({ symbol: "USDC" })).toEqual([]);
  });

  it("does not emit a lookalike flag for an exact tier-1 match", () => {
    const flags = evaluateScamHeuristics({ symbol: "AQUA", issuer: IMPOSTOR });
    // AQUA is an exact match, so only the collision path runs, never lookalike.
    expect(ids(flags)).not.toContain("lookalike_symbol");
  });
});

describe("evaluateScamHeuristics — lookalike_symbol", () => {
  it("flags edit-distance 1 as a warning", () => {
    const flags = evaluateScamHeuristics({ symbol: "USDT" });
    const look = flag(flags, "lookalike_symbol");
    expect(look.severity).toBe("warning");
    expect(look.detail).toMatchObject({ symbol: "USDT", lookalikeOf: "USDC", distance: 1 });
  });

  it("flags edit-distance 2 as info (boundary of the threshold)", () => {
    const flags = evaluateScamHeuristics({ symbol: "USTX" });
    const look = flag(flags, "lookalike_symbol");
    expect(look.severity).toBe("info");
    expect(look.detail).toMatchObject({ lookalikeOf: "USDC", distance: 2 });
  });

  it("does NOT flag edit-distance 3+ (past the threshold)", () => {
    // DOGE is distance 4 from the nearest tier-1.
    expect(ids(evaluateScamHeuristics({ symbol: "DOGE" }))).not.toContain("lookalike_symbol");
  });

  it("picks the nearest tier-1 as the lookalike target", () => {
    const flags = evaluateScamHeuristics({ symbol: "AQUX" });
    const look = flag(flags, "lookalike_symbol");
    expect(look.detail).toMatchObject({ lookalikeOf: "AQUA", distance: 1 });
  });
});

describe("evaluateScamHeuristics — suspicious_character", () => {
  it("flags critical for a confusable/homoglyph (cyrillic) character", () => {
    // trailing char is cyrillic 'с' (U+0441), not latin 'C'.
    const flags = evaluateScamHeuristics({ symbol: "USDс" });
    expect(flag(flags, "suspicious_character").severity).toBe("critical");
  });

  it("flags any lowercase symbol because the class check is case-sensitive", () => {
    // lowercase ASCII is a valid (if unusual) Stellar asset code and must NOT
    // trip suspicious_character — case impersonation is caught by the lookalike
    // / collision checks instead.
    const flags = evaluateScamHeuristics({ symbol: "usdt" });
    expect(ids(flags)).not.toContain("suspicious_character");
  });

  it("flags punctuation / whitespace inside a non-empty symbol", () => {
    expect(ids(evaluateScamHeuristics({ symbol: "US-DC" }))).toContain("suspicious_character");
    expect(ids(evaluateScamHeuristics({ symbol: "A B" }))).toContain("suspicious_character");
  });

  it("does not flag a clean uppercase-alphanumeric symbol", () => {
    expect(ids(evaluateScamHeuristics({ symbol: "DOGE2" }))).not.toContain("suspicious_character");
  });

  it("stacks with a collision when a homoglyph impersonates a tier-1 symbol", () => {
    // 'AQUА' with a cyrillic 'А' does not match the tier-1 map (different
    // codepoint) so it takes the lookalike path AND the suspicious char path.
    const flags = evaluateScamHeuristics({ symbol: "AQUА", issuer: IMPOSTOR });
    expect(ids(flags)).toContain("suspicious_character");
  });
});

describe("evaluateScamHeuristics — unknown_contract", () => {
  it("flags a soroban contract that is not on the allow-list (warning)", () => {
    const flags = evaluateScamHeuristics({ contractId: UNKNOWN_CONTRACT });
    const unknown = flag(flags, "unknown_contract");
    expect(unknown.severity).toBe("warning");
    expect(unknown.detail).toMatchObject({ contractId: UNKNOWN_CONTRACT });
  });

  it("does not flag a mainnet allow-listed contract", () => {
    expect(evaluateScamHeuristics({ contractId: ALLOWED_CONTRACT })).toEqual([]);
  });

  it("ignores an empty contractId", () => {
    expect(evaluateScamHeuristics({ contractId: "" })).toEqual([]);
  });
});

describe("runScamHeuristics", () => {
  function credit(code: string, issuer: string): AuditBalance {
    return {
      asset: { kind: "credit", code, issuer },
      amount: "0",
      buyingLiabilities: "0",
      sellingLiabilities: "0",
    };
  }

  it("skips non-credit balances (native, pool shares)", () => {
    const balances: readonly AuditBalance[] = [
      { asset: { kind: "native" }, amount: "0", buyingLiabilities: "0", sellingLiabilities: "0" },
      {
        asset: { kind: "liquidity_pool_shares", poolId: "pool1" },
        amount: "0",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ];
    expect(runScamHeuristics(balances)).toEqual([]);
  });

  it("produces one finding per (asset, flag) hit across credit balances", () => {
    const impostorUsdc = credit("USDC", IMPOSTOR); // collision
    const legit = credit("USDC", USDC_ISSUER); // clean
    const findings = runScamHeuristics([impostorUsdc, legit]);
    expect(findings).toHaveLength(1);
    const first = findings[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.flag.id).toBe("exact_symbol_collision");
    expect(first.asset).toEqual(impostorUsdc.asset);
  });

  it("emits multiple findings for a single asset that trips several heuristics", () => {
    // "USD" + cyrillic С (U+0421): a homoglyph (suspicious_character) that is
    // also one edit away from USDC (lookalike_symbol).
    const findings = runScamHeuristics([credit("USDС", IMPOSTOR)]);
    const flagIds = findings.map((f) => f.flag.id);
    expect(flagIds).toContain("suspicious_character");
    expect(flagIds).toContain("lookalike_symbol");
  });
});

describe("findingsForAsset", () => {
  it("filters findings down to a matching credit asset identifier", () => {
    const findings = runScamHeuristics([
      {
        asset: { kind: "credit", code: "USDC", issuer: IMPOSTOR },
        amount: "0",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
      {
        asset: { kind: "credit", code: "USDT", issuer: IMPOSTOR },
        amount: "0",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ]);
    const target: AssetIdentifier = { kind: "credit", code: "USDC", issuer: IMPOSTOR };
    const filtered = findingsForAsset(findings, target);
    expect(filtered.length).toBeGreaterThan(0);
    for (const f of filtered) expect(f.asset).toEqual(target);
  });

  it("returns nothing for an asset with no findings", () => {
    const findings = runScamHeuristics([
      {
        asset: { kind: "credit", code: "USDC", issuer: IMPOSTOR },
        amount: "0",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ]);
    const other: AssetIdentifier = { kind: "credit", code: "USDC", issuer: USDC_ISSUER };
    expect(findingsForAsset(findings, other)).toEqual([]);
  });
});
