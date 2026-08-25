import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// regression: an empty NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (what a GitHub
// Actions secret that is not set injects) must parse as "WalletConnect disabled",
// not throw. A .min(1) in the schema used to reject "" at build/prerender time
// and fail the whole build. WalletConnect is optional, so empty == unset.
describe("public env: WalletConnect project id is optional", () => {
  const KEY = "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID";
  const orig = process.env[KEY];

  beforeEach(() => {
    vi.resetModules(); // getPublicEnv memoizes; a fresh module clears the cache
  });
  afterEach(() => {
    if (orig === undefined) delete process.env[KEY];
    else process.env[KEY] = orig;
  });

  async function loadWcProjectId() {
    const { getPublicEnv } = await import("@/lib/config/env");
    return getPublicEnv().NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  }

  it("treats an empty string (unset CI secret) as disabled, not an error", async () => {
    process.env[KEY] = "";
    await expect(loadWcProjectId()).resolves.toBeUndefined();
  });

  it("treats a whitespace-only value as disabled", async () => {
    process.env[KEY] = "   ";
    await expect(loadWcProjectId()).resolves.toBeUndefined();
  });

  it("treats an absent variable as disabled", async () => {
    delete process.env[KEY];
    await expect(loadWcProjectId()).resolves.toBeUndefined();
  });

  it("keeps a real project id (trimmed)", async () => {
    process.env[KEY] = "  5e8254e53e856a4b90f676c51efea4d4  ";
    await expect(loadWcProjectId()).resolves.toBe("5e8254e53e856a4b90f676c51efea4d4");
  });
});
