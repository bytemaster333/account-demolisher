import { describe, it, expect } from "vitest";
import type { ClaimableBalanceEntry } from "@/lib/types/account";
import { evaluatePredicate, filterClaimableNow } from "@/lib/stellar/claimable-balances";

// The claim-predicate evaluator decides whether a claimant may claim a balance
// at a given ledger close time. Horizon encodes predicates as a recursive JSON
// tree; these tests exercise the real leaf shapes (both snake_case and
// camelCase), the boolean combinators, and the boundary semantics of
// absolute-time predicates. `evaluatePredicate` takes `unknown`, so fixtures
// are intentionally plain records that mirror Horizon's wire shape.

// A fixed reference "now" so tests are deterministic. 2020-01-01T00:00:00Z.
const NOW = new Date("2020-01-01T00:00:00.000Z");
const NOW_EPOCH_SECONDS = Math.floor(NOW.getTime() / 1000); // 1577836800

// helpers producing absolute-time epoch-second strings relative to NOW
const past = (secondsBefore: number): string => String(NOW_EPOCH_SECONDS - secondsBefore);
const future = (secondsAfter: number): string => String(NOW_EPOCH_SECONDS + secondsAfter);

describe("evaluatePredicate", () => {
  describe("unconditional / degenerate inputs", () => {
    // horizon always emits a predicate, so a missing one is malformed input and
    // must not be read as "claimable"
    it("does not treat a null predicate as claimable", () => {
      expect(evaluatePredicate(null, NOW)).toBe(false);
    });

    it("does not treat an undefined predicate as claimable", () => {
      expect(evaluatePredicate(undefined, NOW)).toBe(false);
    });

    it("does not treat { unconditional: undefined } or null as claimable", () => {
      expect(evaluatePredicate({ unconditional: undefined }, NOW)).toBe(false);
      expect(evaluatePredicate({ unconditional: null }, NOW)).toBe(false);
    });

    it("returns false for a non-object predicate", () => {
      expect(evaluatePredicate("unconditional", NOW)).toBe(false);
      expect(evaluatePredicate(42, NOW)).toBe(false);
      expect(evaluatePredicate(true, NOW)).toBe(false);
    });

    it("returns false for an empty / unrecognized object shape", () => {
      expect(evaluatePredicate({}, NOW)).toBe(false);
      expect(evaluatePredicate({ mystery: 1 }, NOW)).toBe(false);
    });

    it("treats { unconditional: true } as claimable", () => {
      expect(evaluatePredicate({ unconditional: true }, NOW)).toBe(true);
    });

    it('treats the string "true" for unconditional as claimable', () => {
      expect(evaluatePredicate({ unconditional: "true" }, NOW)).toBe(true);
    });

    it("does NOT treat { unconditional: false } as claimable", () => {
      expect(evaluatePredicate({ unconditional: false }, NOW)).toBe(false);
    });
  });

  describe("absolute-time predicate (abs_before / absBefore)", () => {
    it("is claimable when ledger time is strictly before abs_before (snake_case)", () => {
      expect(evaluatePredicate({ abs_before: future(3600) }, NOW)).toBe(true);
    });

    it("is NOT claimable when ledger time is after abs_before (snake_case)", () => {
      expect(evaluatePredicate({ abs_before: past(3600) }, NOW)).toBe(false);
    });

    it("is claimable when ledger time is strictly before absBefore (camelCase)", () => {
      expect(evaluatePredicate({ absBefore: future(3600) }, NOW)).toBe(true);
    });

    it("is NOT claimable when ledger time is after absBefore (camelCase)", () => {
      expect(evaluatePredicate({ absBefore: past(3600) }, NOW)).toBe(false);
    });

    it("uses a strict '<' at the exact boundary (equal time is NOT claimable)", () => {
      // ledgerCloseTime.getTime() < epochMs must be false when they are equal
      expect(evaluatePredicate({ abs_before: String(NOW_EPOCH_SECONDS) }, NOW)).toBe(false);
    });

    it("accepts an ISO-8601 datetime string via Date.parse", () => {
      expect(evaluatePredicate({ abs_before: "2020-06-01T00:00:00Z" }, NOW)).toBe(true);
      expect(evaluatePredicate({ abs_before: "2019-06-01T00:00:00Z" }, NOW)).toBe(false);
    });

    it("accepts a numeric epoch-seconds value (not just a string)", () => {
      expect(evaluatePredicate({ abs_before: NOW_EPOCH_SECONDS + 3600 }, NOW)).toBe(true);
      expect(evaluatePredicate({ abs_before: NOW_EPOCH_SECONDS - 3600 }, NOW)).toBe(false);
    });

    it("returns false for an unparseable abs_before string", () => {
      expect(evaluatePredicate({ abs_before: "not-a-date" }, NOW)).toBe(false);
    });

    it("returns false for an empty / whitespace abs_before string", () => {
      expect(evaluatePredicate({ abs_before: "" }, NOW)).toBe(false);
      expect(evaluatePredicate({ abs_before: "   " }, NOW)).toBe(false);
    });
  });

  describe("standalone epoch predicate (abs_before_epoch / absBeforeEpoch)", () => {
    it("is claimable when ledger time is before the epoch (snake_case)", () => {
      expect(evaluatePredicate({ abs_before_epoch: future(3600) }, NOW)).toBe(true);
    });

    it("is NOT claimable when ledger time is after the epoch (snake_case)", () => {
      expect(evaluatePredicate({ abs_before_epoch: past(3600) }, NOW)).toBe(false);
    });

    it("is claimable when ledger time is before the epoch (camelCase)", () => {
      expect(evaluatePredicate({ absBeforeEpoch: future(3600) }, NOW)).toBe(true);
    });

    it("returns false for a non-numeric epoch value", () => {
      expect(evaluatePredicate({ abs_before_epoch: "abc" }, NOW)).toBe(false);
    });
  });

  describe("far-future abs_before (horizon expanded-year strings)", () => {
    // horizon renders years past 9999 as an expanded-year rfc3339 string that
    // Date.parse rejects, and also sends abs_before_epoch. rel_before INT64_MAX is
    // stored by core as abs_before INT64_MAX and lands here too.
    const int64Max = {
      abs_before: "+292277026596-12-04T15:30:07Z",
      abs_before_epoch: "9223372036854775807",
    };
    const year10000 = { abs_before: "+10000-01-01T00:00:00Z", abs_before_epoch: "253402300800" };

    it("treats an INT64_MAX abs_before as claimable", () => {
      expect(evaluatePredicate(int64Max, NOW)).toBe(true);
    });

    it("treats a year-10000 abs_before as claimable", () => {
      expect(evaluatePredicate(year10000, NOW)).toBe(true);
    });

    it("treats an expanded-year string with no epoch as far future", () => {
      expect(evaluatePredicate({ abs_before: "+10000-01-01T00:00:00Z" }, NOW)).toBe(true);
      expect(evaluatePredicate({ not: { abs_before: "+10000-01-01T00:00:00Z" } }, NOW)).toBe(false);
    });

    it("is not claimable under not() of a far-future bound", () => {
      expect(evaluatePredicate({ not: int64Max }, NOW)).toBe(false);
      expect(evaluatePredicate({ not: year10000 }, NOW)).toBe(false);
    });

    it("prefers abs_before_epoch over the string form", () => {
      expect(evaluatePredicate({ abs_before: "garbage", abs_before_epoch: future(60) }, NOW)).toBe(
        true,
      );
      expect(evaluatePredicate({ abs_before: "garbage", abs_before_epoch: past(60) }, NOW)).toBe(
        false,
      );
    });
  });

  describe("unreadable leaves fail closed in both directions", () => {
    it("does not flip an unparseable bound into claimable under not()", () => {
      expect(evaluatePredicate({ not: { abs_before: "not-a-date" } }, NOW)).toBe(false);
      expect(evaluatePredicate({ not: { mystery: 1 } }, NOW)).toBe(false);
      expect(evaluatePredicate({ not: { rel_before: "10" } }, NOW)).toBe(false);
    });
  });

  describe("relative-time predicate (rel_before / relBefore)", () => {
    // core stores rel_before as abs_before at creation, so horizon never returns
    // it; a raw one is unreadable and never counts as claimable.
    it("returns false for rel_before regardless of value (snake_case)", () => {
      expect(evaluatePredicate({ rel_before: "0" }, NOW)).toBe(false);
      expect(evaluatePredicate({ rel_before: "99999999" }, NOW)).toBe(false);
    });

    it("returns false for relBefore regardless of value (camelCase)", () => {
      expect(evaluatePredicate({ relBefore: "0" }, NOW)).toBe(false);
    });
  });

  describe("negation (not)", () => {
    it("negates an unconditional child → not claimable", () => {
      expect(evaluatePredicate({ not: { unconditional: true } }, NOW)).toBe(false);
    });

    it("negates an absolute-time child (claim opens after a boundary)", () => {
      // not(before past) === not(false) === true  → claimable now
      expect(evaluatePredicate({ not: { abs_before: past(3600) } }, NOW)).toBe(true);
      // not(before future) === not(true) === false → not claimable yet
      expect(evaluatePredicate({ not: { abs_before: future(3600) } }, NOW)).toBe(false);
    });

    it("returns false when the not child is null (not-evaluable)", () => {
      expect(evaluatePredicate({ not: null }, NOW)).toBe(false);
    });
  });

  describe("conjunction (and)", () => {
    it("is claimable only when every child is claimable", () => {
      expect(
        evaluatePredicate({ and: [{ unconditional: true }, { abs_before: future(3600) }] }, NOW),
      ).toBe(true);
    });

    it("is not claimable when any child fails", () => {
      expect(
        evaluatePredicate({ and: [{ unconditional: true }, { abs_before: past(3600) }] }, NOW),
      ).toBe(false);
    });

    it("an empty and[] is vacuously claimable (every on [])", () => {
      expect(evaluatePredicate({ and: [] }, NOW)).toBe(true);
    });

    it("returns false when 'and' is not an array", () => {
      expect(evaluatePredicate({ and: "nope" }, NOW)).toBe(false);
    });
  });

  describe("disjunction (or)", () => {
    it("is claimable when at least one child is claimable", () => {
      expect(
        evaluatePredicate({ or: [{ abs_before: past(3600) }, { abs_before: future(3600) }] }, NOW),
      ).toBe(true);
    });

    it("is not claimable when every child fails", () => {
      expect(
        evaluatePredicate({ or: [{ abs_before: past(3600) }, { rel_before: "1" }] }, NOW),
      ).toBe(false);
    });

    it("an empty or[] is vacuously not claimable (some on [])", () => {
      expect(evaluatePredicate({ or: [] }, NOW)).toBe(false);
    });

    it("returns false when 'or' is not an array", () => {
      expect(evaluatePredicate({ or: {} }, NOW)).toBe(false);
    });
  });

  describe("nested combinations", () => {
    it("models a typical claim window: and(not(before start), before end)", () => {
      // claimable between `start` (past) and `end` (future)
      const openNow = {
        and: [{ not: { abs_before: past(3600) } }, { abs_before: future(3600) }],
      };
      expect(evaluatePredicate(openNow, NOW)).toBe(true);

      // window entirely in the future: and(not(before future-start), before future-end)
      const notYetOpen = {
        and: [{ not: { abs_before: future(3600) } }, { abs_before: future(7200) }],
      };
      expect(evaluatePredicate(notYetOpen, NOW)).toBe(false);

      // window entirely in the past: and(not(before past-start), before past-end)
      const alreadyClosed = {
        and: [{ not: { abs_before: past(7200) } }, { abs_before: past(3600) }],
      };
      expect(evaluatePredicate(alreadyClosed, NOW)).toBe(false);
    });

    it("evaluates deeply nested or/and/not mixes", () => {
      const predicate = {
        or: [
          { and: [{ unconditional: true }, { not: { unconditional: true } }] }, // false
          { not: { abs_before: past(1) } }, // not(false) = true
        ],
      };
      expect(evaluatePredicate(predicate, NOW)).toBe(true);
    });
  });
});

