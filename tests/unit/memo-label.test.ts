import { describe, expect, it } from "vitest";

import {
  closeMemoForConfirmation,
  describeCloseMemo,
  memoParts,
} from "@/components/multisig/memo-label";
import type { CloseMemo } from "@/lib/multisig/signing-request";

// U+202E right-to-left override and U+200B zero-width space
const HIDDEN = "12‮34​5";

describe("memoParts", () => {
  it("splits a memo into its label, its display value and the hidden characters note", () => {
    expect(memoParts({ type: "text", value: HIDDEN })).toEqual({
      label: "Memo (TEXT):",
      value: "12345",
      note: " (contains hidden characters)",
    });
    expect(memoParts({ type: "id", value: "777" })).toEqual({
      label: "Memo (ID):",
      value: "777",
      note: "",
    });
  });

  it("takes a signing request's close memo once it is known not to be none", () => {
    const memo: CloseMemo = { type: "hash", value: "ab".repeat(32) };
    if (memo.type === "none") throw new Error("unreachable");
    expect(memoParts({ type: memo.type, value: memo.value }).label).toBe("Memo (HASH):");
  });
});

describe("describeCloseMemo", () => {
  it("reads the same parts the confirmation dialog shows", () => {
    for (const memo of [
      { type: "text", value: HIDDEN },
      { type: "id", value: "42" },
      { type: "return", value: "cd".repeat(32) },
    ] as const) {
      const { label, value, note } = memoParts(memo);
      expect(describeCloseMemo(memo)).toBe(`${label} ${value}${note}`);
    }
  });

  it("says when there is no memo", () => {
    expect(describeCloseMemo({ type: "none", value: "" })).toBe("No memo");
    expect(closeMemoForConfirmation({ type: "none", value: "" })).toBeNull();
  });
});
