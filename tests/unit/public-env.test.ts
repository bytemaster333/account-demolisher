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

// a docker build arg or compose ${VAR:-} that is not set arrives as "" (not
// undefined). it must mean "use the default", never fail the build or bake an
// empty origin into the bundle.
describe("public env: empty build args fall back to the defaults", () => {
  const KEYS = [
    "NEXT_PUBLIC_STELLAR_NETWORK",
    "NEXT_PUBLIC_DEPLOYMENT_MODE",
    "NEXT_PUBLIC_SITE_URL",
  ] as const;
  const orig = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  });

  it("treats an empty network and deployment mode as unset", async () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "";
    process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = " ";
    const { getPublicEnv } = await import("@/lib/config/env");
    expect(getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK).toBe("testnet");
    expect(getPublicEnv().NEXT_PUBLIC_DEPLOYMENT_MODE).toBe("reference");
  });

  it("rejects futurenet, which is no longer a supported target", async () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "futurenet";
    const { getPublicEnv } = await import("@/lib/config/env");
    expect(() => getPublicEnv()).toThrow(/Invalid public environment/);
  });

  it("treats an empty site url as unset", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "";
    const { SITE_URL } = await import("@/lib/config/site");
    expect(SITE_URL).toBe("https://demolisher.app");
  });

  it("keeps a configured site url without its trailing slash", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = " https://close.example.com/ ";
    const { SITE_URL } = await import("@/lib/config/site");
    expect(SITE_URL).toBe("https://close.example.com");
  });
});
