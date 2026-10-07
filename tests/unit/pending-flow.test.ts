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
  isLegacyFlowToken,
  latestPendingForward,
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

  function unreadableCopies(): string[] {
    const out: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(`${KEY}:unreadable:`)) out.push(window.localStorage.getItem(k)!);
    }
    return out;
  }

  it("keeps a copy of stored data it can't parse and says so before the next save replaces it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    window.localStorage.setItem(KEY, "{not json");
    expect(loadPendingForwards("GUSER")).toEqual([]);
    savePendingForward(record());
    expect(loadPendingForwards("GUSER")).toEqual([record()]);
    expect(unreadableCopies()).toEqual(["{not json"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`${KEY}:unreadable:`);
  });

  it("keeps a copy of entries that are not recovery records instead of dropping them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stored = JSON.stringify({ a: { foo: 1 }, b: record() });
    window.localStorage.setItem(KEY, stored);
    expect(loadPendingForwards("GUSER")).toEqual([record()]);
    expect(unreadableCopies()).toEqual([stored]);
    expect(warn).toHaveBeenCalledTimes(1);
    // the readable record stays where it was, and the next read is quiet
    expect(loadPendingForwards("GUSER")).toEqual([record()]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps a copy of an unreadable record from the old single-slot layout", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    window.localStorage.setItem(LEGACY_KEY, "{broken");
    expect(loadPendingForwards("GUSER")).toEqual([]);
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(unreadableCopies()).toEqual(["{broken"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("round-trips the deposit memo", () => {
    savePendingForward(record({ memo: { type: "id", value: "999" } }));
    expect(loadPendingForwards("GUSER")[0]?.memo).toEqual({ type: "id", value: "999" });
  });

  it("drops a record bound to a network it does not serve, and says why", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const map = {
      a: record({ networkId: "futurenet", mediatorPublicKey: "GFUT" }),
      b: record({ networkId: "bogus", mediatorPublicKey: "GBOG" }),
      c: record(),
    };
    window.localStorage.setItem(KEY, JSON.stringify(map));
    expect(loadPendingForwards("GUSER")).toEqual([record()]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain("futurenet");
    // gone from storage too, so it is not resumed on another network later
    expect(Object.keys(JSON.parse(window.localStorage.getItem(KEY)!) as object)).toEqual([
      "testnet:GUSER:GMED1",
    ]);
  });

  it("finds the newest record of an account on one network", () => {
    savePendingForward(record({ mediatorPublicKey: "GOLD", savedAt: 100 }));
    savePendingForward(record({ mediatorPublicKey: "GNEW", savedAt: 300 }));
    savePendingForward(record({ mediatorPublicKey: "GMAIN", savedAt: 500, networkId: "mainnet" }));
    expect(latestPendingForward("GUSER", "testnet")?.mediatorPublicKey).toBe("GNEW");
    expect(latestPendingForward("GUSER", "mainnet")?.mediatorPublicKey).toBe("GMAIN");
    expect(latestPendingForward("GOTHER", "testnet")).toBeNull();
  });

  it("tells a token from an earlier build apart from a current one", () => {
    expect(isLegacyFlowToken(`${"a".repeat(32)}.1700000000000.GDEST.${"b".repeat(64)}`)).toBe(true);
    expect(
      isLegacyFlowToken(`v2.${"a".repeat(32)}.1.testnet.GDEST.AAAAAA==.${"b".repeat(64)}`),
    ).toBe(false);
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
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
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
    vi.unstubAllEnvs();
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

  it("keeps the renewed token when the forward still fails after a renewal", async () => {
    const pending = await pendingAfterMerge();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MEDIATOR_FLOW_TTL_MS * 2);
    fake.submitScript.push({ kind: "reject", codes: { transaction: "tx_bad_auth" } });
    const result = await resumePendingForward(pending, deps);
    expect(result.ok).toBe(false);
    expect(result.flowToken).not.toBe(pending.flowToken);
    expect(loadPendingForwards(user)).toEqual([{ ...pending, flowToken: result.flowToken }]);
  });

  it("does not send a token from an earlier build to the routes", async () => {
    const pending = await pendingAfterMerge();
    const legacy = {
      ...pending,
      flowToken: `${"c".repeat(32)}.1700000000000.${cex}.${"d".repeat(64)}`,
    };
    savePendingForward(legacy);
    fake.requests.length = 0;
    const result = await resumePendingForward(legacy, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("earlier version");
    expect(fake.requests).toEqual([]);
    expect(loadPendingForwards(user)).toHaveLength(1);
  });

  it("recognises a close that stopped before the merge", async () => {
    const pending = await pendingAfterMerge(false);
    expect(await inspectPendingForward(pending)).toEqual({
      kind: "not-merged",
      mediatorBalance: "2.0000000",
    });
  });
});
