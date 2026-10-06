// strips characters that can visually reorder, hide or spoof rendered text.
//
// token symbols and names read from a sep-41 contract (symbol() / name()) are
// attacker-controlled. react escapes html but not unicode bidi overrides,
// isolates or invisible characters, so a crafted symbol can reverse or hide the
// text around it (for example to spoof an amount or a destination).
//
// call sites: AllowanceList (components/allowance-viewer) renders sep-41
// symbol() text through safeDisplay, and it is the only rendering call site.
// the scam heuristics use safeDisplay for their messages and
// hasHiddenCharacters to flag a held token's name, which takes effect only
// where a page runs runHeldTokenScamHeuristics over the held tokens. other
// on-chain strings are not routed through here.
//
// removed (matched by unicode property, so the source itself carries none of the
// characters):
//   Cc                            C0 / C1 control characters
//   Cf                            format characters: bidi marks, embeddings,
//                                 overrides and isolates, zero-width space and
//                                 joiners, soft hyphen, word joiner and the
//                                 invisible operators, BOM, interlinear
//                                 annotation, tag characters
//   Zl, Zp                        line and paragraph separators
//   Default_Ignorable_Code_Point  everything that renders as nothing, including
//                                 variation selectors, the combining grapheme
//                                 joiner and the Hangul fillers
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

// the u flag matches by code point, so astral characters survive intact
export function safeDisplay(value: string): string {
  return value.replace(HIDDEN, "");
}

// true when safeDisplay would change the value
export function hasHiddenCharacters(value: string): boolean {
  return value.replace(HIDDEN, "") !== value;
}

// true for anything outside printable ASCII. a token symbol that needs a
// "non-ASCII" badge: homoglyphs such as a Cyrillic "С" render like Latin letters.
export function hasNonAscii(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}
