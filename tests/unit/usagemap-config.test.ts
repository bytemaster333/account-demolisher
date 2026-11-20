import { afterEach, describe, expect, it, vi } from "vitest";

// src/lib/config/usagemap.ts reads NEXT_PUBLIC_USAGEMAP_SITE at import time, as next
// inlines it at build time; each case re-imports the module with its own env
async function load(site: string | undefined) {
  vi.resetModules();
  if (site === undefined) vi.stubEnv("NEXT_PUBLIC_USAGEMAP_SITE", undefined as unknown as string);
  else vi.stubEnv("NEXT_PUBLIC_USAGEMAP_SITE", site);
  return import("@/lib/config/usagemap");
}

describe("UsageMap analytics config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off when the build arg is unset or blank", async () => {
    expect((await load(undefined)).USAGEMAP_SITE).toBeNull();
    expect((await load("")).USAGEMAP_SITE).toBeNull();
    expect((await load("   ")).USAGEMAP_SITE).toBeNull();
  });

  it("uses the trimmed site key when set", async () => {
    expect((await load(" site_abc123 ")).USAGEMAP_SITE).toBe("site_abc123");
  });

  it("pins one immutable tracker file with an sha384 integrity hash", async () => {
    const m = await load(undefined);
    expect(m.USAGEMAP_TRACKER_SRC).toBe(
      `https://e1.usagemap.dev/lib/${m.USAGEMAP_TRACKER_VERSION}/standard.js`,
    );
    expect(m.USAGEMAP_TRACKER_SRC).not.toContain("latest");
    expect(m.USAGEMAP_TRACKER_INTEGRITY).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  });
});
