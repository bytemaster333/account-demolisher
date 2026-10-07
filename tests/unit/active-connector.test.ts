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

  it("clears the connector and the store, and lets a kit connector close the kit once", async () => {
    const disconnect = vi.fn(async () => {});
    const clearStore = vi.fn();
    setActiveConnector({ ...fakeConnector("kit"), disconnect });

    await disconnectSession(clearStore);

    expect(getActiveConnector()).toBeNull(); // connector dropped
    // a kit connector's disconnect is the kit teardown, so it is not run twice
    // (a second close of a failing walletconnect session would report it twice)
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnectKit).not.toHaveBeenCalled();
    expect(clearStore).toHaveBeenCalledTimes(1); // display store cleared
  });

  it("forgets the kit after a pasted-key connector disconnects", async () => {
    const disconnect = vi.fn(async () => {});
    const clearStore = vi.fn();
    setActiveConnector({ ...fakeConnector("secret"), disconnect });

    await disconnectSession(clearStore);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnectKit).toHaveBeenCalledTimes(1);
    expect(clearStore).toHaveBeenCalledTimes(1);
  });

  it("still clears the store and forgets the kit when there is no active connector", async () => {
    const clearStore = vi.fn();
    await disconnectSession(clearStore);
    expect(clearStore).toHaveBeenCalledTimes(1);
    expect(disconnectKit).toHaveBeenCalledTimes(1);
    expect(getActiveConnector()).toBeNull();
  });

  it("clears the app first and reports a wallet that refuses to disconnect", async () => {
    const clearStore = vi.fn();
    const gone = new Error("wallet already gone");
    const disconnect = vi.fn(async () => {
      expect(clearStore).toHaveBeenCalledTimes(1);
      throw gone;
    });
    const onTeardownError = vi.fn();
    setActiveConnector({ ...fakeConnector("kit"), disconnect });

    await expect(disconnectSession(clearStore, onTeardownError)).resolves.toBeUndefined();
    expect(getActiveConnector()).toBeNull();
    expect(clearStore).toHaveBeenCalledTimes(1);
    expect(onTeardownError).toHaveBeenCalledExactlyOnceWith(gone);
  });

  it("reports a kit teardown failure after a pasted-key disconnect", async () => {
    const relay = new Error("Failed to publish payload, please try again.");
    disconnectKit.mockRejectedValueOnce(relay);
    const onTeardownError = vi.fn();
    setActiveConnector(fakeConnector("secret"));

    await disconnectSession(vi.fn(), onTeardownError);
    expect(onTeardownError).toHaveBeenCalledExactlyOnceWith(relay);
  });

  it("reports both failures together", async () => {
    const seed = new Error("seed wipe failed");
    const relay = new Error("relay down");
    disconnectKit.mockRejectedValueOnce(relay);
    const onTeardownError = vi.fn();
    setActiveConnector({
      ...fakeConnector("secret"),
      disconnect: async () => {
        throw seed;
      },
    });

    await disconnectSession(vi.fn(), onTeardownError);
    expect(onTeardownError).toHaveBeenCalledOnce();
    const reported = onTeardownError.mock.calls[0]![0] as AggregateError;
    expect(reported).toBeInstanceOf(AggregateError);
    expect(reported.errors).toEqual([seed, relay]);
  });

  it("logs the failure when the caller passes no reporter", async () => {
    const relay = new Error("relay down");
    disconnectKit.mockRejectedValueOnce(relay);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(disconnectSession(vi.fn())).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledOnce();
      expect(logged.mock.calls[0]).toContain(relay);
    } finally {
      logged.mockRestore();
    }
  });
});
