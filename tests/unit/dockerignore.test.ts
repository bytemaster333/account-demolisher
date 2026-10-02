import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// the docker build context must never carry live secrets or internal files.
// .dockerignore is evaluated here with docker's own rules, ported from
// github.com/moby/patternmatcher (ignorefile.ReadAll + MatchesOrParentMatches,
// which is what buildkit applies to each path): patterns are cleaned, a leading
// "/" dropped, "!" re-includes, the last matching pattern wins, and a pattern
// that matches a parent directory matches everything under it.

interface Pattern {
  readonly exclusion: boolean;
  readonly dirs: number;
  readonly test: (p: string) => boolean;
}

function cleanPath(p: string): string {
  const cleaned = path.posix.normalize(p).replace(/\/+$/, "");
  return cleaned === "" ? "." : cleaned;
}

// mirrors Pattern.compile: one detected type that later characters can override
function compile(pattern: string): (p: string) => boolean {
  let re = "^";
  let type: "exact" | "prefix" | "suffix" | "regexp" = "exact";
  let i = 0;
  while (i < pattern.length) {
    const start = i;
    const ch = pattern[i++]!;
    if (ch === "*") {
      if (pattern[i] === "*") {
        i++;
        if (pattern[i] === "/") i++;
        if (i >= pattern.length) {
          if (type === "exact") type = "prefix";
          else {
            re += ".*";
            type = "regexp";
          }
        } else {
          re += "(.*/)?";
          type = "regexp";
        }
        if (start === 0) type = "suffix";
      } else {
        re += "[^/]*";
        type = "regexp";
      }
    } else if (ch === "?") {
      re += "[^/]";
      type = "regexp";
    } else if (".+()|{}$".includes(ch)) {
      re += `\\${ch}`;
    } else if (ch === "\\") {
      if (i < pattern.length) {
        re += `\\${pattern[i++]}`;
        type = "regexp";
      } else {
        re += "\\\\";
      }
    } else if (ch === "[" || ch === "]") {
      re += ch;
      type = "regexp";
    } else {
      re += ch;
    }
  }
  switch (type) {
    case "exact":
      return (p) => p === pattern;
    case "prefix":
      return (p) => p.startsWith(pattern.slice(0, -2));
    case "suffix": {
      const tail = pattern.slice(2);
      return (p) => p.endsWith(tail) || (tail.startsWith("/") && p === tail.slice(1));
    }
    case "regexp": {
      const compiled = new RegExp(`${re}$`);
      return (p) => compiled.test(p);
    }
  }
}

function readPatterns(file: string): Pattern[] {
  const out: Pattern[] = [];
  for (const raw of readFileSync(file, "utf8").replace(/^﻿/, "").split("\n")) {
    if (raw.startsWith("#")) continue;
    let p = raw.trim();
    if (p === "") continue;
    const exclusion = p.startsWith("!");
    if (exclusion) p = p.slice(1).trim();
    p = cleanPath(p);
    if (p.length > 1 && p.startsWith("/")) p = p.slice(1);
    out.push({ exclusion, dirs: p.split("/").length, test: compile(p) });
  }
  return out;
}

function isExcluded(patterns: readonly Pattern[], file: string): boolean {
  const target = cleanPath(file);
  const parent = path.posix.dirname(target);
  const parentDirs = parent === "." ? [] : parent.split("/");
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.exclusion !== matched) continue;
    let match = pattern.test(target);
    if (!match) {
      for (let i = 0; i < parentDirs.length && !match; i++) {
        match = pattern.test(parentDirs.slice(0, i + 1).join("/"));
      }
    }
    if (match) matched = !pattern.exclusion;
  }
  return matched;
}

const patterns = readPatterns(path.join(process.cwd(), ".dockerignore"));

describe(".dockerignore keeps secrets and internal files out of the build context", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.prod",
    ".env.production",
    ".env.local.bak.soroswap-key",
    "src/.env.local",
    "data/closes.jsonl",
    "data/counters.json",
    "resources/audit.md",
    "resources/stride-threat-model.pdf",
    ".claude/settings.local.json",
    ".git/config",
    "SECURITY.md",
    "m3_tranche_formatted.txt",
    "m2-tranche.txt",
    "tests/unit/secret-key.test.ts",
    "docs/content/docs/index.mdx",
    "node_modules/next/package.json",
    ".next/BUILD_ID",
  ])("excludes %s", (file) => {
    expect(isExcluded(patterns, file)).toBe(true);
  });

  it.each([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
    "src/app/page.tsx",
    "src/lib/wallet/connector.ts",
    "public/stellar.toml",
  ])("keeps the build input %s", (file) => {
    expect(isExcluded(patterns, file)).toBe(false);
  });
});

describe("the docker matcher port", () => {
  // spot checks against documented docker behaviour so the port itself is trusted
  const m = (lines: string[], file: string) => {
    const ps = lines.map((l) => {
      const exclusion = l.startsWith("!");
      const p = cleanPath(exclusion ? l.slice(1) : l);
      return { exclusion, dirs: p.split("/").length, test: compile(p) };
    });
    return isExcluded(ps, file);
  };

  it("single star does not cross directories, but a parent match excludes the subtree", () => {
    expect(m(["*.md"], "docs/a.md")).toBe(false);
    expect(m(["*.md"], "a.md")).toBe(true);
    expect(m(["docs"], "docs/a/b.md")).toBe(true);
  });

  it("double star matches at any depth and exceptions re-include", () => {
    expect(m(["**/*.go"], "a/b/c.go")).toBe(true);
    expect(m(["*", "!src"], "src/x/y.ts")).toBe(false);
    expect(m(["*", "!src", "**/.env*"], "src/.env")).toBe(true);
  });
});
