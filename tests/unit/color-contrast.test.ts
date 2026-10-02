import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// small text in the app uses these foreground tokens on these surfaces; each
// pair has to reach WCAG AA (4.5:1) in both themes
const FOREGROUNDS = ["--fg", "--fg-2", "--fg-3", "--danger", "--warning", "--success", "--accent"];
const SURFACES = ["--bg", "--bg-2", "--surface", "--surface-2"];

const css = readFileSync(
  fileURLToPath(new URL("../../src/app/globals.css", import.meta.url)),
  "utf8",
);

function block(selectorStart: string): Record<string, string> {
  const at = css.indexOf(selectorStart);
  if (at === -1) throw new Error(`no ${selectorStart} block in globals.css`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!;
  return out;
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const themes = {
  dark: block(":root,"),
  light: block('[data-theme="light"]'),
};

describe("theme token contrast", () => {
  for (const [name, tokens] of Object.entries(themes)) {
    for (const fg of FOREGROUNDS) {
      for (const bg of SURFACES) {
        it(`${name}: ${fg} on ${bg} is at least 4.5:1`, () => {
          const ratio = contrast(tokens[fg]!, tokens[bg]!);
          expect(ratio, `${fg} ${tokens[fg]} on ${bg} ${tokens[bg]}`).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it("has no unused --pending tokens", () => {
    expect(css).not.toMatch(/--pending/);
  });
});
