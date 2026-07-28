// Neutralize characters that can visually reorder, hide, or spoof rendered text.
//
// On-chain strings the app displays back to the user — Soroban token symbols and
// names (SEP-41 `symbol()` / `name()`), account home domains, memos, and asset
// codes — are ATTACKER-CONTROLLED. React escapes HTML, but it does NOT strip
// Unicode bidirectional overrides / isolates / zero-width characters, so a
// crafted token name can visually reverse or hide the text around it (e.g.
// spoofing a destination or an amount). Every such value is run through
// `safeDisplay` at the render boundary.
//
// Code-point ranges removed (kept as data, not embedded literals, so the source
// itself carries none of these characters):
//   0x0000–0x001F, 0x007F–0x009F  C0 / C1 control characters
//   0x061C                        Arabic letter mark
//   0x200B–0x200F                 zero-width space/joiner + LRM/RLM marks
//   0x202A–0x202E                 bidi embeddings / overrides (LRE/RLE/PDF/LRO/RLO)
//   0x2066–0x2069                 bidi isolates (LRI/RLI/FSI/PDI)
//   0xFEFF                        zero-width no-break space / BOM
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isUnsafeCodePoint(cp: number): boolean {
  for (const [lo, hi] of UNSAFE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// Strip reordering/hiding characters from an attacker-controlled display string.
// Iterates by code point (so astral characters survive intact) and drops only
// the ranges above.
export function safeDisplay(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || !isUnsafeCodePoint(cp)) out += ch;
  }
  return out;
}
