import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";

// next.config.ts is what `next build` and `next dev` evaluate first, so a bad
// public setting that only the build can inline must stop them there (L-29)

const KEYS = [
  "NEXT_PUBLIC_SLIPPAGE_BPS",
  "NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS",
  "NEXT_PUBLIC_LUMEUS_TESTNET_KEY",
  "NEXT_PUBLIC_LUMEUS_MAINNET_KEY",
] as const;
const orig = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function loadConfig(): Promise<NextConfig> {
  vi.resetModules();
  return (await import("../../next.config")).default;
}

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (orig[k] === undefined) delete process.env[k];
    else process.env[k] = orig[k];
  }
});

describe("next.config slippage validation (L-29)", () => {
  it("refuses an out-of-range slippage", async () => {
    process.env.NEXT_PUBLIC_SLIPPAGE_BPS = "1000";
    await expect(loadConfig()).rejects.toThrow(
      /NEXT_PUBLIC_SLIPPAGE_BPS must be an integer from 10 to 500/,
    );
  });

  it("refuses a malformed slippage", async () => {
    process.env.NEXT_PUBLIC_SLIPPAGE_BPS = "abc";
    await expect(loadConfig()).rejects.toThrow(/NEXT_PUBLIC_SLIPPAGE_BPS/);
  });

  it("refuses a malformed market floor", async () => {
    process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS = "-5";
    await expect(loadConfig()).rejects.toThrow(/NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS/);
  });

  it("loads with the values unset, blank or in range", async () => {
    await expect(loadConfig()).resolves.toBeTypeOf("object");
    process.env.NEXT_PUBLIC_SLIPPAGE_BPS = " ";
    process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS = "";
    await expect(loadConfig()).resolves.toBeTypeOf("object");
    process.env.NEXT_PUBLIC_SLIPPAGE_BPS = "50";
    process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS = "100";
    await expect(loadConfig()).resolves.toBeTypeOf("object");
  });
});

describe("next.config request body bound (M-51)", () => {
  it("caps the body the proxy may buffer at 32 KB", async () => {
    const config = await loadConfig();
    expect(config.experimental?.proxyClientMaxBodySize).toBe("32kb");
  });
});

describe("next.config lumeus key validation", () => {
  it.each(["NEXT_PUBLIC_LUMEUS_TESTNET_KEY", "NEXT_PUBLIC_LUMEUS_MAINNET_KEY"] as const)(
    "refuses a full-access key in %s without printing it",
    async (name) => {
      process.env[name] = "lum_live_secretvalue";
      const err = await loadConfig().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(new RegExp(`${name} must be a Lumeus publishable key`));
      expect(err?.message).not.toContain("secretvalue");
    },
  );

  it("builds with a publishable key or none", async () => {
    process.env.NEXT_PUBLIC_LUMEUS_TESTNET_KEY = "lum_pub_abc123";
    process.env.NEXT_PUBLIC_LUMEUS_MAINNET_KEY = "";
    await expect(loadConfig()).resolves.toBeDefined();
  });
});
