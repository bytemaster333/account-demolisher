// Neutralize characters that can visually reorder, hide, or spoof rendered text.
//
// Token symbols and names read from a SEP-41 contract (`symbol()` / `name()`) are
// attacker-controlled. React escapes HTML, but it does not strip Unicode bidi
// overrides, isolates or invisible characters, so a crafted symbol can reverse or
// hide the text around it (e.g. spoofing an amount or a destination).
//
// Call sites: the allowance list (components/allowance-viewer/AllowanceList.tsx)
// renders token symbols through safeDisplay, and the scam heuristics flag a held
// token whose symbol or name contains any of these characters.
//
// Removed (matched by Unicode property, so the source itself carries none of the
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

// Strip reordering/hiding characters from an attacker-controlled display string.
// The u flag matches by code point, so astral characters survive intact.
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
