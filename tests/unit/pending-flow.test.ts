// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

vi.mock("server-only", () => ({}));
process.env.MEDIATOR_SECRET = Keypair.random().secret();

import * as reissueRoute from "@/app/api/mediator/reissue/route";
import * as signRoute from "@/app/api/mediator/sign/route";
import { startMediatorFlow } from "@/lib/mediator/client";
import {
  clearPendingForward,
  inspectPendingForward,
  loadPendingForwards,
  PENDING_FORWARDS_CHANGED_EVENT,
  PendingForwardStorageError,
  removePendingForward,
  resumePendingForward,
  savePendingForward,
  type PendingMediatorForward,
} from "@/lib/mediator/pending-flow";
import { MEDIATOR_FLOW_TTL_MS } from "@/server/mediator-secret";

import { BASE_RESERVE, FakeHorizon, XLM } from "./mediator-horizon-fake";

const KEY = "account-demolisher:pending-mediator-forwards";
const LEGACY_KEY = "account-demolisher:pending-mediator-forward";

function record(over: Partial<PendingMediatorForward> = {}): PendingMediatorForward {
  return {
    publicKey: "GUSER",
    mediatorPublicKey: "GMED1",
    flowToken: "token-1",
    ultimateDestination: "GDEST",
    networkId: "testnet",
    savedAt: 100,
    ...over,
  };
}

