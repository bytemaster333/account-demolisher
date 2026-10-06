import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// public/stellar.toml is what wallets and validators read for the home domain
// (SEP-1). every field it declares must be true and usable: no SEP-10 endpoint
// without a signing key, no empty placeholders, and a logo in the format SEP-1
// asks for.

const ROOT = process.cwd();
const toml = readFileSync(path.join(ROOT, "public/stellar.toml"), "utf8");

// top-level and table keys with their raw values (single-line values only; the
// multi-line ORG_DESCRIPTION string is skipped)
const assignments = [...toml.matchAll(/^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/gm)].map((m) => ({
  key: m[1]!,
  value: m[2]!,
}));
const keys = new Set(assignments.map((a) => a.key));

describe("public/stellar.toml", () => {
  it("declares no SEP-10 WEB_AUTH_ENDPOINT without a SIGNING_KEY", () => {
    if (keys.has("WEB_AUTH_ENDPOINT")) expect(keys.has("SIGNING_KEY")).toBe(true);
    expect(keys.has("WEB_AUTH_ENDPOINT")).toBe(false);
  });

  it("has no empty-string values", () => {
    const empty = assignments.filter((a) => a.value === '""').map((a) => a.key);
    expect(empty).toEqual([]);
  });

  it("does not claim a licensing authority", () => {
    expect(keys.has("ORG_LICENSING_AUTHORITY")).toBe(false);
  });

  it("names only the DeFi protocols the app still supports", () => {
    // fxdao shut down on chain and was removed from the product (2026-10-06)
    expect(toml).not.toMatch(/fxdao/i);
    for (const name of ["Blend", "Aquarius", "Soroswap"]) expect(toml).toContain(name);
  });

  it("contains no em dash", () => {
    // built from the code point so this file stays free of the character too
    expect(toml).not.toContain(String.fromCharCode(0x2014));
  });

  it("points ORG_LOGO at a png that ships in public/", () => {
    const logo = assignments.find((a) => a.key === "ORG_LOGO")?.value;
    expect(logo).toMatch(/^"https:\/\/demolisher\.app\/[\w-]+\.png"$/);
    const file = new URL(JSON.parse(logo!) as string).pathname;
    const png = readFileSync(path.join(ROOT, "public", file));
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("does not tell operators to add the rewrite next.config.ts already ships", () => {
    expect(toml).not.toMatch(/operators should add/i);
    const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(config).toContain('source: "/.well-known/stellar.toml", destination: "/stellar.toml"');
    expect(existsSync(path.join(ROOT, "public/stellar.toml"))).toBe(true);
  });
});
