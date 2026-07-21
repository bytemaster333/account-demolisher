import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  disconnectSession,
  getActiveConnector,
  setActiveConnector,
} from "@/lib/wallet/active-connector";
import type { Connector } from "@/lib/wallet/connector";

// disconnectSession dynamically imports the wallet-kit; mock it so the test
// stays free of the browser-only kit (and its Freighter dependency).
const disconnectKit = vi.fn(async () => {});
vi.mock("@/lib/wallet/kit", () => ({ disconnectKit: () => disconnectKit() }));

// The active connector holds live signing capability (e.g. a pasted-seed
// SecretKeyConnector) that must never touch the persisted store. /allowances
// reads it to sign a revoke after a client-side navigation from /demolish, so
// set/get/clear must behave like a simple session-scoped singleton.

function fakeConnector(kind: "kit" | "secret"): Connector {
  return {
    kind,
    connect: async () => ({ publicKey: "G".padEnd(56, "A") }),
    disconnect: async () => {},
    getPublicKey: async () => "G".padEnd(56, "A"),
    signTransaction: async () => ({ signedXdr: "", signerPublicKey: "" }),
    signAuthEntry: async () => ({ signedXdr: "", signerAddress: "" }),
  };
}

describe("active-connector registry", () => {
  beforeEach(() => {
    setActiveConnector(null);
  });

  it("starts empty", () => {
    expect(getActiveConnector()).toBeNull();
  });

  it("returns the exact connector that was set", () => {
    const c = fakeConnector("secret");
    setActiveConnector(c);
    expect(getActiveConnector()).toBe(c);
  });

  it("replaces the previous connector on a new set", () => {
    const first = fakeConnector("secret");
    const second = fakeConnector("kit");
    setActiveConnector(first);
    setActiveConnector(second);
    expect(getActiveConnector()).toBe(second);
  });

  it("clears back to null (disconnect)", () => {
    setActiveConnector(fakeConnector("kit"));
    setActiveConnector(null);
    expect(getActiveConnector()).toBeNull();
  });
});

describe("disconnectSession", () => {
  beforeEach(() => {
    setActiveConnector(null);
    disconnectKit.mockClear();
  });

  it("clears the connector, runs its disconnect, forgets the kit, and clears the store", async () => {
    const disconnect = vi.fn(async () => {});
    const clearStore = vi.fn();
    setActiveConnector({ ...fakeConnector("kit"), disconnect });

    await disconnectSession(clearStore);

    expect(getActiveConnector()).toBeNull(); // connector dropped
    expect(disconnect).toHaveBeenCalledTimes(1); // wallet teardown ran
    expect(disconnectKit).toHaveBeenCalledTimes(1); // kit selection forgotten
    expect(clearStore).toHaveBeenCalledTimes(1); // display store cleared
  });

  it("still clears the store and forgets the kit when there is no active connector", async () => {
    const clearStore = vi.fn();
    await disconnectSession(clearStore);
    expect(clearStore).toHaveBeenCalledTimes(1);
    expect(disconnectKit).toHaveBeenCalledTimes(1);
    expect(getActiveConnector()).toBeNull();
  });

  it("still completes teardown when the connector's disconnect throws", async () => {
    const clearStore = vi.fn();
    const disconnect = vi.fn(async () => {
      throw new Error("wallet already gone");
    });
    setActiveConnector({ ...fakeConnector("kit"), disconnect });

    await expect(disconnectSession(clearStore)).resolves.toBeUndefined();
    expect(getActiveConnector()).toBeNull();
    expect(clearStore).toHaveBeenCalledTimes(1);
    expect(disconnectKit).toHaveBeenCalledTimes(1);
  });
});
