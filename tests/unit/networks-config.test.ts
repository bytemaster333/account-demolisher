import { describe, expect, it } from "vitest";

import {
  MAINNET,
  NETWORKS,
  TESTNET,
  parseNetworkId,
  requireNetwork,
  resolveNetwork,
} from "@/lib/config/networks";

describe("network id parsing", () => {
  it("maps the known ids", () => {
    expect(parseNetworkId("mainnet")).toBe(MAINNET);
    expect(requireNetwork("testnet")).toBe(TESTNET);
  });

  it("returns null for an unknown or missing id instead of guessing testnet", () => {
    expect(parseNetworkId("pubnet")).toBeNull();
    expect(parseNetworkId(undefined)).toBeNull();
    expect(parseNetworkId("")).toBeNull();
    expect(parseNetworkId("Mainnet")).toBeNull();
  });

  it("requireNetwork throws for an unknown id", () => {
    expect(() => requireNetwork("corrupted")).toThrow(/unknown Stellar network id "corrupted"/);
  });
});

describe("supported networks", () => {
  it("offers only mainnet and testnet", () => {
    expect(Object.keys(NETWORKS).sort()).toEqual(["mainnet", "testnet"]);
    expect(parseNetworkId("futurenet")).toBeNull();
    expect(() => requireNetwork("futurenet")).toThrow(/unknown Stellar network id "futurenet"/);
  });
});

// kept only for the test helpers that still call it; it must not guess either
describe("resolveNetwork", () => {
  it("maps the known ids and refuses anything else", () => {
    expect(resolveNetwork("mainnet")).toBe(MAINNET);
    expect(resolveNetwork("testnet")).toBe(TESTNET);
    expect(() => resolveNetwork("futurenet")).toThrow(/unknown Stellar network id "futurenet"/);
    expect(() => resolveNetwork(undefined)).toThrow(/unknown Stellar network id/);
  });
});