describe("pending forward records", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("saves and loads the record for the same account", () => {
    savePendingForward(record());
    expect(loadPendingForwards("GUSER")).toEqual([record()]);
  });

  it("does not show one account's record to another", () => {
    savePendingForward(record());
    expect(loadPendingForwards("GOTHER")).toEqual([]);
  });

  it("keeps account A's record when account B starts a close", () => {
    savePendingForward(record());
    savePendingForward(record({ publicKey: "GBEE", mediatorPublicKey: "GMED2", savedAt: 200 }));
    expect(loadPendingForwards("GUSER")).toEqual([record()]);
    expect(loadPendingForwards("GBEE")).toHaveLength(1);
  });

  it("keeps two flows for the same account side by side", () => {
    savePendingForward(record());
    savePendingForward(record({ mediatorPublicKey: "GMED2", flowToken: "token-2", savedAt: 200 }));
    expect(loadPendingForwards("GUSER").map((r) => r.mediatorPublicKey)).toEqual([
      "GMED1",
      "GMED2",
    ]);
  });

  it("updates a flow in place when its token is renewed", () => {
    savePendingForward(record());
    savePendingForward(record({ flowToken: "renewed" }));
    expect(loadPendingForwards("GUSER")).toEqual([record({ flowToken: "renewed" })]);
  });

  it("removing one flow leaves the others", () => {
    savePendingForward(record());
    savePendingForward(record({ mediatorPublicKey: "GMED2", savedAt: 200 }));
    removePendingForward({ networkId: "testnet", publicKey: "GUSER", mediatorPublicKey: "GMED1" });
    expect(loadPendingForwards("GUSER").map((r) => r.mediatorPublicKey)).toEqual(["GMED2"]);
  });

  it("a clear without a named flow (a close with no forward) removes nothing", () => {
    savePendingForward(record());
    clearPendingForward();
    expect(loadPendingForwards("GUSER")).toHaveLength(1);
    clearPendingForward({ networkId: "testnet", publicKey: "GUSER", mediatorPublicKey: "GMED1" });
    expect(loadPendingForwards("GUSER")).toHaveLength(0);
  });

  // swap the whole storage object: happy-dom stores assigned properties as items
  function withStorage(fake: Partial<Storage>, run: () => void): void {
    const real = window.localStorage;
    Object.defineProperty(window, "localStorage", { value: fake, configurable: true });
    try {
      run();
    } finally {
      Object.defineProperty(window, "localStorage", { value: real, configurable: true });
    }
  }

  it("reports a storage failure instead of swallowing it", () => {
    withStorage(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
      () => expect(() => savePendingForward(record())).toThrow(PendingForwardStorageError),
    );
  });

  it("reports an unreadable storage instead of showing nothing", () => {
    withStorage(
      {
        getItem: () => {
          throw new Error("SecurityError");
        },
      },
      () => expect(() => loadPendingForwards("GUSER")).toThrow(PendingForwardStorageError),
    );
  });

  it("folds a record written by the old single-slot layout into the map", () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify(record({ mediatorPublicKey: "GOLD" })));
    savePendingForward(record());
    expect(
      loadPendingForwards("GUSER")
        .map((r) => r.mediatorPublicKey)
        .sort(),
    ).toEqual(["GMED1", "GOLD"]);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
  });

  it("ignores malformed stored data", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadPendingForwards("GUSER")).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify({ a: { foo: 1 } }));
    expect(loadPendingForwards("GUSER")).toEqual([]);
  });

  it("round-trips the deposit memo", () => {
    savePendingForward(record({ memo: { type: "id", value: "999" } }));
    expect(loadPendingForwards("GUSER")[0]?.memo).toEqual({ type: "id", value: "999" });
  });

  it("announces changes to listeners in this tab", () => {
    const seen = vi.fn();
    window.addEventListener(PENDING_FORWARDS_CHANGED_EVENT, seen);
    savePendingForward(record());
    removePendingForward(record());
    window.removeEventListener(PENDING_FORWARDS_CHANGED_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe("resume and inspect against chain state", () => {
  let fake: FakeHorizon;
  let user: string;
  let cex: string;
  let offset = 0;
  const deps = {
    sleep: async (ms: number) => {
      offset += ms;
    },
    now: () => Date.now() + offset,
  };

  async function pendingAfterMerge(merge = true): Promise<PendingMediatorForward> {
    const flow = await startMediatorFlow(cex, {
      network: "testnet",
      memo: { type: "text", value: "dep-1" },
    });
    if (!flow.ok) throw new Error(flow.reason);
    fake.createAccount(flow.mediatorPublicKey, 2n * XLM);
    if (merge) fake.mergeInto(user, flow.mediatorPublicKey);
    const pending: PendingMediatorForward = {
      publicKey: user,
      mediatorPublicKey: flow.mediatorPublicKey,
      flowToken: flow.flowToken,
      ultimateDestination: cex,
      memo: { type: "text", value: "dep-1" },
      networkId: "testnet",
      savedAt: Date.now(),
    };
    savePendingForward(pending);
    return pending;
  }

  beforeEach(() => {
    window.localStorage.clear();
    fake = new FakeHorizon({
      sign: { GET: signRoute.GET, POST: signRoute.POST },
      reissue: reissueRoute.POST,
    });
    vi.stubGlobal("fetch", vi.fn(fake.fetch));
    signRoute.__resetRateLimiterForTests();
    reissueRoute.__resetRateLimiterForTests();
    offset = 0;
    user = Keypair.random().publicKey();
    cex = Keypair.random().publicKey();
    fake.createAccount(user, 50n * XLM);
    fake.createAccount(cex, 1n * XLM);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resumes a forward long after the token expired and clears the record", async () => {
    const pending = await pendingAfterMerge();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MEDIATOR_FLOW_TTL_MS * 4 * 24);
    const result = await resumePendingForward(pending, deps);
    expect(result.ok).toBe(true);
    expect(fake.requests).toContain("POST /api/mediator/reissue");
    expect(fake.lastForward!.amount).toBe(52n * XLM - 2n * BASE_RESERVE - 200n);
    expect(loadPendingForwards(user)).toEqual([]);
  });

  it("reports a merged-away mediator as delivered and clears the record", async () => {
    const pending = await pendingAfterMerge();
    expect(await inspectPendingForward(pending)).toEqual({ kind: "awaiting-forward" });
    // the in-session forward lands from another tab
    const other = await resumePendingForward({ ...pending }, deps);
    expect(other.ok).toBe(true);
    savePendingForward(pending);
    const status = await inspectPendingForward(pending);
    expect(status).toMatchObject({ kind: "delivered" });
    const again = await resumePendingForward(pending, deps);
    expect(again).toMatchObject({ ok: true, alreadyDelivered: true });
    expect(loadPendingForwards(user)).toEqual([]);
  });

  it("recognises a close that stopped before the merge", async () => {
    const pending = await pendingAfterMerge(false);
    expect(await inspectPendingForward(pending)).toEqual({
      kind: "not-merged",
      mediatorBalance: "2.0000000",
    });
  });
});
