import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  __resetServerEnvForTests,
  getMediatorSecret,
  getServerEnv,
  getSoroswapConfig,
  requireServerEnv,
} from "@/server/server-env";

const SEED = Keypair.random().secret();

beforeEach(() => __resetServerEnvForTests());
afterEach(() => {
  vi.unstubAllEnvs();
  __resetServerEnvForTests();
});

describe("server env", () => {
  it("a malformed SOROSWAP_API_URL does not take the mediator secret down with it", () => {
    vi.stubEnv("MEDIATOR_SECRET", SEED);
    vi.stubEnv("SOROSWAP_API_URL", "api.soroswap.finance");
    expect(getMediatorSecret()).toBe(SEED);
    expect(getServerEnv().MEDIATOR_SECRET).toBe(SEED);
    expect(() => getSoroswapConfig()).toThrow(/SOROSWAP_API_URL/);
  });

  it("a malformed MEDIATOR_SECRET does not take Soroswap down with it", () => {
    vi.stubEnv("MEDIATOR_SECRET", "not-a-seed");
    vi.stubEnv("SOROSWAP_API_URL", "https://api.soroswap.finance");
    vi.stubEnv("SOROSWAP_API_KEY", "key");
    expect(getSoroswapConfig()).toEqual({ apiUrl: "https://api.soroswap.finance", apiKey: "key" });
    expect(getServerEnv().SOROSWAP_API_URL).toBe("https://api.soroswap.finance");
    expect(requireServerEnv("SOROSWAP_API_KEY")).toBe("key");
    expect(() => getMediatorSecret()).toThrow(/MEDIATOR_SECRET/);
  });

  it("never puts the secret value in its error message", () => {
    const bad = `${SEED}X`;
    vi.stubEnv("MEDIATOR_SECRET", bad);
    expect(() => getMediatorSecret()).toThrow();
    try {
      getMediatorSecret();
    } catch (e) {
      expect((e as Error).message).not.toContain(bad);
      expect((e as Error).message).not.toContain(SEED);
    }
  });

  it("treats empty values as unset and defaults the Soroswap URL", () => {
    vi.stubEnv("MEDIATOR_SECRET", "");
    vi.stubEnv("SOROSWAP_API_URL", "");
    vi.stubEnv("SOROSWAP_API_KEY", "");
    expect(getMediatorSecret()).toBeUndefined();
    expect(getSoroswapConfig()).toEqual({
      apiUrl: "https://api.soroswap.finance",
      apiKey: undefined,
    });
    expect(() => requireServerEnv("SOROSWAP_API_KEY")).toThrow(/SOROSWAP_API_KEY/);
  });
});
