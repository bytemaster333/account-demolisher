import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { __resetServerEnvForTests, getMediatorSecret } from "@/server/server-env";

const SEED = Keypair.random().secret();

beforeEach(() => __resetServerEnvForTests());
afterEach(() => {
  vi.unstubAllEnvs();
  __resetServerEnvForTests();
});

describe("server env", () => {
  it("returns a well-formed mediator secret", () => {
    vi.stubEnv("MEDIATOR_SECRET", SEED);
    expect(getMediatorSecret()).toBe(SEED);
  });

  it("throws on a malformed mediator secret", () => {
    vi.stubEnv("MEDIATOR_SECRET", "not-a-seed");
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

  it("treats an empty value as unset", () => {
    vi.stubEnv("MEDIATOR_SECRET", "");
    expect(getMediatorSecret()).toBeUndefined();
  });
});
