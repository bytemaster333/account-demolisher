// @vitest-environment happy-dom

import { describe, it, expect, beforeEach } from "vitest";

import {
  savePendingForward,
  loadPendingForward,
  clearPendingForward,
  type PendingMediatorForward,
} from "@/lib/mediator/pending-flow";

const USER = "GUSER";
const forward: PendingMediatorForward = {
  publicKey: USER,
  mediatorPublicKey: "GMED",
  flowToken: "nonce.exp.GDEST.mac",
  ultimateDestination: "GDEST",
  networkId: "testnet",
  savedAt: 123,
};

const KEY = "account-demolisher:pending-mediator-forward";

describe("pending mediator forward persistence (SEC-01 part B)", () => {
  beforeEach(() => window.localStorage.clear());

  it("saves and loads for the same account", () => {
    savePendingForward(forward);
    expect(loadPendingForward(USER)).toEqual(forward);
  });

  it("does NOT surface a pending forward for a different account", () => {
    savePendingForward(forward);
    expect(loadPendingForward("GOTHER")).toBeNull();
  });

  it("clears the record", () => {
    savePendingForward(forward);
    clearPendingForward();
    expect(loadPendingForward(USER)).toBeNull();
  });

  it("returns null for malformed / incomplete stored data", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadPendingForward(USER)).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify({ foo: 1 }));
    expect(loadPendingForward(USER)).toBeNull();
  });

  it("round-trips the optional deposit memo", () => {
    const withMemo: PendingMediatorForward = {
      ...forward,
      memo: { type: "id", value: "999" },
    };
    savePendingForward(withMemo);
    expect(loadPendingForward(USER)?.memo).toEqual({ type: "id", value: "999" });
  });
});
