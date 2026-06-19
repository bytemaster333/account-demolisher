import { describe, it, expect, beforeEach } from "vitest";
import { getActiveConnector, setActiveConnector } from "@/lib/wallet/active-connector";
import type { Connector } from "@/lib/wallet/connector";

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
