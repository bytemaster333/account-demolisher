import { describe, it, expect } from "vitest";

import { manualCloseRequiredNotice, SUPPORTED_DEFI_PROTOCOLS } from "@/lib/safety/manual-close";

describe("manualCloseRequiredNotice", () => {
  it("returns null when the account holds no unrecognized tokens", () => {
    expect(manualCloseRequiredNotice({ heldTokenCount: 0, unreadableTokenCount: 0 })).toBeNull();
  });

  it("produces a 'manual close required' notice naming the supported protocols", () => {
    const notice = manualCloseRequiredNotice({ heldTokenCount: 2, unreadableTokenCount: 1 });
    expect(notice).not.toBeNull();
    // matches the actionable regex used to surface such notices verbatim
    expect(notice!).toMatch(/manual close/i);
    // counts held + unreadable together (3 tokens)
    expect(notice!).toContain("3 tokens");
    for (const p of SUPPORTED_DEFI_PROTOCOLS) expect(notice!).toContain(p);
  });

  it("uses singular grammar for exactly one token", () => {
    const notice = manualCloseRequiredNotice({ heldTokenCount: 1, unreadableTokenCount: 0 });
    expect(notice!).toContain("1 token from");
    expect(notice!).not.toContain("1 tokens");
  });

  it("fires on unreadable tokens alone (a hostile/broken contract is still a signal)", () => {
    expect(
      manualCloseRequiredNotice({ heldTokenCount: 0, unreadableTokenCount: 2 }),
    ).toMatch(/manual close/i);
  });
});