describe("filterClaimableNow", () => {
  const USER = "GUSER0000000000000000000000000000000000000000000000000USER";
  const OTHER = "GOTHER000000000000000000000000000000000000000000000000OTHER";

  function cb(overrides: Partial<ClaimableBalanceEntry>): ClaimableBalanceEntry {
    return {
      id: "cb-id",
      asset: { kind: "native" },
      amount: "10",
      sponsor: "GSPONSOR",
      claimantsRaw: null,
      claimants: [USER],
      ...overrides,
    };
  }

  it("keeps a balance whose single-node predicate is claimable for the user", () => {
    const entries = [cb({ id: "a", claimantsRaw: { unconditional: true } })];
    const result = filterClaimableNow(entries, USER, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a");
  });

  it("drops a balance where the user is not a claimant", () => {
    const entries = [cb({ id: "a", claimants: [OTHER], claimantsRaw: { unconditional: true } })];
    expect(filterClaimableNow(entries, USER, NOW)).toHaveLength(0);
  });

  it("drops a balance whose predicate is not satisfied now", () => {
    const entries = [cb({ id: "a", claimantsRaw: { abs_before: past(3600) } })];
    expect(filterClaimableNow(entries, USER, NOW)).toHaveLength(0);
  });

  it("resolves an array-shaped predicate to the user's own claimant entry", () => {
    // Horizon shape where `predicate` is the full claimants array; each entry
    // carries its own predicate. The user's entry is claimable, the other is not.
    const predicate = [
      { destination: OTHER, predicate: { unconditional: true } },
      { destination: USER, predicate: { abs_before: future(3600) } },
    ];
    const entries = [cb({ id: "a", claimants: [USER, OTHER], claimantsRaw: predicate })];
    const result = filterClaimableNow(entries, USER, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a");
  });

  it("respects the user's own (non-claimable) entry in an array-shaped predicate", () => {
    const predicate = [
      { destination: OTHER, predicate: { unconditional: true } },
      { destination: USER, predicate: { abs_before: past(3600) } },
    ];
    const entries = [cb({ id: "a", claimants: [USER, OTHER], claimantsRaw: predicate })];
    expect(filterClaimableNow(entries, USER, NOW)).toHaveLength(0);
  });

  it("drops an array-shaped predicate that has no entry for the user", () => {
    const predicate = [{ destination: OTHER, predicate: { unconditional: true } }];
    // user still listed as claimant so the includes() gate passes, but no
    // matching predicate entry exists
    const entries = [cb({ id: "a", claimants: [USER], claimantsRaw: predicate })];
    expect(filterClaimableNow(entries, USER, NOW)).toHaveLength(0);
  });

  it("filters a mixed list, preserving only claimable-now balances", () => {
    const entries = [
      cb({ id: "unconditional", claimantsRaw: { unconditional: true } }),
      cb({ id: "open-window", claimantsRaw: { abs_before: future(3600) } }),
      cb({ id: "closed-window", claimantsRaw: { abs_before: past(3600) } }),
      cb({ id: "not-claimant", claimants: [OTHER], claimantsRaw: { unconditional: true } }),
      cb({ id: "relative", claimantsRaw: { rel_before: "10" } }),
    ];
    const ids = filterClaimableNow(entries, USER, NOW).map((e) => e.id);
    expect(ids).toEqual(["unconditional", "open-window"]);
  });

  it("returns an empty list for empty input", () => {
    expect(filterClaimableNow([], USER, NOW)).toEqual([]);
  });

  // a claim is signed and submitted some time after the audit, so it has to stay
  // claimable for the whole validity window of the transaction, not only at the
  // ledger close time the audit read
  describe("validity window", () => {
    const WINDOW = 300;

    it("skips a balance whose abs_before falls inside the window", () => {
      const entries = [cb({ id: "a", claimantsRaw: { abs_before: future(120) } })];
      expect(filterClaimableNow(entries, USER, NOW, WINDOW)).toHaveLength(0);
      // still claimable at the instant itself
      expect(filterClaimableNow(entries, USER, NOW)).toHaveLength(1);
    });

    it("keeps a balance whose abs_before is beyond the window", () => {
      const entries = [cb({ id: "a", claimantsRaw: { abs_before: future(WINDOW + 1) } })];
      expect(filterClaimableNow(entries, USER, NOW, WINDOW)).toHaveLength(1);
    });

    it("skips a balance that only opens inside the window", () => {
      const entries = [cb({ id: "a", claimantsRaw: { not: { abs_before: future(60) } } })];
      expect(filterClaimableNow(entries, USER, NOW, WINDOW)).toHaveLength(0);
    });

    it("keeps a balance that opened before the window and stays open", () => {
      const entries = [cb({ id: "a", claimantsRaw: { not: { abs_before: past(60) } } })];
      expect(filterClaimableNow(entries, USER, NOW, WINDOW)).toHaveLength(1);
    });

    it("rejects a negative or fractional window", () => {
      expect(() => filterClaimableNow([], USER, NOW, -1)).toThrow();
      expect(() => filterClaimableNow([], USER, NOW, 1.5)).toThrow();
    });
  });
});
